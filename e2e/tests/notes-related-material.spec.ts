import { expect, test } from "../fixtures";

// Related saved material during New-card creation (#716). Related material is an explicit INSPECTION AID over
// the offline lexical service (#715), never a duplicate/identity decision: a single-word Answer can surface a
// lexically related saved word WITHOUT entering Possible duplicate or sharing a schedule.
//
// This saves `bear` as one note, then drafts `born` and opens Find related material. `born`'s verb lemma is
// `bear`, so selecting the verb sense surfaces the saved `bear` note under the typed reason "same verb lemma"
// (with the "born -> bear . verb" header) — while `born` and `bear` remain SEPARATE notes with independent
// schedules. It then saves `born` separately (related material never blocks or alters the save) and proves two
// notes and two independently-scheduled due cards: grading one leaves the other due. Both are graded away to
// keep the shared review queue clean for the other specs.
test.describe("notes related material", () => {
  test("inspects a related saved word during creation, then saves and schedules it separately", async ({
    page,
    setup
  }) => {
    await page.goto(`${setup.baseURL}#/notes`);
    await expect(page.getByRole("heading", { level: 1, name: "Notes" })).toBeVisible();

    // Save `bear` for the childbirth sense as a standalone single-word note.
    await page.getByRole("button", { name: "New card" }).click();
    const bearComposer = page.getByRole("dialog");
    await bearComposer.getByRole("textbox", { name: "Answer" }).fill("bear");
    await bearComposer
      .getByRole("textbox", { name: "Question" })
      .fill("Which verb means to give birth to a child?");
    await bearComposer.getByRole("button", { name: "Create card" }).click();
    await expect(page.getByText("Card created. Due now.")).toBeVisible();

    // Draft `born` and open the inspection disclosure.
    await page.getByRole("button", { name: "New card" }).click();
    const bornComposer = page.getByRole("dialog");
    await bornComposer.getByRole("textbox", { name: "Answer" }).fill("born");
    await bornComposer
      .getByRole("textbox", { name: "Question" })
      .fill("What is the past participle of bear?");

    await bornComposer.getByRole("button", { name: "Find related material" }).click();

    // No sense is preselected; choose the verb sense explicitly (born's verb lemma is bear).
    await bornComposer.getByRole("radio", { name: /· verb/ }).first().click();

    // The saved `bear` note surfaces under the typed reason for a shared verb lemma — NOT as a duplicate.
    await expect(bornComposer.getByRole("heading", { name: "same verb lemma" })).toBeVisible();
    await expect(bornComposer.getByText(/born\s*→\s*bear\s*·\s*verb/)).toBeVisible();
    await expect(
      bornComposer.getByRole("list", { name: "same verb lemma" }).getByText("bear", { exact: true })
    ).toBeVisible();
    // Related material never enters Possible duplicate or offers Use existing material.
    await expect(bornComposer.getByRole("button", { name: /Use existing material/ })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Possible duplicate" })).toHaveCount(0);

    // Saving proceeds normally — related material never blocks or alters the save — and mints a SEPARATE note.
    await bornComposer.getByRole("button", { name: "Create card" }).click();
    await expect(page.getByText("Card created. Due now.")).toBeVisible();

    // Two separate notes now exist.
    await page.goto(`${setup.baseURL}#/notes`);
    await expect(page.getByRole("button", { name: "Open note: bear" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open note: born" })).toBeVisible();

    // Two independently-scheduled cards are due: grading ONE leaves the OTHER due (no shared schedule).
    await page.goto(`${setup.baseURL}#/notes/review`);
    await expect(page.getByRole("heading", { name: "Review" })).toBeVisible();
    await page.getByRole("button", { name: "Show note" }).click();
    await page.getByRole("button", { name: "Good" }).click();
    await expect(page.getByRole("button", { name: "Review next" })).toBeVisible();

    // Grade the second away too, so the shared queue returns to Due complete for the other specs.
    await page.getByRole("button", { name: "Review next" }).click();
    await page.getByRole("button", { name: "Show note" }).click();
    await page.getByRole("button", { name: "Good" }).click();
    await expect(page.getByText(/Due complete/)).toBeVisible();
  });
});
