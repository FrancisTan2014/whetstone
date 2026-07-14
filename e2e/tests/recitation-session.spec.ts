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
  test("runs chain, optional introduction, due passage, and completion without leaving the hub", async ({
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

    await expect(session.getByRole("button", { exact: true, name: "New passage" })).toBeVisible();
    await session.getByRole("button", { exact: true, name: "New passage" }).click();

    await expect(session.getByRole("button", { name: "Reveal" })).toBeVisible();
    await session.getByRole("button", { name: "Reveal" }).click();
    await session.getByRole("button", { name: "Complete, with effort" }).click();

    await expect(session.getByText("Due recitation clear")).toBeVisible();
    await session.getByRole("button", { name: "Exit session" }).click();
    await expect(hub.getByRole("group", { name: "Caught up" })).toBeVisible();
  });
});
