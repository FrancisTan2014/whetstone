import { expect, test } from "../fixtures";

// Independent card directions over ONE saved note (#688): a note may own MANY authored retrieval cards, each
// its own independently-scheduled review card with its OWN grading target — not a single per-note contract.
// This seeds one standalone note, then authors TWO distinct directions over it in place: a recognition card
// graded against the whole note (`current_note`) and a production card graded against an authored Success
// check (`expected_response`), proving Add card stays available after the first. It confirms both rows
// coexist in the Cards list with DISTINCT reveal summaries (distinct grading targets, nothing shared), then
// reviews: both are due, each reveal reads the live note body as its Reference/whole-note reveal, and grading
// ONE leaves the other still due (distinct schedules), before grading the second away to keep the queue clean.
test.describe("notes independent card directions", () => {
  test("authors recognition + production cards over one note and schedules them separately", async ({
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
                  text: "Two-phase commit blocks indefinitely when the coordinator crashes after the prepare phase"
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
      .filter({ hasText: "Two-phase commit blocks indefinitely when the coordinator crashes" });
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
      .fill("What does two-phase commit risk on coordinator failure?");
    await cardsPanel.getByRole("button", { name: "Add card" }).click();
    await expect(
      cardsPanel.getByRole("button", {
        name: /What does two-phase commit risk on coordinator failure\?/
      })
    ).toBeVisible();

    // Add card is STILL offered even though the note now owns an authored card (#688) — author a SECOND,
    // independently-scheduled direction with its OWN grading target (an authored Success check).
    await cardsPanel.getByRole("button", { name: "Add card" }).click();
    await cardsPanel
      .getByRole("textbox", { name: "Question" })
      .fill("When does two-phase commit block?");
    await cardsPanel.getByRole("button", { name: "Add a specific success check" }).click();
    await expect(cardsPanel.getByRole("heading", { name: "Reference" })).toBeVisible();
    await cardsPanel
      .getByRole("textbox", { name: "Success check" })
      .fill("blocks until the coordinator recovers");
    await cardsPanel.getByRole("button", { name: "Add card" }).click();

    // Both directions coexist as distinct rows with DISTINCT reveal summaries — separate grading targets,
    // nothing shared: the recognition card grades against the whole note, the production card against its
    // own authored Success check.
    await expect(
      cardsPanel.getByRole("button", {
        name: /What does two-phase commit risk on coordinator failure\?/
      })
    ).toBeVisible();
    await expect(
      cardsPanel.getByRole("button", { name: /When does two-phase commit block\?/ })
    ).toBeVisible();
    await expect(cardsPanel.getByText("Whole note")).toBeVisible();
    await expect(cardsPanel.getByText("Specific success check")).toBeVisible();

    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toBeHidden();

    // Both cards are due. Each reveal reads the live note body as its Reference/whole-note reveal, and
    // grading ONE must leave the OTHER due — the session offers "Review next" (server remainingDue > 0)
    // rather than completing, proving the two cards are scheduled independently, with no shared target.
    await page.goto(`${setup.baseURL}#/notes/review`);
    await expect(page.getByRole("heading", { name: "Review" })).toBeVisible();

    await page.getByRole("button", { name: "Show note" }).click();
    // The revealed material carries the live note body whichever direction is presented first — the
    // whole-note reveal shows it as the Note, the production reveal shows it as the Reference.
    await expect(page.getByText("after the prepare phase").first()).toBeVisible();
    await page.getByRole("button", { name: "Good" }).click();

    // A second due card remains: the session offers to continue rather than showing the empty board.
    await expect(page.getByRole("button", { name: "Review next" })).toBeVisible();
    await page.getByRole("button", { name: "Review next" }).click();
    await page.getByRole("button", { name: "Show note" }).click();
    await expect(page.getByText("after the prepare phase").first()).toBeVisible();
    await page.getByRole("button", { name: "Good" }).click();

    // With both independent cards graded, nothing else is due.
    await expect(page.getByText(/Due complete/)).toBeVisible();
  });
});
