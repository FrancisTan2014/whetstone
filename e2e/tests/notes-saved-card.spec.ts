import { expect, test } from "../fixtures";

// Author the first review card over an EXISTING saved note (#687): a standalone note starts cardless, so its
// Cards tab offers "Add card" — the inline composer authors ONE rich retrieval card in place over the note's
// own body as the read-only Answer/Reference, never a second note. This seeds a bodyless-free standalone note
// through the API (cardless by construction), opens its Cards workspace, authors a card with an explicit
// Success check, rehearses the exact review with Try preview (persisting nothing), creates it, confirms the
// new row, then grades the resulting due prompt back to "Due complete" so the shared review queue stays clean
// for the other specs.
test.describe("notes saved-note first card", () => {
  test("authors a saved note's first card with a Success check, then reviews it away", async ({
    page,
    setup
  }) => {
    // Seed a standalone note (bodied, cardless) so the Cards tab starts with the Add-card affordance.
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
                  text: "A write-ahead log is flushed to durable storage before the write is applied"
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
      .filter({ hasText: "A write-ahead log is flushed to durable storage" });
    await expect(row).toBeVisible();

    // A fresh standalone note carries no card yet.
    await row.getByRole("button", { name: /Open note/ }).click();
    const dialog = page.getByRole("dialog", { name: "Edit note" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("tab", { name: "Cards" }).click();
    const cardsPanel = dialog.getByRole("tabpanel", { name: "Cards" });
    await expect(cardsPanel.getByText("This note has no review cards yet.")).toBeVisible();

    // Add card opens the inline composer over the existing note body — the note is the read-only Answer.
    await cardsPanel.getByRole("button", { name: "Add card" }).click();
    await cardsPanel
      .getByRole("textbox", { name: "Question" })
      .fill("What ordering does a WAL guarantee?");

    // Disclose an explicit Success check: the workspace relabels to Reference and a required check appears.
    await cardsPanel.getByRole("button", { name: "Add a specific success check" }).click();
    await expect(cardsPanel.getByRole("heading", { name: "Reference" })).toBeVisible();
    await cardsPanel
      .getByRole("textbox", { name: "Success check" })
      .fill("flushed before the write is applied");

    // Try card rehearses the exact review — Question, then a single Reveal of the Success check followed by
    // the Reference (the note body) — and persists nothing; Back returns to editing intact.
    await cardsPanel.getByRole("button", { name: "Try card" }).click();
    await cardsPanel.getByRole("button", { name: "Reveal" }).click();
    await expect(cardsPanel.getByLabel("Success check")).toContainText(
      "flushed before the write is applied"
    );
    await expect(cardsPanel.getByLabel("Reference")).toContainText(
      "before the write is applied"
    );
    await cardsPanel.getByRole("button", { name: "Back to editing" }).click();

    // The preview minted nothing; Add card is what actually authors the first card. It lands in the list.
    await cardsPanel.getByRole("button", { name: "Add card" }).click();
    await expect(
      cardsPanel.getByRole("button", { name: /What ordering does a WAL guarantee\?/ })
    ).toBeVisible();

    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toBeHidden();

    // Review the expected-response reveal shape (Success check + Reference) and grade it back to complete.
    await page.goto(`${setup.baseURL}#/notes/review`);
    await expect(page.getByRole("heading", { name: "Review" })).toBeVisible();
    await page.getByRole("button", { name: "Show note" }).click();
    await expect(page.getByLabel("Success check")).toContainText(
      "flushed before the write is applied"
    );
    await expect(page.getByLabel("Reference")).toContainText("before the write is applied");
    await page.getByRole("button", { name: "Good" }).click();
    await expect(page.getByText(/Due complete/)).toBeVisible();
  });
});
