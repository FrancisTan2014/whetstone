import { expect, test } from "../fixtures";

// Import notebook lists into Notes (#661): a learner pastes a multiline list, previews the deterministic
// split into Question/Note rows, and imports the whole batch atomically as standalone Notes. Every imported
// note lands in the one Notes list and is cardless — no Review until the learner deliberately adds it. When
// they do, an imported note reuses its confirmed question read-only (never retyped), exactly like an
// anchored note reuses its source. Editing the canonical Note afterwards is what the review prompt reveals;
// the cue itself is untouched. The enrolled prompt is graded back to "Due complete" so the shared review
// queue stays clean for the other specs. Terms are distinctive so every row assertion is scoped to its own
// list item in the shared stack.
test.describe("notes import", () => {
  test("imports a pasted list as cardless notes, then enrolls one by reusing its question", async ({
    page,
    setup
  }) => {
    await page.goto(`${setup.baseURL}#/notes`);
    await expect(page.getByRole("heading", { level: 1, name: "Notes" })).toBeVisible();

    // Open the import surface and paste two "term = gloss" pairs.
    await page.getByRole("button", { name: "Import" }).click();
    const panel = page.getByRole("region", { name: "Import a list into notes" });
    await expect(panel).toBeVisible();
    await panel
      .getByLabel("Paste your list")
      .fill("serendipity = a fortunate discovery\nidempotent = same effect when applied twice");
    await panel.getByRole("button", { name: "Preview" }).click();

    // The deterministic split proposes one row per line, each already carrying a Question and a Note.
    await expect(panel.getByRole("textbox", { name: "Question" }).first()).toContainText(
      "serendipity"
    );
    await panel.getByRole("button", { name: "Import 2" }).click();

    // Both land in the single Notes list, un-enrolled (cardless) — each shows "Add to review", not a due
    // projection. Scope every assertion to the row's own note body.
    await expect(page.getByText("Imported 2 notes.")).toBeVisible();
    const list = page.getByRole("list", { name: "Your notes" });
    const first = list.getByRole("listitem").filter({ hasText: "a fortunate discovery" });
    const second = list.getByRole("listitem").filter({ hasText: "same effect when applied twice" });
    await expect(first).toBeVisible();
    await expect(second).toBeVisible();
    await expect(first.getByText("Add to review")).toBeVisible();
    await expect(second.getByText("Add to review")).toBeVisible();

    // Edit the first note's canonical body — the imported cue must stay untouched, but the review prompt
    // reveals whatever the note now says.
    await first.getByRole("button", { name: /Open note/ }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog
      .getByRole("textbox", { name: "Note body" })
      .fill("a fortunate discovery (revised)");
    await page.getByRole("button", { name: "Save note" }).click();
    await expect(first.getByText("a fortunate discovery (revised)")).toBeVisible();

    // Add it to Review. An imported note reuses its confirmed question read-only: the exact cue is shown,
    // and there is no "what should Whetstone ask you?" input to retype it.
    await first.getByRole("button", { name: /Open note/ }).click();
    const reviewDialog = page.getByRole("dialog");
    await reviewDialog.getByRole("button", { name: "Add to review" }).click();
    await expect(reviewDialog.getByText("serendipity")).toBeVisible();
    await expect(reviewDialog.getByLabel("What should Whetstone ask you?")).toHaveCount(0);
    await reviewDialog.getByRole("button", { name: "Add to review" }).click();
    await expect(reviewDialog.getByText("Due now")).toBeVisible();

    // Grade the due prompt back to "Due complete" so the shared review queue stays clean. The revealed
    // note reflects the edit, while the cue is still the untouched imported question.
    await page.goto(`${setup.baseURL}#/notes/review`);
    await expect(page.getByRole("heading", { name: "Review" })).toBeVisible();
    await expect(page.getByText("serendipity")).toBeVisible();
    await page.getByRole("button", { name: "Show note" }).click();
    await expect(page.getByText("a fortunate discovery (revised)")).toBeVisible();
    await page.getByRole("button", { name: "Good" }).click();
    await expect(page.getByText(/Due complete/)).toBeVisible();
  });
});
