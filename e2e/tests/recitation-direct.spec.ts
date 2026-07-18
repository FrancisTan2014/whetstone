import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "../fixtures";
import type { APIRequestContext } from "@playwright/test";

// The direct Work-level Recitation maintenance path (#643): the learner declares a known Work retrievable
// with "I can recite this", the exact Work enrols into FSRS maintenance (one Work-level target, one shared
// review card, requested retention 0.95, due immediately), and its first whole-Work review opens — recite
// from memory, reveal the canonical source, rate. There is NO passage setup, phase choice, chaining, or
// introduction step. This spec uploads its OWN dedicated fixture (`three-character-classic.epub`, distinct
// bytes/sha256) so EPUB upload never dedupes onto another spec's Work and collides on the shared
// DEFAULT_USER_ID.
const directEpubFixture = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "epub",
  "three-character-classic.epub"
);

async function uploadWork(
  request: APIRequestContext,
  baseURL: string
): Promise<{ entryId: string; title: string }> {
  const response = await request.post(`${baseURL}api/works/epub`, {
    data: readFileSync(directEpubFixture),
    headers: { "content-type": "application/epub+zip" }
  });
  expect([200, 201], `EPUB upload → ${response.status()}: ${await response.text()}`).toContain(
    response.status()
  );
  const { work } = (await response.json()) as { work: { entryId: string; title: string } };
  return work;
}

test.describe("direct Work-level Recitation maintenance (#643)", () => {
  test("enrols a known Work from the Library and completes its first whole-Work review from Today", async ({
    page,
    setup
  }) => {
    const { baseURL } = setup;

    // A known Work the learner can already recite (no passage setup, no phase picker anywhere).
    const work = await uploadWork(page.request, baseURL);

    // From the Library the un-enrolled Work offers the explicit declaration "I can recite this".
    await page.goto(`${baseURL}#/library`);
    const card = page.getByRole("listitem").filter({ hasText: work.title });
    await expect(card.getByRole("button", { name: "I can recite this" })).toBeVisible();
    // The rigid-flow surface is gone: no phase choice, no passage segmentation on the card.
    await expect(card.getByText(/Familiarizing|Divide into passages|Starting phase/)).toHaveCount(
      0
    );

    // Declaring it enrols the exact Work into maintenance and opens its first whole-Work review.
    await card.getByRole("button", { name: "I can recite this" }).click();
    await expect(page).toHaveURL(
      new RegExp(`#/recitation\\?work=${encodeURIComponent(work.entryId)}`)
    );
    await expect(page.getByText("from memory", { exact: false }).first()).toBeVisible();

    // Enrolment persisted BEFORE any rating: leaving without rating keeps the Work due and writes no
    // review event, so Today still shows the Recitation obligation.
    await page.goto(`${baseURL}#/`);
    await expect(page.getByRole("heading", { name: "Due now" })).toBeVisible();
    await expect(page.getByText("Recitation", { exact: true })).toBeVisible();

    // Enter the due review from Today (no ?work — the earliest-due Work opens), recite, reveal the
    // canonical source read live from the Work's blocks, then rate.
    await page.getByRole("link", { name: "Review", exact: true }).click();
    await expect(page).toHaveURL(/#\/recitation$/);
    await page.getByRole("button", { name: "Reveal source" }).click();
    await expect(page.getByLabel("Source")).toBeVisible();
    await page.getByRole("button", { name: "Complete, with effort" }).click();

    // The rating reschedules only this Work's card through the shared FSRS boundary and confirms the next
    // scheduled review — the whole-Work card, not any passage. With no other Work due, the session closes
    // with "Due complete." rather than an optional "Review next" (#637).
    await expect(page.getByRole("status")).toContainText(`Scheduled ${work.title}`);
    await expect(page.getByText("Due complete.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Review next" })).toHaveCount(0);
    await page.getByRole("link", { name: "Back to Today" }).click();

    // On a freshly recomputed board the rescheduled Work is no longer due, so the Recitation row is gone
    // and Today is truthfully clear.
    await expect(page.getByText("Done for today.")).toBeVisible();
    await expect(page.getByText("Recitation", { exact: true })).toHaveCount(0);

    // Re-enrolling is idempotent — the Library now shows the single durable plan as "Reciting" with a
    // "Review" link (never a duplicate "I can recite this"), preserving the Work's identity.
    await page.goto(`${baseURL}#/library`);
    const enrolled = page.getByRole("listitem").filter({ hasText: work.title });
    await expect(enrolled.getByText("Reciting", { exact: true })).toBeVisible();
    await expect(enrolled.getByRole("button", { name: "I can recite this" })).toHaveCount(0);

    // The Work-level maintenance card persists for its next scheduled review: opening the Work's review
    // reopens the same whole-Work review, keeping the exact Work's identity end to end.
    await enrolled.getByRole("link", { name: "Review", exact: true }).click();
    await expect(page.getByText("from memory", { exact: false }).first()).toBeVisible();
  });
});
