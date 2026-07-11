import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "../fixtures";
import type { APIRequestContext } from "@playwright/test";

// Passage seeding reads the ProseMirror `doc_blocks` that only EPUB ingestion writes, so the chaining
// flow needs an EPUB-backed Work. Upload a dedicated tiny EPUB (a heading + three short paragraphs) so
// this test owns its own Work with a distinct sha256 (EPUB upload dedupes by content hash, so it must
// not reuse the shared `setup.epub` bytes). Returns its id.
const epubFixture = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "epub",
  "recitation-chain.epub"
);

async function uploadChainingWork(baseURL: string, request: APIRequestContext): Promise<string> {
  const response = await request.post(`${baseURL}api/works/epub`, {
    data: readFileSync(epubFixture),
    headers: { "content-type": "application/epub+zip" }
  });
  expect([200, 201]).toContain(response.status());
  const { work } = (await response.json()) as { work: { entryId: string } };
  return work.entryId;
}

// Adopt the Work as a recitation routine already in the learning phase (passage practice is the
// Learning-phase engine) and return its plan id. v0 resolves a single DEFAULT_USER_ID, so a plan
// adopted over the API is owned by the same user the browser acts as.
async function adoptPlan(
  baseURL: string,
  request: APIRequestContext,
  workEntryId: string
): Promise<string> {
  const response = await request.post(`${baseURL}api/recitation/plans`, {
    data: { phase: "learning", workEntryId }
  });
  expect(response.status()).toBe(201);
  const plan = (await response.json()) as { entryId: string };
  return plan.entryId;
}

// Seed the plan's passages from its source blocks and return them in reciting order.
async function seedPassages(
  baseURL: string,
  request: APIRequestContext,
  planEntryId: string
): Promise<ReadonlyArray<{ entryId: string }>> {
  const response = await request.post(
    `${baseURL}api/recitation/plans/${planEntryId}/passages/seed`
  );
  expect([200, 201]).toContain(response.status());
  const body = (await response.json()) as { passages: ReadonlyArray<{ entryId: string }> };
  return body.passages;
}

// Own a passage the deterministic way (#580): two successful (Good) reviews land it at ~1.0
// retrievability, clearing both the ">= 2 successful" and the retention-target bars at once.
async function ownPassage(
  baseURL: string,
  request: APIRequestContext,
  passageEntryId: string
): Promise<void> {
  for (let index = 0; index < 2; index += 1) {
    const response = await request.post(
      `${baseURL}api/recitation/passages/${passageEntryId}/review`,
      { data: { cueStrength: "opening", rating: "good" } }
    );
    expect(response.status()).toBe(200);
  }
}

test.describe("recitation chaining and whole-work maintenance (#580)", () => {
  test("owns adjacent passages, recites them as a chain, then maintains the whole work", async ({
    page,
    setup
  }) => {
    const workEntryId = await uploadChainingWork(setup.baseURL, page.request);
    const planEntryId = await adoptPlan(setup.baseURL, page.request, workEntryId);
    const passages = await seedPassages(setup.baseURL, page.request, planEntryId);
    expect(passages.length).toBeGreaterThanOrEqual(2);

    // Own every passage, in order, so the owned prefix spans the whole Work — enough for both a chain
    // and whole-work maintenance.
    for (const passage of passages) {
      await ownPassage(setup.baseURL, page.request, passage.entryId);
    }

    // The Recite page hosts the maintenance panel below the passage list.
    await page.goto(`${setup.baseURL}#/recite?plan=${planEntryId}`);
    await expect(
      page.getByText(
        `Owned from the start: ${passages.length} of ${passages.length} passages in a row.`
      )
    ).toBeVisible();

    // Start a contiguous chain through the whole owned prefix, then confirm the rendered chain.
    await page.getByRole("button", { name: "Start chain" }).click();
    const chainList = page.getByRole("list", { name: "Chain passages" });
    await expect(chainList.getByRole("listitem")).toHaveCount(passages.length);

    // Recall held throughout: completing the chain returns to the start offer without failing a passage.
    await page.getByRole("button", { name: "Recall held throughout" }).click();
    await expect(page.getByRole("button", { name: "Start chain" })).toBeVisible();

    // With every passage owned, whole-work maintenance is offered on its own aggregate schedule; a first
    // Good review creates and schedules that separate card.
    await expect(page.getByRole("heading", { name: "Whole-work maintenance" })).toBeVisible();
    await Promise.all([
      page.waitForResponse(
        (response) => response.url().includes("/whole-work/review") && response.ok()
      ),
      page.getByRole("button", { name: "Complete, with effort" }).click()
    ]);
    await expect(
      page.getByText("The whole work is scheduled; it is not due yet.")
    ).toBeVisible();
  });
});
