import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "../fixtures";
import type { APIRequestContext } from "@playwright/test";

// Post-rating continuation for direct Recitation maintenance (#637): due Recitation is a plain review
// session, not a rigid chain. After rating one whole-Work review, the page recomputes — from the canonical
// due cards, with no persisted session queue — how many OTHER Works still hold a due card and offers an
// OPTIONAL "Review next" while any remain, or "Due complete" when none do. The next Work never opens
// automatically; the learner chooses, and may leave at any point with due work simply resurfacing on Today.
// Two distinct-byte fixtures give two distinct due Works on the shared DEFAULT_USER_ID.
const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "epub");
const workAFixture = join(fixturesDir, "recitation-aggregate-a.epub");
const workBFixture = join(fixturesDir, "recitation-aggregate-b.epub");

async function uploadWork(
  request: APIRequestContext,
  baseURL: string,
  fixture: string
): Promise<{ entryId: string; title: string }> {
  const response = await request.post(`${baseURL}api/works/epub`, {
    data: readFileSync(fixture),
    headers: { "content-type": "application/epub+zip" }
  });
  expect([200, 201], `EPUB upload → ${response.status()}: ${await response.text()}`).toContain(
    response.status()
  );
  const { work } = (await response.json()) as { work: { entryId: string; title: string } };
  return work;
}

test.describe("direct Recitation maintenance continuation (#637)", () => {
  test("rates one of two due Works, offers Review next, leaves, then finishes to Due complete", async ({
    page,
    setup
  }) => {
    const { baseURL } = setup;

    const workA = await uploadWork(page.request, baseURL, workAFixture);
    const workB = await uploadWork(page.request, baseURL, workBFixture);

    // Enrol both Works from the Library. The read-first card holds "I can recite this" in its overflow
    // menu (#640); declaring it enrols the exact Work and opens its review; leaving before rating keeps
    // its card due, so both remain outstanding.
    for (const work of [workA, workB]) {
      await page.goto(`${baseURL}#/library`);
      const card = page.getByRole("listitem").filter({ hasText: work.title });
      await card.getByRole("button", { name: `More actions for ${work.title}` }).click();
      await page
        .getByRole("menu", { name: `More actions for ${work.title}` })
        .getByRole("menuitem", { name: "I can recite this" })
        .click();
      await expect(page.getByText("from memory", { exact: false }).first()).toBeVisible();
    }

    // Both due Works surface as a single Recitation obligation on Today.
    await page.goto(`${baseURL}#/`);
    await expect(page.getByText("Recitation", { exact: true })).toBeVisible();

    // Enter the earliest-due review (no ?work), recite, reveal, and rate the first Work.
    await page.getByRole("link", { name: "Review", exact: true }).click();
    await expect(page).toHaveURL(/#\/recitation$/);
    await page.getByRole("button", { name: "Reveal source" }).click();
    await page.getByRole("button", { name: "Complete, with effort" }).click();

    // Another Work is still due, so continuation is offered — OPTIONAL, never auto-advancing — and the
    // session is not yet complete.
    await expect(page.getByRole("button", { name: "Review next" })).toBeVisible();
    await expect(page.getByText("Due complete.")).toHaveCount(0);

    // The learner may leave mid-session: the remaining due Work simply resurfaces on Today.
    await page.getByRole("link", { name: "Back to Today" }).click();
    await expect(page.getByText("Recitation", { exact: true })).toBeVisible();

    // Returning to the review opens the remaining due Work; rating it clears the last due card.
    await page.getByRole("link", { name: "Review", exact: true }).click();
    await expect(page).toHaveURL(/#\/recitation$/);
    await page.getByRole("button", { name: "Reveal source" }).click();
    await page.getByRole("button", { name: "Complete, with effort" }).click();

    // With no Work left due, the session closes with "Due complete." and no "Review next".
    await expect(page.getByText("Due complete.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Review next" })).toHaveCount(0);

    // Today is now truthfully clear of Recitation.
    await page.getByRole("link", { name: "Back to Today" }).click();
    await expect(page.getByText("Recitation", { exact: true })).toHaveCount(0);
  });
});
