import { expect, test } from "../fixtures";

// Inspecting related saved material during New-card creation (#716): the offline lexical service (#715) is
// exposed as an opt-in inspection aid in the composer. Given an eligible single-word Answer, the learner opens
// "Find related material", explicitly picks one WordNet sense (the service never auto-picks), and reads the
// owner's typed related saved Notes. It is PURELY inspection: it never blocks the save, never preselects a
// card, never offers "Use existing material", and persists no relation or sense. This drives the whole flow
// through the UI end to end: it saves a `bear` card so the material exists, drafts `born`, opens the
// disclosure, selects the childbirth verb sense, and proves the disclosure surfaces the saved `bear` note
// under "same verb lemma" — then saves `born` as a SEPARATE card and proves two independent due cards result
// (rating one leaves the other due), i.e. inspection changed nothing about scheduling.
test.describe("notes related material during card creation", () => {
  test("inspects related saved material, then saves a separate independently-scheduled card", async ({
    page,
    setup
  }) => {
    await page.goto(`${setup.baseURL}#/notes`);
    await expect(page.getByRole("heading", { level: 1, name: "Notes" })).toBeVisible();

    // Pass 1 — save a single-word `bear` card. This mints note #1 (body = "bear") with its first due card, so
    // the childbirth-verb material now exists in Notes and can be surfaced as related to a later `born` draft.
    await page.getByRole("button", { name: "New card" }).click();
    let composer = page.getByRole("dialog", { name: "New card" });
    await composer.getByRole("textbox", { name: "Answer" }).fill("bear");
    await composer.getByRole("textbox", { name: "Question" }).fill("What verb means to give birth?");
    await composer.getByRole("button", { name: "Create card" }).click();
    await expect(page.getByText("Card created. Due now.")).toBeVisible();

    // Pass 2 — draft a single-word `born` Answer (an inflected form of `bear`). It is a distinct word from the
    // saved material, so no duplicate/near review fires; the composer stays open with the draft intact and the
    // opt-in "Find related material" disclosure available for this eligible surface.
    await page.getByRole("button", { name: "New card" }).click();
    composer = page.getByRole("dialog", { name: "New card" });
    await composer.getByRole("textbox", { name: "Answer" }).fill("born");
    await composer.getByRole("textbox", { name: "Question" }).fill("What is the past participle of bear?");

    // The disclosure is collapsed and makes no request until the learner opens it. Opening it lists WordNet
    // senses for explicit selection — no related note is shown before a sense is chosen.
    const related = composer.getByRole("region", { name: "Find related material" });
    await related.getByRole("button", { name: "Find related material" }).click();
    await expect(related.getByText("Choose a meaning to inspect related notes:")).toBeVisible();
    await expect(related.getByText("born → bear · verb")).toHaveCount(0);

    // Select the childbirth VERB sense explicitly. `born` lemmatizes to `bear` under any verb sense, so the
    // saved `bear` note is surfaced under the typed "same verb lemma" (inflection) reason, with a header that
    // names the surface, the selected lemma, and its part of speech — never a score, never a preselected card.
    await related.getByRole("button", { name: /cause to be born/ }).click();
    await expect(related.getByText("born → bear · verb")).toBeVisible();
    await expect(related.getByText("same verb lemma")).toBeVisible();
    await expect(related.getByText("bear", { exact: true })).toBeVisible();
    // Inspection only: the disclosure offers "Open note" but never a save-affecting "Use existing material".
    await expect(related.getByRole("link", { name: "Open note" })).toBeVisible();
    await expect(related.getByRole("button", { name: /Use existing material/ })).toHaveCount(0);

    // Saving is untouched by inspection: create `born` as a SEPARATE card. This mints note #2 with its own due
    // card — nothing was reused or merged — so Notes now owns two independently-scheduled cards.
    await composer.getByRole("button", { name: "Create card" }).click();
    await expect(page.getByText("Card created. Due now.")).toBeVisible();

    // Prove the two cards schedule independently: rate the first earliest-due prompt `good`, and a second
    // prompt is still due (the other card), confirming inspection created no hidden link between them. Then
    // drain the shared review queue back to "nothing due" for the rest of the serial suite (workers: 1, one
    // shared DEFAULT_USER_ID), exactly as the sibling notes specs do.
    const firstNext = await page.request.get(`${setup.baseURL}api/notes/review/next`);
    expect(firstNext.ok()).toBe(true);
    const firstPrompt = ((await firstNext.json()) as { prompt: { promptId: string } | null }).prompt;
    expect(firstPrompt).not.toBeNull();
    const firstRated = await page.request.post(
      `${setup.baseURL}api/notes/review/prompts/${encodeURIComponent(
        (firstPrompt as { promptId: string }).promptId
      )}/rating`,
      { data: { rating: "good" } }
    );
    expect(firstRated.ok()).toBe(true);

    const secondNext = await page.request.get(`${setup.baseURL}api/notes/review/next`);
    expect(secondNext.ok()).toBe(true);
    const secondPrompt = ((await secondNext.json()) as { prompt: { promptId: string } | null })
      .prompt;
    expect(secondPrompt).not.toBeNull();

    for (let drained = 0; drained < 10; drained += 1) {
      const nextResponse = await page.request.get(`${setup.baseURL}api/notes/review/next`);
      expect(nextResponse.ok()).toBe(true);
      const { prompt } = (await nextResponse.json()) as { prompt: { promptId: string } | null };
      if (prompt === null) {
        break;
      }
      const rated = await page.request.post(
        `${setup.baseURL}api/notes/review/prompts/${encodeURIComponent(prompt.promptId)}/rating`,
        { data: { rating: "good" } }
      );
      expect(rated.ok()).toBe(true);
    }

    const settled = await page.request.get(`${setup.baseURL}api/notes/review/next`);
    expect(settled.ok()).toBe(true);
    expect(((await settled.json()) as { prompt: unknown }).prompt).toBeNull();
  });
});
