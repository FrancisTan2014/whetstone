import { expect, test } from "../fixtures";

// Independent card directions over ONE saved note (#688): a note may own MANY authored retrieval cards, each
// its own independently-scheduled review card — not a single per-note contract. This seeds one standalone
// note, authors TWO distinct whole-note cards over it in place (Add card stays available after the first),
// confirms both rows coexist in the Cards list, then reviews: both are due, and grading ONE leaves the other
// still due (distinct schedules, no shared target), before grading the second away to keep the queue clean.
test.describe("notes independent card directions", () => {
  test("authors two independent cards over one note and schedules them separately", async ({
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
    await row.getByRole("button", { name: /Open note/ }).click();

    const dialog = page.getByRole("dialog", { name: "Edit note" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("tab", { name: "Cards" }).click();
    const cardsPanel = dialog.getByRole("tabpanel", { name: "Cards" });

    // First direction: a whole-note recognition card.
    await cardsPanel.getByRole("button", { name: "Add card" }).click();
    await cardsPanel
      .getByRole("textbox", { name: "Question" })
      .fill("What ordering does a WAL guarantee?");
    await cardsPanel.getByRole("button", { name: "Add card" }).click();
    await expect(
      cardsPanel.getByRole("button", { name: /What ordering does a WAL guarantee\?/ })
    ).toBeVisible();

    // Add card is STILL offered even though the note now owns an authored card (#688) — author a second,
    // independently-scheduled direction over the same note.
    await cardsPanel.getByRole("button", { name: "Add card" }).click();
    await cardsPanel
      .getByRole("textbox", { name: "Question" })
      .fill("When is a WAL entry made durable?");
    await cardsPanel.getByRole("button", { name: "Add card" }).click();

    // Both directions coexist as distinct rows over the one note.
    await expect(
      cardsPanel.getByRole("button", { name: /What ordering does a WAL guarantee\?/ })
    ).toBeVisible();
    await expect(
      cardsPanel.getByRole("button", { name: /When is a WAL entry made durable\?/ })
    ).toBeVisible();

    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toBeHidden();

    // Both cards are due. Grading ONE must leave the OTHER due — independent schedules, no shared target.
    await page.goto(`${setup.baseURL}#/notes/review`);
    await expect(page.getByRole("heading", { name: "Review" })).toBeVisible();
    await page.getByRole("button", { name: "Good" }).click();
    // A second due card remains: the Good control is still present rather than the empty "Due complete".
    await expect(page.getByRole("button", { name: "Good" })).toBeVisible();
    await page.getByRole("button", { name: "Good" }).click();
    await expect(page.getByText(/Due complete/)).toBeVisible();
  });
});
