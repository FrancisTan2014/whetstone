import { expect, test } from "../fixtures";
import type { APIRequestContext } from "@playwright/test";

// Adopt the seeded Markdown work as a recitation routine in the given phase and return its plan id. v0
// resolves a single DEFAULT_USER_ID, so a plan adopted over the API is owned by the same user the browser
// acts as — the UI then drives the real passage-practice flow.
async function adoptPlan(
  baseURL: string,
  request: APIRequestContext,
  workEntryId: string,
  phase: "familiarizing" | "learning"
): Promise<string> {
  const response = await request.post(`${baseURL}api/recitation/plans`, {
    data: { phase, workEntryId }
  });
  expect(response.status()).toBe(201);
  const plan = (await response.json()) as { entryId: string };
  return plan.entryId;
}

test.describe("recitation passage practice (#578)", () => {
  test("start reciting, divide into passages, and complete one scheduled review", async ({
    page,
    setup
  }) => {
    const planId = await adoptPlan(setup.baseURL, page.request, setup.epub.entryId, "familiarizing");

    // From Today, the explicit "Start reciting" transition moves the routine into active recitation.
    await page.goto(`${setup.baseURL}#/`);
    const recitationCard = page.getByRole("region", { name: "Continue recitation" });
    await recitationCard.getByRole("button", { name: "Start reciting" }).click();
    await expect(recitationCard.getByRole("button", { name: "Start reciting" })).toHaveCount(0);

    // On the segmentation page, divide the Work into passages (boundaries only — the source is untouched).
    await page.goto(`${setup.baseURL}#/recite?plan=${encodeURIComponent(planId)}`);
    await page.getByRole("button", { name: "Divide into passages" }).click();
    const firstPassage = page.getByRole("listitem").first();
    await expect(firstPassage).toBeVisible();
    await expect(firstPassage.getByText(/Passage 1 ·/)).toBeVisible();

    // Back on Today, the next due passage surfaces as one bounded attempt: a cue with the target hidden
    // until Reveal.
    await page.goto(`${setup.baseURL}#/`);
    const reciteCard = page.getByRole("region", { name: "Recite" });
    const reveal = reciteCard.getByRole("button", { name: "Reveal" });
    await expect(reveal).toBeVisible();
    await expect(reciteCard.getByRole("button", { name: "Clean and natural" })).toHaveCount(0);

    // Reveal shows the exact source and the four self-ratings; grading records the review and the card
    // advances to the next due passage (bounded — one at a time, never an overdue wall).
    await reveal.click();
    await reciteCard.getByRole("button", { name: "Clean and natural" }).click();
    await expect(reciteCard.getByRole("button", { name: "Clean and natural" })).toHaveCount(0);
  });
});
