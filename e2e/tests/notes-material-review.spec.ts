import { expect, test } from "../fixtures";

// Reviewing exact Note material before card creation (#712): when a New-card save's Answer already exists in
// Notes, the learner keeps the full draft and authoritatively reviews it — adding the drafted retrieval
// contract to an existing Note (Use existing material, via #688) or deliberately minting a distinct Note
// (Keep separate, via #689). This drives the whole flow through the UI: it mints a first direct card, then
// drafts DIFFERENT Questions over the SAME Answer to trigger review, proving reuse grows ONE note to TWO
// independent cards and keep-separate mints a SECOND note without touching the first — using the panel's own
// per-candidate card-count evidence — then reviews the independently-scheduled cards to a clean queue.
test.describe("notes material review", () => {
  test("reuses existing material into one note with two cards, then keeps separate as a second note", async ({
    page,
    setup
  }) => {
    const answer = "A Raft leader steps down when it can no longer reach a quorum of followers";

    await page.goto(`${setup.baseURL}#/notes`);
    await expect(page.getByRole("heading", { level: 1, name: "Notes" })).toBeVisible();

    // Pass 1 — mint the first direct card. This creates note #1 (body = the Answer) with its first card, so
    // the Answer now exists in Notes and later drafts over it must be reviewed.
    await page.getByRole("button", { name: "New card" }).click();
    let composer = page.getByRole("dialog", { name: "New card" });
    await composer.getByRole("textbox", { name: "Answer" }).fill(answer);
    await composer
      .getByRole("textbox", { name: "Question" })
      .fill("When does a Raft leader step down?");
    await composer.getByRole("button", { name: "Create card" }).click();
    await expect(page.getByText("Card created. Due now.")).toBeVisible();

    // Pass 2 — draft a DIFFERENT Question over the SAME Answer. The save is authoritatively reviewed: the
    // full draft is kept and the material-review panel surfaces the one existing candidate, which owns a
    // single card so far.
    await page.getByRole("button", { name: "New card" }).click();
    composer = page.getByRole("dialog", { name: "New card" });
    await composer.getByRole("textbox", { name: "Answer" }).fill(answer);
    await composer
      .getByRole("textbox", { name: "Question" })
      .fill("What quorum loss forces a Raft leader to step down?");
    await composer.getByRole("button", { name: "Create card" }).click();

    const review = page.getByRole("dialog", { name: "This material is already in Notes" });
    await expect(review).toBeVisible();
    const candidates = review.getByRole("list", { name: "Existing material" });
    await expect(candidates.getByRole("listitem")).toHaveCount(1);
    await expect(candidates.getByText("1 card", { exact: true })).toBeVisible();

    // Use existing material — add the drafted contract to that note via #688's canonical writer. It is
    // reused, not created: success announces the reuse and no second note is minted.
    await review.getByRole("button", { name: /Use existing material/ }).click();
    await expect(page.getByText("Card added to existing note. Due now.")).toBeVisible();

    // Pass 3 — draft a THIRD Question over the same Answer. The candidate now reports TWO cards, proving
    // pass 2's reuse added a second independent card to the SAME note — one note, two cards.
    await page.getByRole("button", { name: "New card" }).click();
    composer = page.getByRole("dialog", { name: "New card" });
    await composer.getByRole("textbox", { name: "Answer" }).fill(answer);
    await composer
      .getByRole("textbox", { name: "Question" })
      .fill("Which failure makes a Raft leader relinquish leadership?");
    await composer.getByRole("button", { name: "Create card" }).click();

    const reviewAgain = page.getByRole("dialog", { name: "This material is already in Notes" });
    await expect(reviewAgain).toBeVisible();
    await expect(
      reviewAgain.getByRole("list", { name: "Existing material" }).getByRole("listitem")
    ).toHaveCount(1);
    await expect(reviewAgain.getByText("2 cards", { exact: true })).toBeVisible();

    // Keep separate — deliberately mint a DISTINCT note for the same material through the direct-card writer.
    // It is created, not reused.
    await reviewAgain.getByRole("button", { name: "Keep separate" }).click();
    await expect(page.getByText("Card created. Due now.")).toBeVisible();

    // Pass 4 — draft once more to read the evidence: TWO candidates now share the material — the first note
    // still owns its two cards (unchanged), the kept-separate note owns one — proving keep-separate minted a
    // second note without touching the first. Then Back restores the draft and the composer is cancelled, so
    // this probe creates nothing.
    await page.getByRole("button", { name: "New card" }).click();
    composer = page.getByRole("dialog", { name: "New card" });
    await composer.getByRole("textbox", { name: "Answer" }).fill(answer);
    await composer
      .getByRole("textbox", { name: "Question" })
      .fill("How does quorum loss affect a Raft leader?");
    await composer.getByRole("button", { name: "Create card" }).click();

    const reviewTwo = page.getByRole("dialog", { name: "This material is already in Notes" });
    await expect(reviewTwo).toBeVisible();
    await expect(
      reviewTwo.getByRole("list", { name: "Existing material" }).getByRole("listitem")
    ).toHaveCount(2);
    await expect(reviewTwo.getByText("2 cards", { exact: true })).toBeVisible();
    await expect(reviewTwo.getByText("1 card", { exact: true })).toBeVisible();

    await reviewTwo.getByRole("button", { name: "Back" }).click();
    await expect(reviewTwo).toBeHidden();

    // Three review cards are due — note #1's two cards plus the kept-separate note's one — and grading one
    // leaves the others due, proving each is scheduled on its own rather than sharing a per-note contract.
    await page.goto(`${setup.baseURL}#/notes/review`);
    await expect(page.getByRole("heading", { name: "Review" })).toBeVisible();

    await page.getByRole("button", { name: "Show note" }).click();
    await page.getByRole("button", { name: "Good" }).click();
    await expect(page.getByRole("button", { name: "Review next" })).toBeVisible();
    await page.getByRole("button", { name: "Review next" }).click();

    await page.getByRole("button", { name: "Show note" }).click();
    await page.getByRole("button", { name: "Good" }).click();
    await expect(page.getByRole("button", { name: "Review next" })).toBeVisible();
    await page.getByRole("button", { name: "Review next" }).click();

    await page.getByRole("button", { name: "Show note" }).click();
    await page.getByRole("button", { name: "Good" }).click();
    await expect(page.getByText(/Due complete/)).toBeVisible();
  });
});
