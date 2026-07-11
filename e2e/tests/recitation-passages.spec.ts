import { expect, test } from "../fixtures";
import type { APIRequestContext } from "@playwright/test";

// Adopt the given seeded work as a recitation routine in the given phase and return its plan id. v0
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

test.describe("recitation passage practice (#578, faded by #579)", () => {
  test("start reciting, divide into passages, fade support, and complete one scheduled review", async ({
    page,
    setup
  }) => {
    await adoptPlan(setup.baseURL, page.request, setup.epub.entryId, "familiarizing");

    // From Today, the explicit "Start reciting" transition moves the routine into active recitation.
    await page.goto(`${setup.baseURL}#/`);
    const recitationCard = page.getByRole("region", { name: "Continue recitation" });
    await recitationCard.getByRole("button", { name: "Start reciting" }).click();
    await expect(recitationCard.getByRole("button", { name: "Start reciting" })).toHaveCount(0);

    // Reach the segmentation surface through its real Library entry point — the adopted Work's card
    // links "Divide into passages" into #/recite?plan=<id> — not a hand-built URL.
    await page.goto(`${setup.baseURL}#/library`);
    await page.getByRole("link", { name: "Divide into passages" }).click();

    // On the segmentation page, divide the Work into passages (boundaries only — the source is untouched).
    await page.getByRole("button", { name: "Divide into passages" }).click();
    const firstPassage = page.getByRole("listitem").first();
    await expect(firstPassage).toBeVisible();
    await expect(firstPassage.getByText(/Passage 1 ·/)).toBeVisible();

    // Back on Today, the next due passage surfaces as one bounded attempt. It opens at full visual
    // support (the whole passage as a scaffold); the learner fades support down the ladder before
    // reciting from memory.
    await page.goto(`${setup.baseURL}#/`);
    const reciteCard = page.getByRole("region", { name: "Recite" });
    const supportGroup = reciteCard.getByRole("group", { name: "Support level" });
    await expect(supportGroup.getByRole("button", { name: "Full text" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );

    // Fading down to "First characters" persists the remembered preference through the support-level
    // endpoint; wait for that write so the reload below reads the saved level.
    await Promise.all([
      page.waitForResponse(
        (response) => response.url().includes("/support-level") && response.ok()
      ),
      supportGroup.getByRole("button", { name: "First characters" }).click()
    ]);

    // Reloading Today re-fetches the passage; the chosen support level is remembered per passage.
    await page.goto(`${setup.baseURL}#/`);
    const reloadedCard = page.getByRole("region", { name: "Recite" });
    await expect(
      reloadedCard.getByRole("group", { name: "Support level" }).getByRole("button", {
        name: "First characters"
      })
    ).toHaveAttribute("aria-pressed", "true");

    const reveal = reloadedCard.getByRole("button", { name: "Reveal" });
    await expect(reveal).toBeVisible();
    await expect(reloadedCard.getByRole("button", { name: "Clean and natural" })).toHaveCount(0);

    // Reveal shows the exact source and the four self-ratings; grading records the review and the card
    // advances to the next due passage (bounded — one at a time, never an overdue wall).
    await reveal.click();
    await reloadedCard.getByRole("button", { name: "Clean and natural" }).click();
    await expect(reloadedCard.getByRole("button", { name: "Clean and natural" })).toHaveCount(0);
  });
});
