import { expect, test } from "../fixtures";

// The Notes home (#659): every owned note lives on one page. A learner creates a standalone note (no
// reader selection), finds it by body and then by its review question through the note-centric search,
// edits it in the shared rich editor, adds it to Review with a learner-authored question, and grades the
// resulting due prompt back to "Due complete". The shared stack already holds other notes, so every row
// assertion is scoped to this note's own list item, and grading the enrolled prompt away at the end keeps
// the shared review queue clean for the other specs.
test.describe("notes home", () => {
  test("creates, searches, edits, and enrolls a standalone note, then grades it away", async ({
    page,
    setup
  }) => {
    await page.goto(`${setup.baseURL}#/notes`);
    await expect(page.getByRole("heading", { level: 1, name: "Notes" })).toBeVisible();

    // Create a standalone note from the one primary action — no reader, no source.
    await page.getByRole("button", { name: "New note" }).click();
    const editor = page.getByRole("dialog");
    await expect(editor).toBeVisible();
    await editor.getByRole("textbox", { name: "Note body" }).fill("Distributed systems WAL note");
    await page.getByRole("button", { name: "Save note" }).click();

    // It lands in the single continuous list, un-enrolled. The shared stack already holds other notes,
    // so every row assertion is scoped to this note's own list item.
    const list = page.getByRole("list", { name: "Your notes" });
    const row = list.getByRole("listitem").filter({ hasText: "Distributed systems WAL note" });
    await expect(row).toBeVisible();
    await expect(row.getByText("Add to review")).toBeVisible();

    // The note-centric search narrows the list; a non-match shows the distinct no-match state; clearing
    // it restores the full list.
    const search = page.getByRole("searchbox", { name: "Search notes" });
    await search.fill("WAL");
    await expect(row).toBeVisible();
    await search.fill("zzznope");
    await expect(page.getByText("No notes match")).toBeVisible();
    await search.fill("");
    await expect(row).toBeVisible();

    // Open the note in the shared editor and revise its body.
    await row.getByRole("button", { name: /Open note/ }).click();
    const openEditor = page.getByRole("dialog");
    await expect(openEditor).toBeVisible();
    const body = openEditor.getByRole("textbox", { name: "Note body" });
    await body.fill("Distributed systems WAL note (revised)");
    await page.getByRole("button", { name: "Save note" }).click();
    await expect(row.getByText("Distributed systems WAL note (revised)")).toBeVisible();

    // Reopen and add it to Review with a learner-authored question (a standalone note has no source to
    // reuse, so the UI asks exactly what to be asked).
    await row.getByRole("button", { name: /Open note/ }).click();
    const reviewEditor = page.getByRole("dialog");
    await reviewEditor.getByRole("button", { name: "Add to review" }).click();
    await reviewEditor
      .getByLabel("What should Whetstone ask you?")
      .fill("What does a WAL guarantee?");
    await reviewEditor.getByRole("button", { name: "Add to review" }).click();
    await expect(reviewEditor.getByText("Due now")).toBeVisible();
    await reviewEditor.getByRole("button", { name: "Cancel" }).click();

    // The row now projects the due state. Its search is reachable by the question text too.
    await expect(row.getByText("Review due")).toBeVisible();
    await search.fill("guarantee");
    await expect(row).toBeVisible();
    await search.fill("");

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

    await page.getByRole("button", { name: "New note" }).click();
    const newEditor = page.getByRole("dialog");
    await newEditor.getByRole("textbox", { name: "Note body" }).fill("Raft leader election note");
    await page.getByRole("button", { name: "Save note" }).click();

    const list = page.getByRole("list", { name: "Your notes" });
    const row = list.getByRole("listitem").filter({ hasText: "Raft leader election note" });
    await expect(row).toBeVisible();

    // Enroll with a learner-authored question, then open the Review-settings expansion in place.
    await row.getByRole("button", { name: /Open note/ }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Add to review" }).click();
    await dialog.getByLabel("What should Whetstone ask you?").fill("What triggers a Raft election?");
    await dialog.getByRole("button", { name: "Add to review" }).click();
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
