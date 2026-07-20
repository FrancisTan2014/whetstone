import { expect, test } from "../fixtures";

// The Notes home (#659) + direct card composition (#690): every owned note lives on one page. A learner
// composes a retrieval card from the one primary action — which mints the underlying note (its Answer) and
// one due prompt in a single step, with no standalone note composer — finds it by body and by its review
// question through the note-centric search, edits it in the shared rich editor, and grades the resulting
// due prompt back to "Due complete". The shared stack already holds other notes, so every row assertion is
// scoped to this note's own list item, and grading the prompt away at the end keeps the shared review queue
// clean for the other specs.
test.describe("notes home", () => {
  test("composes a card, finds it by body and question, edits the note, and grades it away", async ({
    page,
    setup
  }) => {
    await page.goto(`${setup.baseURL}#/notes`);
    await expect(page.getByRole("heading", { level: 1, name: "Notes" })).toBeVisible();

    // Compose a card from the one primary action — no reader, no standalone note composer.
    await page.getByRole("button", { name: "New card" }).click();
    const composer = page.getByRole("dialog");
    await expect(composer).toBeVisible();
    await composer.getByRole("textbox", { name: "Answer" }).fill("Distributed systems WAL note");
    await composer.getByRole("textbox", { name: "Question" }).fill("What does a WAL guarantee?");
    await composer.getByRole("button", { name: "Create card" }).click();

    // Success announces the new card; it lands in the single continuous list, already due.
    await expect(page.getByText("Card created. Due now.")).toBeVisible();
    const list = page.getByRole("list", { name: "Your notes" });
    const row = list.getByRole("listitem").filter({ hasText: "Distributed systems WAL note" });
    await expect(row).toBeVisible();
    await expect(row.getByText("Review due")).toBeVisible();

    // The note-centric search narrows the list by body and by the prompt's question; a non-match shows the
    // distinct no-match state; clearing it restores the full list.
    const search = page.getByRole("searchbox", { name: "Search notes" });
    await search.fill("WAL");
    await expect(row).toBeVisible();
    await search.fill("guarantee");
    await expect(row).toBeVisible();
    await search.fill("zzznope");
    await expect(page.getByText("No notes match")).toBeVisible();
    await search.fill("");
    await expect(row).toBeVisible();

    // Open the note in the shared editor and revise its body; the row reflects the new text.
    await row.getByRole("button", { name: /Open note/ }).click();
    const openEditor = page.getByRole("dialog");
    await expect(openEditor).toBeVisible();
    await openEditor
      .getByRole("textbox", { name: "Note body" })
      .fill("Distributed systems WAL note (revised)");
    await page.getByRole("button", { name: "Save note" }).click();
    await expect(row.getByText("Distributed systems WAL note (revised)")).toBeVisible();

    // Grade the due prompt back to "Due complete" so the shared queue stays clean for other specs.
    await page.goto(`${setup.baseURL}#/notes/review`);
    await expect(page.getByRole("heading", { name: "Review" })).toBeVisible();
    await page.getByRole("button", { name: "Show note" }).click();
    await page.getByRole("button", { name: "Good" }).click();
    await expect(page.getByText(/Due complete/)).toBeVisible();
  });

  // The Review-settings expansion (#660): a learner manages a note's Review lifecycle in place — pause,
  // resume, restart, remove, and re-add — without ever losing the note or its append-only history, all
  // over the shared Review command boundary. The restart writes a real reset event that survives a
  // removal (the history is kept), and the note body is never touched. The re-added prompt is graded back
  // to "Due complete" so the shared review queue stays clean for the other specs.
  test("manages a note's Review settings without losing the note or its history", async ({
    page,
    setup
  }) => {
    await page.goto(`${setup.baseURL}#/notes`);
    await expect(page.getByRole("heading", { level: 1, name: "Notes" })).toBeVisible();

    // Compose a card so the note lands already enrolled with one due prompt, then open the Review-settings
    // expansion in place.
    await page.getByRole("button", { name: "New card" }).click();
    const composer = page.getByRole("dialog");
    await composer.getByRole("textbox", { name: "Answer" }).fill("Raft leader election note");
    await composer.getByRole("textbox", { name: "Question" }).fill("What triggers a Raft election?");
    await composer.getByRole("button", { name: "Create card" }).click();
    await expect(page.getByText("Card created. Due now.")).toBeVisible();

    const list = page.getByRole("list", { name: "Your notes" });
    const row = list.getByRole("listitem").filter({ hasText: "Raft leader election note" });
    await expect(row).toBeVisible();

    await row.getByRole("button", { name: /Open note/ }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Due now")).toBeVisible();

    await dialog.getByRole("button", { name: "Review settings" }).click();
    const settingsRow = dialog
      .getByRole("listitem")
      .filter({ hasText: "What triggers a Raft election?" });
    await expect(settingsRow).toBeVisible();

    // Pause withholds the card from the due scan; resume restores it — neither writes a history event.
    await settingsRow.getByRole("button", { name: "Pause" }).click();
    await expect(settingsRow.getByText("Paused")).toBeVisible();
    await settingsRow.getByRole("button", { name: "Resume" }).click();
    await expect(settingsRow.getByText("Due now")).toBeVisible();

    // Restart writes exactly one reset event and pulls the next review to now.
    await settingsRow.getByRole("button", { name: "Restart" }).click();
    await settingsRow.getByRole("button", { name: "Confirm restart" }).click();
    await expect(settingsRow.getByText("Due now")).toBeVisible();
    await settingsRow.getByRole("button", { name: "Review history" }).click();
    await expect(settingsRow.getByText("Schedule restarted")).toBeVisible();
    await settingsRow.getByRole("button", { name: "Hide review history" }).click();

    // Remove drops the card but keeps the note and its history; re-adding brings the card back, due now.
    await settingsRow.getByRole("button", { name: "Remove" }).click();
    await settingsRow.getByRole("button", { name: "Confirm remove" }).click();
    await expect(settingsRow.getByText("Not in review")).toBeVisible();
    await settingsRow.getByRole("button", { name: "Review history" }).click();
    await expect(settingsRow.getByText("Schedule restarted")).toBeVisible();
    await settingsRow.getByRole("button", { name: "Hide review history" }).click();
    await settingsRow.getByRole("button", { name: "Add to review" }).click();
    await expect(settingsRow.getByText("Due now")).toBeVisible();

    // The note body itself was never rewritten by any settings action.
    await expect(dialog.getByRole("textbox", { name: "Note body" })).toContainText(
      "Raft leader election note"
    );

    // Grade the re-added due prompt back to "Due complete" so the shared queue stays clean.
    await page.goto(`${setup.baseURL}#/notes/review`);
    await expect(page.getByRole("heading", { name: "Review" })).toBeVisible();
    await page.getByRole("button", { name: "Show note" }).click();
    await page.getByRole("button", { name: "Good" }).click();
    await expect(page.getByText(/Due complete/)).toBeVisible();
  });
});
