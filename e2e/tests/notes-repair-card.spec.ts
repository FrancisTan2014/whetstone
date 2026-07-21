import { expect, test } from "../fixtures";

// Repair an unclear card before rating (#691): inside a Notes Review session a learner can fix a confusing
// Question WITHOUT rating — the repair records no review event, so the card stays due and its schedule is
// untouched. This seeds one standalone note, authors a deliberately vague recognition card over it (which
// makes it due immediately), then in Review clicks "Fix card" BEFORE revealing or rating, clarifies the
// Question, and Saves. The proof that no false failure was recorded is behavioural: after the repair the
// session returns to the Question phase for the SAME card (still due, now showing the clarified cue) rather
// than advancing or completing. Only then does the learner reveal and rate once, draining the queue to
// "Due complete" — a single genuine review event, never one manufactured by the repair.
test.describe("notes repair unclear card before rating", () => {
  test("fixes a vague card before rating, keeps it due, then rates it once", async ({
    page,
    setup
  }) => {
    const created = await page.request.post(`${setup.baseURL}api/notes`, {
      data: {
        bodyDoc: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "A quorum write survives the loss of any single replica because a later read overlaps at least one up-to-date replica"
                }
              ]
            }
          ]
        }
      }
    });
    expect(created.status()).toBe(201);

    await page.goto(`${setup.baseURL}#/notes`);
    await expect(page.getByRole("heading", { level: 1, name: "Notes" })).toBeVisible();

    const list = page.getByRole("list", { name: "Your notes" });
    const row = list
      .getByRole("listitem")
      .filter({ hasText: "A quorum write survives the loss of any single replica" });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: /Open note/ }).click();

    const dialog = page.getByRole("dialog", { name: "Edit note" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("tab", { name: "Cards" }).click();
    const cardsPanel = dialog.getByRole("tabpanel", { name: "Cards" });

    // Author a deliberately vague recognition card — the kind a learner later realises is unclear.
    await cardsPanel.getByRole("button", { name: "Add card" }).click();
    await cardsPanel.getByRole("textbox", { name: "Question" }).fill("Why does it survive?");
    await cardsPanel.getByRole("button", { name: "Add card" }).click();
    await expect(
      cardsPanel.getByRole("button", { name: /Why does it survive\?/ })
    ).toBeVisible();

    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toBeHidden();

    // The card is due. In the Question phase, BEFORE revealing or rating, the learner realises the cue is
    // ambiguous and chooses to fix it rather than guess — "Fix card" never exposes a rating.
    await page.goto(`${setup.baseURL}#/notes/review`);
    await expect(page.getByRole("heading", { name: "Review" })).toBeVisible();
    await expect(page.getByText("Why does it survive?")).toBeVisible();
    await page.getByRole("button", { name: "Fix card" }).click();

    // The repair view opens. It states plainly that fixing never counts as a review.
    await expect(page.getByRole("heading", { name: "Fix this card" })).toBeVisible();
    await expect(page.getByText(/never counts as a review/)).toBeVisible();

    // Clarify the Question and Save. This edits only the Question (no grading-target change), so it persists
    // immediately with no Keep/Restart prompt.
    const questionField = page.getByRole("textbox", { name: "Question" });
    await questionField.fill("Why does a quorum write survive losing one replica?");
    await page.getByRole("button", { name: "Save" }).click();

    // Behavioural proof of "no false failure": the session returns to the Question phase for the SAME card,
    // now showing the clarified cue — the card is STILL due (not advanced, not completed by the repair).
    await expect(
      page.getByText("Why does a quorum write survive losing one replica?")
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Show note" })).toBeVisible();
    await expect(page.getByText(/Due complete/)).toBeHidden();

    // Only now does a genuine review happen: reveal the note, then rate once. That single rating — never one
    // manufactured by the repair — reschedules the card and drains the queue.
    await page.getByRole("button", { name: "Show note" }).click();
    await expect(page.getByText("overlaps at least one up-to-date replica").first()).toBeVisible();
    await page.getByRole("button", { name: "Good" }).click();

    await expect(page.getByText(/Due complete/)).toBeVisible();
  });
});
