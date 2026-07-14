import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "../fixtures";
import type { APIRequestContext } from "@playwright/test";

// Passage seeding reads the ProseMirror `doc_blocks` that only EPUB ingestion writes, so the hub flow
// needs an EPUB-backed Work. EPUB upload dedupes by content sha256, so this spec uploads its OWN
// dedicated fixture (`three-character-classic.epub`) rather than the shared `setup.epub` (owned by the
// passages spec) or `recitation-chain.epub` (owned by the chaining spec) — otherwise the second adopt of
// the same Work would collide (one plan per user+Work).
const hubEpubFixture = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "epub",
  "three-character-classic.epub"
);

// v0 resolves a single DEFAULT_USER_ID, so a plan adopted/seeded over the API is owned by the same user
// the browser acts as. We drive the routine into a Learning state with one due passage over the API, then
// exercise the real hub UI (#608): read the projection, pause it (its due work and action disappear), and
// resume it (the same schedule returns — nothing was deleted).
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

// Upload the dedicated hub fixture as its own Work (distinct sha256) and return its id + title.
async function uploadHubWork(
  request: APIRequestContext,
  baseURL: string
): Promise<{ entryId: string; title: string }> {
  const response = await request.post(`${baseURL}api/works/epub`, {
    data: readFileSync(hubEpubFixture),
    headers: { "content-type": "application/epub+zip" }
  });
  expect([200, 201], `EPUB upload → ${response.status()}: ${await response.text()}`).toContain(
    response.status()
  );
  const { work } = (await response.json()) as { work: { entryId: string; title: string } };
  return work;
}

test.describe("recitation routine hub (#608)", () => {
  test("adopt a Work, open the hub, then pause and resume with progress preserved", async ({
    page,
    setup
  }) => {
    const work = await uploadHubWork(page.request, setup.baseURL);
    const plan = (await post(page.request, setup.baseURL, "/recitation/plans", {
      phase: "learning",
      workEntryId: work.entryId
    })) as { entryId: string };
    const planEntryId = plan.entryId;

    // Lay out the passages, then explicitly introduce the first — this seeds one due passage card, so the
    // hub has a real obligation to project (#607).
    await post(page.request, setup.baseURL, `/recitation/plans/${planEntryId}/passages/seed`);
    await post(page.request, setup.baseURL, `/recitation/plans/${planEntryId}/introduce-next`);

    // The hub projects the active plan: its title, the routine stage, and the single due-first action.
    await page.goto(`${setup.baseURL}#/recitation`);
    const hub = page.getByRole("region", { name: "Recitation" });
    await expect(hub.getByRole("heading", { name: work.title })).toBeVisible();
    await expect(hub.getByText("Stage: Learning passages")).toBeVisible();

    const dueReview = hub.getByRole("group", { name: "Due review" });
    await expect(dueReview.getByText("1 due")).toBeVisible();
    await expect(dueReview.getByRole("link", { name: "Start review" })).toHaveAttribute(
      "href",
      `#/recite?plan=${planEntryId}`
    );

    // Pausing removes the plan's due work and action WITHOUT deleting anything — the calm paused banner
    // replaces the obligation.
    await Promise.all([
      page.waitForResponse(
        (response) => response.url().includes(`/plans/${planEntryId}/pause`) && response.ok()
      ),
      hub.getByRole("button", { name: "Pause routine" }).click()
    ]);
    await expect(hub.getByText(/this routine is paused/i)).toBeVisible();
    await expect(hub.getByRole("group", { name: "Due review" })).toHaveCount(0);
    await expect(hub.getByRole("link", { name: "Start review" })).toHaveCount(0);

    // A paused plan also drops out of the cross-plan Today action (the same predicate the due scans use).
    await page.goto(`${setup.baseURL}#/`);
    await expect(
      page.getByRole("region", { name: "Recite" }).getByRole("button", { name: "Reveal" })
    ).toHaveCount(0);

    // Resuming restores the exact same due passage and action — the schedule, support, and progress were
    // preserved through the pause.
    await page.goto(`${setup.baseURL}#/recitation`);
    await Promise.all([
      page.waitForResponse(
        (response) => response.url().includes(`/plans/${planEntryId}/resume`) && response.ok()
      ),
      hub.getByRole("button", { name: "Resume routine" }).click()
    ]);
    await expect(hub.getByText(/this routine is paused/i)).toHaveCount(0);
    await expect(hub.getByRole("group", { name: "Due review" }).getByText("1 due")).toBeVisible();
    await expect(hub.getByRole("link", { name: "Start review" })).toHaveAttribute(
      "href",
      `#/recite?plan=${planEntryId}`
    );
  });
});
