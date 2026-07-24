import { expect, test } from "../fixtures";

// Direct card composition from Notes (#690): the primary "New card" action opens the wide composer, which
// authors a retrieval card straight from a Question/Answer pair and mints one recurring review — no saved
// note required first. Both specs prove the composer's Try preview rehearses the exact review sequence while
// persisting nothing, then create the card and grade its due prompt at /notes/review, exercising the two
// reveal shapes: the whole note (default) and a Success check followed by the Reference. Each grades its
// prompt back to "Due complete" so the shared review queue stays clean for the other specs.
test.describe("notes direct card", () => {
  test("previews a whole-note card without persisting, then creates and reviews it", async ({
    page,
    setup
  }) => {
    await page.goto(`${setup.baseURL}#/notes`);
    await expect(page.getByRole("heading", { level: 1, name: "Notes" })).toBeVisible();

    await page.getByRole("button", { name: "New card" }).click();
    const composer = page.getByRole("dialog");
    await expect(composer).toBeVisible();
    await composer
      .getByRole("textbox", { name: "Answer" })
      .fill("A WAL is flushed before the write is applied");
    await composer
      .getByRole("textbox", { name: "Question" })
      .fill("What ordering does a WAL guarantee?");

    // Try card rehearses the exact review sequence — Question, then a single Reveal of the whole note — and
    // persists nothing. Before Reveal the note is withheld; Reveal shows it; Back returns to editing intact.
    await composer.getByRole("button", { name: "Try card" }).click();
    await expect(composer.getByText("Preview · nothing is saved")).toBeVisible();
    await expect(composer.getByLabel("Note")).toHaveCount(0);
    await composer.getByRole("button", { name: "Reveal" }).click();
    await expect(composer.getByLabel("Note")).toContainText(
      "A WAL is flushed before the write is applied"
    );
    await composer.getByRole("button", { name: "Back to editing" }).click();
    await expect(composer.getByRole("textbox", { name: "Answer" })).toContainText(
      "A WAL is flushed before the write is applied"
    );

    // The preview minted nothing, so creation is what actually adds the recurring review.
    await composer.getByRole("button", { name: "Create card" }).click();
    await expect(page.getByText("Card created. Due now.")).toBeVisible();

    // Review the whole-note reveal shape and grade it away.
    await page.goto(`${setup.baseURL}#/notes/review`);
    await expect(page.getByRole("heading", { name: "Review" })).toBeVisible();
    await page.getByRole("button", { name: "Show note" }).click();
    await expect(page.getByLabel("Note")).toContainText(
      "A WAL is flushed before the write is applied"
    );
    await page.getByRole("button", { name: "Good" }).click();
    await expect(page.getByText(/Due complete/)).toBeVisible();
  });

  test("composes a card with an explicit Success check and reviews the Reference reveal", async ({
    page,
    setup
  }) => {
    await page.goto(`${setup.baseURL}#/notes`);
    await expect(page.getByRole("heading", { level: 1, name: "Notes" })).toBeVisible();

    await page.getByRole("button", { name: "New card" }).click();
    const composer = page.getByRole("dialog");
    await composer
      .getByRole("textbox", { name: "Answer" })
      .fill("Raft uses randomized election timeouts to avoid split votes across the cluster");
    await composer
      .getByRole("textbox", { name: "Question" })
      .fill("How does Raft avoid split votes?");

    // Disclose the specific Success check: the workspace relabels to Reference and a required check appears.
    await composer.getByRole("button", { name: "Add a specific success check" }).click();
    await expect(composer.getByRole("heading", { name: "Reference" })).toBeVisible();
    await composer
      .getByRole("textbox", { name: "Success check" })
      .fill("randomized election timeouts");

    // Try card reveals the Success check followed by the Reference — not the whole note alone.
    await composer.getByRole("button", { name: "Try card" }).click();
    await composer.getByRole("button", { name: "Reveal" }).click();
    await expect(composer.getByLabel("Success check")).toContainText(
      "randomized election timeouts"
    );
    await expect(composer.getByLabel("Reference")).toContainText(
      "avoid split votes across the cluster"
    );
    await composer.getByRole("button", { name: "Back to editing" }).click();

    await composer.getByRole("button", { name: "Create card" }).click();
    await expect(page.getByText("Card created. Due now.")).toBeVisible();

    // Review the expected-response reveal shape (Success check + Reference) and grade it away.
    await page.goto(`${setup.baseURL}#/notes/review`);
    await expect(page.getByRole("heading", { name: "Review" })).toBeVisible();
    await page.getByRole("button", { name: "Show note" }).click();
    await expect(page.getByLabel("Success check")).toContainText("randomized election timeouts");
    await expect(page.getByLabel("Reference")).toContainText("avoid split votes across the cluster");
    await page.getByRole("button", { name: "Good" }).click();
    await expect(page.getByText(/Due complete/)).toBeVisible();
  });
});
