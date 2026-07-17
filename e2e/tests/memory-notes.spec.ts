import { expect, test } from "../fixtures";

// The core Memory loop (#573): a learner adds a schedulable item by hand, finds it in Memory, then
// reveals and grades its prompt on the shared FSRS schedule and sees it advance out of "due". The stack
// boots a fresh in-memory database, so Memory starts empty and this note is the only row.
test.describe("memory notes", () => {
  test("adds an item, finds it in Memory, reveals and grades its prompt, and sees it advance", async ({
    page,
    setup
  }) => {
    await page.goto(`${setup.baseURL}#/memory`);
    await expect(page.getByRole("heading", { name: "Memory" })).toBeVisible();

    // Quick Add starts compact; open the details form to capture a full cue/answer direction (a
    // schedulable item), avoiding the offline-dictionary lookup path so the flow stays deterministic.
    await page.getByRole("button", { name: "Add details" }).click();
    await page.getByLabel("Cue").fill("kanmusu");
    await page.getByLabel("Answer", { exact: true }).fill("ship girl");
    await page.getByRole("button", { name: "Add", exact: true }).click();

    // The new fragment appears in the list. A freshly scheduled card is due now, so its state chip
    // reads "1 due" and it carries exactly one prompt.
    const list = page.getByRole("list", { name: "Your memory" });
    const row = list.getByRole("button", { name: /kanmusu/ });
    await expect(row).toBeVisible();
    await expect(row).toContainText("Added by you");
    await expect(row).toContainText("1 prompt");
    await expect(row).toContainText("1 due");

    // The Memory surface links to the review flow when something is due; follow it to the
    // Notes-owned Review session. The historical /recall path is kept as a compat route onto it.
    await page.getByRole("link", { name: "Review 1 due" }).click();
    await expect(page).toHaveURL(/#\/recall$/);
    await expect(page.getByRole("heading", { name: "Review" })).toBeVisible();

    // A self-grade only counts after an explicit reveal: the cue shows first, then the note, then the
    // four FSRS ratings. Grading "Good" advances the card and clears today's batch.
    await expect(page.getByText("kanmusu")).toBeVisible();
    await page.getByRole("button", { name: "Show note" }).click();
    await expect(page.getByText("ship girl")).toBeVisible();
    await page.getByRole("button", { name: "Good" }).click();
    // Rating never auto-advances: the next scheduled date is shown, and the learner chooses to continue.
    await expect(page.getByText(/Next review:/)).toBeVisible();
    await page.getByRole("button", { name: "Review next" }).click();
    await expect(page.getByText(/Due complete/)).toBeVisible();

    // The canonical /notes/review entry point mounts the very same session — reaching it directly
    // after the batch is cleared shows the same calm due-complete state, not a different surface.
    await page.goto(`${setup.baseURL}#/notes/review`);
    await expect(page.getByRole("heading", { name: "Review" })).toBeVisible();
    await expect(page.getByText(/Due complete/)).toBeVisible();

    // Back in Memory the same fragment is now scheduled for the future — no longer due today.
    await page.goto(`${setup.baseURL}#/memory`);
    const advancedRow = page
      .getByRole("list", { name: "Your memory" })
      .getByRole("button", { name: /kanmusu/ });
    await expect(advancedRow).toBeVisible();
    await expect(advancedRow).toContainText("Scheduled");
    await expect(advancedRow).not.toContainText("due");
  });
});
