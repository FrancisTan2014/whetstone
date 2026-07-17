import { expect, test } from "../fixtures";

// The Notes home (#659): every owned note lives on one page. A learner creates a standalone note (no
// reader selection), finds it by body and then by its review question through the note-centric search,
// edits it in the shared rich editor, adds it to Review with a learner-authored question, and grades the
// resulting due prompt back to "Due complete". The stack boots a fresh in-memory database, so this is the
// only note; grading it away at the end keeps the shared review queue clean for the other specs.
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

    // It lands in the single continuous list, un-enrolled.
    const list = page.getByRole("list", { name: "Your notes" });
    await expect(list.getByText("Distributed systems WAL note")).toBeVisible();
    await expect(list.getByText("Add to review")).toBeVisible();

    // The note-centric search narrows the list; a non-match shows the distinct no-match state; clearing
    // it restores the full list.
    const search = page.getByRole("searchbox", { name: "Search notes" });
    await search.fill("WAL");
    await expect(list.getByText("Distributed systems WAL note")).toBeVisible();
    await search.fill("zzznope");
    await expect(page.getByText("No notes match")).toBeVisible();
    await search.fill("");
    await expect(list.getByText("Distributed systems WAL note")).toBeVisible();

    // Open the note in the shared editor and revise its body.
    await list.getByRole("button", { name: /Open note/ }).click();
    const openEditor = page.getByRole("dialog");
    await expect(openEditor).toBeVisible();
    const body = openEditor.getByRole("textbox", { name: "Note body" });
    await body.fill("Distributed systems WAL note (revised)");
    await page.getByRole("button", { name: "Save note" }).click();
    await expect(list.getByText("Distributed systems WAL note (revised)")).toBeVisible();

    // Reopen and add it to Review with a learner-authored question (a standalone note has no source to
    // reuse, so the UI asks exactly what to be asked).
    await list.getByRole("button", { name: /Open note/ }).click();
    const reviewEditor = page.getByRole("dialog");
    await reviewEditor.getByRole("button", { name: "Add to review" }).click();
    await reviewEditor
      .getByLabel("What should Whetstone ask you?")
      .fill("What does a WAL guarantee?");
    await reviewEditor.getByRole("button", { name: "Add to review" }).click();
    await expect(reviewEditor.getByText("Due now")).toBeVisible();
    await reviewEditor.getByRole("button", { name: "Cancel" }).click();

    // The row now projects the due state. Its search is reachable by the question text too.
    await expect(list.getByText("Review due")).toBeVisible();
    await search.fill("guarantee");
    await expect(list.getByText("Distributed systems WAL note (revised)")).toBeVisible();
    await search.fill("");

    // Grade the due prompt back to "Due complete" so the shared queue stays clean for other specs.
    await page.goto(`${setup.baseURL}#/notes/review`);
    await expect(page.getByRole("heading", { name: "Review" })).toBeVisible();
    await page.getByRole("button", { name: "Show note" }).click();
    await page.getByRole("button", { name: "Good" }).click();
    await expect(page.getByText(/Due complete/)).toBeVisible();
  });
});
