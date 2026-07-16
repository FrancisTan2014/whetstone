import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "../fixtures";
import type { APIRequestContext } from "@playwright/test";

const sessionEpubFixture = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "epub",
  "recitation-session.epub"
);

async function uploadSessionWork(
  request: APIRequestContext,
  baseURL: string
): Promise<{ entryId: string; title: string }> {
  const response = await request.post(`${baseURL}api/works/epub`, {
    data: readFileSync(sessionEpubFixture),
    headers: { "content-type": "application/epub+zip" }
  });
  expect([200, 201], `EPUB upload → ${response.status()}: ${await response.text()}`).toContain(
    response.status()
  );
  const { work } = (await response.json()) as { work: { entryId: string; title: string } };
  return work;
}

async function post(
  request: APIRequestContext,
  baseURL: string,
  path: string,
  data?: unknown
): Promise<unknown> {
  const response = await request.post(`${baseURL}api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `POST ${path} → ${response.status()}: ${await response.text()}`).toBe(true);
  return response.json();
}

async function ownPassage(
  request: APIRequestContext,
  baseURL: string,
  passageEntryId: string
): Promise<void> {
  for (let index = 0; index < 2; index += 1) {
    await post(request, baseURL, `/recitation/passages/${passageEntryId}/review`, {
      cueStrength: "opening",
      rating: "good"
    });
  }
}

test.describe("complete inline recitation session (#609)", () => {
  test("runs a chain to the session's clear state without leaving the hub", async ({
    page,
    setup
  }) => {
    const work = await uploadSessionWork(page.request, setup.baseURL);
    const plan = (await post(page.request, setup.baseURL, "/recitation/plans", {
      phase: "learning",
      workEntryId: work.entryId
    })) as { entryId: string };
    const planEntryId = plan.entryId;

    const seeded = (await post(
      page.request,
      setup.baseURL,
      `/recitation/plans/${planEntryId}/passages/seed`
    )) as { passages: ReadonlyArray<{ entryId: string }> };
    expect(seeded.passages.length).toBeGreaterThanOrEqual(3);

    await post(page.request, setup.baseURL, `/recitation/plans/${planEntryId}/introduce-next`);
    await ownPassage(page.request, setup.baseURL, seeded.passages[0]!.entryId);
    await post(page.request, setup.baseURL, `/recitation/plans/${planEntryId}/introduce-next`);
    await ownPassage(page.request, setup.baseURL, seeded.passages[1]!.entryId);
    await post(page.request, setup.baseURL, `/recitation/plans/${planEntryId}/chain`, {
      endOrderIndex: 1
    });

    await page.goto(`${setup.baseURL}#/recitation`);
    const hub = page.getByRole("region", { name: "Recitation" });
    await expect(hub.getByRole("heading", { name: work.title })).toBeVisible();
    await expect(hub.getByText("Next: Continue chain")).toBeVisible();
    await hub.getByRole("button", { name: "Start session" }).click();

    const session = hub.getByRole("region", { name: "Recitation session" });
    await expect(
      session.getByRole("list", { name: "Chain passages" }).getByRole("listitem")
    ).toHaveCount(2);
    await session.getByRole("button", { name: "Recall held throughout" }).click();

    // Completing the chain ends the chain step for this session pass. Under the true cross-Work aggregate
    // (#633), the still-owned adjacent prefix keeps this Work chain-eligible — a required step — so the
    // optional "new passage" invitation stays suppressed (#633 AC5) and the session lands on the clear
    // state for this pass rather than offering new material. (Durably retiring a completed chain so the
    // Work can advance past chain maintenance is the deferred #635.)
    await expect(session.getByText("Due recitation clear")).toBeVisible();
    await expect(session.getByRole("button", { exact: true, name: "New passage" })).toHaveCount(0);
    await session.getByRole("button", { name: "Exit session" }).click();

    // Pause this plan so it leaves the shared single-user recitation routine, now a TRUE aggregate over
    // every active plan (#633). Its owned adjacent prefix keeps a chain-maintenance step permanently
    // available — a required step — so leaving it active would carry required work into the later specs'
    // aggregate and mask their optional/clear states.
    await page.request.post(`${setup.baseURL}api/recitation/plans/${planEntryId}/pause`);
  });
});
