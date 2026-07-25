import { expect, test } from "../fixtures";

// Reviewing near-duplicate Note material before card creation (#714): a New-card save whose Answer is not an
// exact copy but is a high-precision NEAR match of existing material (#713) is reviewed too, under a SEPARATE
// "Possible duplicate" group. It reuses the exact feature's reviewed command + attempt lifecycle (#712): the
// learner keeps the full draft and authoritatively decides — Use existing material adds the drafted contract
// to the near note (#688), Keep separate mints a distinct note. This drives the whole flow through the UI: it
// mints a first direct card, then drafts a spelling variant of the SAME Answer to trigger the near review,
// proving the panel shows the factual word difference (never a score), reuse grows ONE note to TWO cards, and
// genuinely unrelated material is not falsely warned.
test.describe("notes near-duplicate material review", () => {
  test("surfaces a possible-duplicate near match with factual differences, then reuses it", async ({
    page,
    setup
  }) => {
    const seedAnswer = "in term of the design";
    const nearAnswer = "in terms of the design";

    await page.goto(`${setup.baseURL}#/notes`);
    await expect(page.getByRole("heading", { level: 1, name: "Notes" })).toBeVisible();

    // Pass 1 — mint the first direct card. This creates note #1 (body = the Answer) with its first card, so
    // the material now exists in Notes and a later spelling variant must be reviewed as a near match.
    await page.getByRole("button", { name: "New card" }).click();
    let composer = page.getByRole("dialog", { name: "New card" });
    await composer.getByRole("textbox", { name: "Answer" }).fill(seedAnswer);
    await composer
      .getByRole("textbox", { name: "Question" })
      .fill("How was the plan judged, take one?");
    await composer.getByRole("button", { name: "Create card" }).click();
    await expect(page.getByText("Card created. Due now.")).toBeVisible();

    // Pass 2 — draft a spelling variant (`term` -> `terms`) of the SAME material. This is NOT an exact copy,
    // so the save is authoritatively reviewed under the "Possible duplicate" group: the full draft is kept and
    // the panel surfaces the one near candidate with the concrete word difference, never a similarity score.
    await page.getByRole("button", { name: "New card" }).click();
    composer = page.getByRole("dialog", { name: "New card" });
    await composer.getByRole("textbox", { name: "Answer" }).fill(nearAnswer);
    await composer
      .getByRole("textbox", { name: "Question" })
      .fill("How was the plan judged, take two?");
    await composer.getByRole("button", { name: "Create card" }).click();

    const review = page.getByRole("dialog", { name: "Possible duplicate" });
    await expect(review).toBeVisible();
    // The near candidate lives in its own "Possible duplicate" list, distinct from the exact "Existing
    // material" list, and it exposes the factual wording difference the learner compares — with no score.
    const nearList = review.getByRole("list", { name: "Possible duplicate" });
    await expect(nearList.locator("> li")).toHaveCount(1);
    await expect(review.getByRole("list", { name: "Wording differences" })).toBeVisible();
    await expect(review.getByText("term → terms")).toBeVisible();
    await expect(review.getByText(/%/)).toHaveCount(0);
    await expect(review.getByRole("list", { name: "Existing material" })).toHaveCount(0);

    // Use existing material — add the drafted contract to that near note via #688's canonical writer. It is
    // reused, not created: success announces the reuse and no second note is minted, so note #1 now owns two
    // independently-scheduled cards.
    await review.getByRole("button", { name: /Use existing material/ }).click();
    await expect(page.getByText("Card added to existing note. Due now.")).toBeVisible();

    // Safely-silent cases add NO warning: a draft that only differs from existing material by protected
    // evidence — a number, a negation, a distinct word, or letter case alone — is high precision, so it is
    // created directly with no review. Each pair seeds one phrase, then drafts its "never warn" variant and
    // proves the save creates straight through. (Exact material is case-sensitive and the near matcher vetoes
    // number/negation/word/case-only differences, so neither group fires — this is #713's policy, exercised
    // end to end.)
    const neverWarns = async (seed: string, variant: string, key: string): Promise<void> => {
      for (const [answer, index] of [
        [seed, 0],
        [variant, 1]
      ] as const) {
        await page.getByRole("button", { name: "New card" }).click();
        const draft = page.getByRole("dialog", { name: "New card" });
        await draft.getByRole("textbox", { name: "Answer" }).fill(answer);
        await draft.getByRole("textbox", { name: "Question" }).fill(`Recall ${key} ${index}?`);
        await draft.getByRole("button", { name: "Create card" }).click();
        // A direct create closes the composer with the created toast; no review dialog is ever raised.
        await expect(page.getByText("Card created. Due now.")).toBeVisible();
        await expect(page.getByRole("dialog", { name: "Possible duplicate" })).toBeHidden();
        await expect(
          page.getByRole("dialog", { name: "This material is already in Notes" })
        ).toBeHidden();
      }
    };

    await neverWarns(
      "The download archive is 10 MB in size",
      "The download archive is 100 MB in size",
      "size"
    );
    await neverWarns(
      "This configuration is safe to enable",
      "This configuration is not safe to enable",
      "safety"
    );
    await neverWarns("A grizzly is a large bear", "A grizzly is a large born", "grizzly");
    await neverWarns("Alpha Beta Gamma Delta Epsilon", "alpha beta gamma delta epsilon", "greek");

    // A genuinely unrelated Answer likewise shares no material and is created directly with no review — the
    // near warning is high precision, not a blanket "looks a bit similar" nag.
    await page.getByRole("button", { name: "New card" }).click();
    composer = page.getByRole("dialog", { name: "New card" });
    await composer
      .getByRole("textbox", { name: "Answer" })
      .fill("Mango trees can live for several hundred years");
    await composer.getByRole("textbox", { name: "Question" }).fill("How long do mango trees live?");
    await composer.getByRole("button", { name: "Create card" }).click();
    await expect(page.getByText("Card created. Due now.")).toBeVisible();
  });
});
