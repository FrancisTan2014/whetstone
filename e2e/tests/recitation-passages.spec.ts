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
  test("divide into passages, fade support, and complete one scheduled review", async ({
    page,
    setup
  }) => {
    // The inline passage-practice surface moved from Today's retired Recite card to the recitation hub
    // session (#610), so this flow reaches practice through the hub. Adopt straight into Learning (the
    // phase the old "Start reciting" transition produced) since Today no longer hosts that control.
    const planEntryId = await adoptPlan(
      setup.baseURL,
      page.request,
      setup.epub.entryId,
      "learning"
    );

    // Reach the segmentation surface through its real Library entry point — this Work's card links
    // "Divide into passages" into #/recite?plan=<id> — not a hand-built URL. Scope by this plan's href
    // so the click is unambiguous even when other routines exist in the shared library.
    await page.goto(`${setup.baseURL}#/library`);
    await page
      .getByRole("link", { name: "Divide into passages" })
      .and(page.locator(`[href="#/recite?plan=${planEntryId}"]`))
      .click();

    // On the segmentation page, divide the Work into passages (boundaries only — the source is untouched).
    await page.getByRole("button", { name: "Divide into passages" }).click();
    const firstPassage = page.getByRole("listitem").first();
    await expect(firstPassage).toBeVisible();
    await expect(firstPassage.getByText(/Passage 1 ·/)).toBeVisible();

    // Passages now seed QUEUED — Learning introduction is explicit and paced (#607). Nothing is due until
    // the learner deliberately introduces the first passage; the "Start first passage" action stamps it
    // introduced and seeds one due card. Wait for that write so the hub session below reads the due passage.
    const introductionPanel = page.getByRole("region", { name: "New passage" });
    await Promise.all([
      page.waitForResponse(
        (response) => response.url().includes("/introduce-next") && response.ok()
      ),
      introductionPanel.getByRole("button", { name: "Start first passage" }).click()
    ]);

    // Practise the due passage inside the recitation hub session (#609). It opens at full visual support
    // (the whole passage as a scaffold); the learner fades support down the ladder before reciting from
    // memory.
    await page.goto(`${setup.baseURL}#/recitation`);
    const hub = page.getByRole("region", { name: "Recitation" });
    await hub.getByRole("button", { name: "Start session" }).click();
    const session = hub.getByRole("region", { name: "Recitation session" });
    const supportGroup = session.getByRole("group", { name: "Support level" });
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

    // Re-entering the session re-fetches the passage; the chosen support level is remembered per passage.
    // A hash change alone would not remount the SPA, so force a real document reload to prove the level was
    // persisted server-side (not just kept in memory).
    await page.reload();
    const reloadedHub = page.getByRole("region", { name: "Recitation" });
    await reloadedHub.getByRole("button", { name: "Start session" }).click();
    const reloadedSession = reloadedHub.getByRole("region", { name: "Recitation session" });
    await expect(
      reloadedSession.getByRole("group", { name: "Support level" }).getByRole("button", {
        name: "First characters"
      })
    ).toHaveAttribute("aria-pressed", "true");

    const reveal = reloadedSession.getByRole("button", { name: "Reveal" });
    await expect(reveal).toBeVisible();
    await expect(reloadedSession.getByRole("button", { name: "Clean and natural" })).toHaveCount(0);

    // Reveal shows the exact source and the four self-ratings; grading records the review and the card
    // advances out of due (bounded — one at a time, never an overdue wall).
    await reveal.click();
    await reloadedSession.getByRole("button", { name: "Clean and natural" }).click();
    await expect(reloadedSession.getByRole("button", { name: "Clean and natural" })).toHaveCount(0);
  });
});
