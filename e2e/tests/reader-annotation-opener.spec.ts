import { type Page } from "@playwright/test";

import { INTERACTIVE_SELECTOR } from "../probes";
import { type SetupData } from "../stack";
import { expect, test } from "../fixtures";

// Direct annotation activation (#644), reversing the block-level edge opener of #555. The inline
// `span.noteMark` underline IS the annotation's activation target again: clicking, tapping, or
// keyboard-activating it opens THAT exact note's editor (or, only where annotations genuinely overlap,
// a compact chooser scoped to just those annotations). There is no always-visible paragraph pencil and
// no reserved annotation gutter/rail. A bodyless Mark opens its own compact actions directly, and a
// whole-block note (no inline text to underline) stays reachable through the 44px Notes tool/list.
//
// jsdom cannot lay out boxes or dispatch a real browser click/tap chain, so this drives the real
// rendered underline in a browser at both desktop and 390px mobile, seeding works/annotations through
// the API on a dedicated work per test so spec order never interferes.

// Touch is enabled for the whole spec so the tap-to-open path exercises the real pointer chain; it is
// inert for the mouse/keyboard tests.
test.use({ hasTouch: true });

const READING = 'article[aria-label="Reading"]';
const NOTE_MARK = `${READING} span.noteMark`;
const OLD_OPENER = `${READING} .readerBlockOpener`;
const CHOOSER = { name: "Annotations" } as const;
const EDIT_DIALOG = { name: "Edit note" } as const;
const MOBILE = { height: 844, width: 390 } as const;
const DESKTOP = { height: 900, width: 1280 } as const;

// Seed a dedicated work from the given single-paragraph body and return the reader URL plus the
// paragraph block's id and its rendered plaintext (so offsets are computed against exactly what the
// reader lays out, keeping seeded highlights well-anchored rather than needs-repair).
async function seedWork(
  page: Page,
  setup: SetupData,
  title: string,
  body: string
): Promise<{ readerUrl: string; workEntryId: string }> {
  const created = await page.request.post(`${setup.baseURL}api/works`, {
    data: {
      author: { mode: "new", name: `${title} Author` },
      language: "en",
      title,
      workType: "essay"
    }
  });
  expect(created.status()).toBe(201);
  const { work } = (await created.json()) as { work: { entryId: string } };

  const ingest = await page.request.post(
    `${setup.baseURL}api/works/${encodeURIComponent(work.entryId)}/content`,
    { data: { kind: "manual", markdown: `# ${title}\n\n${body}\n` } }
  );
  expect(ingest.ok()).toBe(true);

  const readerUrl = `${setup.baseURL}#/reader?work=${encodeURIComponent(work.entryId)}`;
  await page.goto(readerUrl);
  await expect(page.locator(`${READING} [data-block-id]`).first()).toBeVisible();

  return { readerUrl, workEntryId: work.entryId };
}

// The block id and rendered plaintext of the block whose prose contains `needle` (never the heading).
async function blockContaining(
  page: Page,
  needle: string
): Promise<{ blockEntryId: string; text: string }> {
  const found = (await page.evaluate(
    ([reading, want]) => {
      for (const block of Array.from(document.querySelectorAll(`${reading} [data-block-id]`))) {
        const text = block.textContent ?? "";
        const blockEntryId = block.getAttribute("data-block-id");
        if (blockEntryId !== null && text.includes(want)) {
          return { blockEntryId, text };
        }
      }
      return null;
    },
    [READING, needle] as const
  )) as { blockEntryId: string; text: string } | null;
  expect(found).not.toBeNull();
  return found!;
}

type Anchor = {
  blockEntryId: string;
  contextSnapshot: string;
  endBlockEntryId?: string;
  endOffset?: number;
  selectedTextSnapshot: string;
  startOffset?: number;
};

// Anchor a sub-block note/mark to `word` in the block's plaintext with real offsets, so the reader
// renders an inline `noteMark` underline for it (a whole-block anchor draws no underline at all).
function anchorFor(blockEntryId: string, text: string, word: string): Anchor {
  const startOffset = text.indexOf(word);
  expect(startOffset).toBeGreaterThanOrEqual(0);
  return {
    blockEntryId,
    contextSnapshot: word,
    endOffset: startOffset + word.length,
    selectedTextSnapshot: word,
    startOffset
  };
}

async function addNote(
  page: Page,
  setup: SetupData,
  workEntryId: string,
  anchor: Anchor,
  body: string
): Promise<void> {
  const response = await page.request.post(
    `${setup.baseURL}api/works/${encodeURIComponent(workEntryId)}/notes`,
    {
      data: {
        anchor,
        bodyDoc: {
          content: [{ content: [{ text: body, type: "text" }], type: "paragraph" }],
          type: "doc"
        }
      }
    }
  );
  expect(response.status()).toBe(201);
}

async function addMark(
  page: Page,
  setup: SetupData,
  workEntryId: string,
  anchor: Anchor
): Promise<void> {
  const response = await page.request.post(
    `${setup.baseURL}api/works/${encodeURIComponent(workEntryId)}/marks`,
    { data: { anchor } }
  );
  expect(response.status()).toBe(201);
}

// Force the hash-routed reader to remount so it fetches the freshly seeded annotations.
async function reloadReader(page: Page, readerUrl: string): Promise<void> {
  await page.goto("about:blank");
  await page.goto(readerUrl);
  await expect(page.locator(`${READING} [data-block-id]`).first()).toBeVisible();
}

// The inline underline for exactly `word` (its accessible name names the word), disambiguating an
// underline whose text is a prefix of another (e.g. "Alpha" inside "Alpha bravo").
function underlineFor(page: Page, kind: "mark" | "note", word: string) {
  return page.getByRole("button", { name: `Open ${kind} on '${word}'` });
}

const PARAGRAPH = "Alpha bravo charlie delta echo foxtrot golf hotel india.";

for (const [name, viewport] of [
  ["desktop", DESKTOP],
  ["mobile", MOBILE]
] as const) {
  test(`${name}: the inline underline is the direct target and no pencil or gutter renders`, async ({
    page,
    setup
  }) => {
    await page.setViewportSize({ height: viewport.height, width: viewport.width });

    const work = await seedWork(page, setup, `Direct Target ${name}`, PARAGRAPH);
    const block = await blockContaining(page, "Alpha");
    await addNote(
      page,
      setup,
      work.workEntryId,
      anchorFor(block.blockEntryId, block.text, "Alpha"),
      "The opening word."
    );
    await reloadReader(page, work.readerUrl);

    // The underline is a real, accessibly-named activation target (the reverse of #555's inert span),
    // and it is enumerated by the shared interactive-control selector.
    const underline = underlineFor(page, "note", "Alpha");
    await expect(underline).toBeVisible();
    await expect(underline).toHaveAccessibleName("Open note on 'Alpha'");
    const wiring = await underline.evaluate(
      (span, interactive) => ({
        focusable: (span as HTMLElement).tabIndex >= 0,
        matchesInteractive: span.matches(interactive)
      }),
      INTERACTIVE_SELECTOR
    );
    expect(wiring.matchesInteractive).toBe(true);
    expect(wiring.focusable).toBe(true);

    // No block-level pencil opener and no reserved annotation gutter/rail exist anywhere in the reader.
    await expect(page.locator(OLD_OPENER)).toHaveCount(0);
    await expect(page.locator(`${READING} .readerBlockOpenerGlyph`)).toHaveCount(0);
    const annotatedBlock = page.locator(`${READING} [data-has-notes="true"]`).first();
    await expect(annotatedBlock).toBeVisible();
    const blockClasses = await annotatedBlock.getAttribute("class");
    expect(blockClasses).not.toContain("readerBlock--");
  });

  test(`${name}: clicking a note underline opens that exact note's editor`, async ({
    page,
    setup
  }) => {
    await page.setViewportSize({ height: viewport.height, width: viewport.width });

    const work = await seedWork(page, setup, `Click Opens ${name}`, PARAGRAPH);
    const block = await blockContaining(page, "Alpha");
    await addNote(
      page,
      setup,
      work.workEntryId,
      anchorFor(block.blockEntryId, block.text, "Alpha"),
      "Directly editable note body."
    );
    await reloadReader(page, work.readerUrl);

    await underlineFor(page, "note", "Alpha").click();

    const editor = page.getByRole("dialog", EDIT_DIALOG);
    await expect(editor).toBeVisible();
    await expect(editor.getByText("Directly editable note body.")).toBeVisible();
    // A lone note opens its editor directly — never the chooser.
    await expect(page.getByRole("complementary", CHOOSER)).toHaveCount(0);
  });
}

test("keyboard: focusing a note underline and pressing Enter opens that note", async ({
  page,
  setup
}) => {
  await page.setViewportSize({ height: DESKTOP.height, width: DESKTOP.width });

  const work = await seedWork(page, setup, "Keyboard Opens", PARAGRAPH);
  const block = await blockContaining(page, "Alpha");
  await addNote(
    page,
    setup,
    work.workEntryId,
    anchorFor(block.blockEntryId, block.text, "charlie"),
    "Reached by keyboard."
  );
  await reloadReader(page, work.readerUrl);

  const underline = underlineFor(page, "note", "charlie");
  await underline.focus();
  await expect(underline).toBeFocused();
  await page.keyboard.press("Enter");

  const editor = page.getByRole("dialog", EDIT_DIALOG);
  await expect(editor).toBeVisible();
  await expect(editor.getByText("Reached by keyboard.")).toBeVisible();
});

test("touch: tapping a note underline opens that note", async ({ page, setup }) => {
  await page.setViewportSize({ height: MOBILE.height, width: MOBILE.width });

  const work = await seedWork(page, setup, "Touch Opens", PARAGRAPH);
  const block = await blockContaining(page, "Alpha");
  await addNote(
    page,
    setup,
    work.workEntryId,
    anchorFor(block.blockEntryId, block.text, "Alpha"),
    "Reached by tap."
  );
  await reloadReader(page, work.readerUrl);

  await underlineFor(page, "note", "Alpha").tap();

  const editor = page.getByRole("dialog", EDIT_DIALOG);
  await expect(editor).toBeVisible();
  await expect(editor.getByText("Reached by tap.")).toBeVisible();
});

test("two non-overlapping notes in one paragraph each open their own note, never a chooser", async ({
  page,
  setup
}) => {
  await page.setViewportSize({ height: DESKTOP.height, width: DESKTOP.width });

  const work = await seedWork(page, setup, "Two Notes", PARAGRAPH);
  const block = await blockContaining(page, "Alpha");
  await addNote(
    page,
    setup,
    work.workEntryId,
    anchorFor(block.blockEntryId, block.text, "Alpha"),
    "First note body."
  );
  await addNote(
    page,
    setup,
    work.workEntryId,
    anchorFor(block.blockEntryId, block.text, "charlie"),
    "Second note body."
  );
  await reloadReader(page, work.readerUrl);

  // Each disjoint underline opens exactly its own note; the chooser never appears merely because the
  // paragraph holds several (non-overlapping) notes.
  await underlineFor(page, "note", "Alpha").click();
  let editor = page.getByRole("dialog", EDIT_DIALOG);
  await expect(editor.getByText("First note body.")).toBeVisible();
  await expect(page.getByRole("complementary", CHOOSER)).toHaveCount(0);
  await editor.getByRole("button", { name: "Close" }).click();
  await expect(editor).toBeHidden();

  await underlineFor(page, "note", "charlie").click();
  editor = page.getByRole("dialog", EDIT_DIALOG);
  await expect(editor.getByText("Second note body.")).toBeVisible();
  await expect(page.getByRole("complementary", CHOOSER)).toHaveCount(0);
});

test("genuinely overlapping notes open a chooser scoped to exactly those annotations", async ({
  page,
  setup
}) => {
  await page.setViewportSize({ height: DESKTOP.height, width: DESKTOP.width });

  const work = await seedWork(page, setup, "Overlap Chooser", PARAGRAPH);
  const block = await blockContaining(page, "Alpha");
  // Two notes whose ranges overlap ("Alpha bravo" encloses "Alpha"): their underlines nest, so the
  // covering text belongs to both and activation resolves to a chooser, not one note.
  await addNote(
    page,
    setup,
    work.workEntryId,
    anchorFor(block.blockEntryId, block.text, "Alpha bravo"),
    "Outer note body."
  );
  await addNote(
    page,
    setup,
    work.workEntryId,
    anchorFor(block.blockEntryId, block.text, "Alpha"),
    "Inner note body."
  );
  await reloadReader(page, work.readerUrl);

  // Click the innermost underline (the nested one), where both notes overlap.
  await page.locator(`${NOTE_MARK} span.noteMark`).first().click();

  const chooser = page.getByRole("complementary", CHOOSER);
  await expect(chooser).toBeVisible();
  await expect(chooser.getByText("Outer note body.")).toBeVisible();
  await expect(chooser.getByText("Inner note body.")).toBeVisible();

  // Editing a row targets exactly that annotation (by entryId): the editor shows its body, not the
  // other overlapping note's.
  await chooser.getByRole("button", { name: "Edit note: Alpha bravo" }).click();
  const editor = page.getByRole("dialog", EDIT_DIALOG);
  await expect(editor).toBeVisible();
  await expect(editor.getByText("Outer note body.")).toBeVisible();
});

test("a note underline spanning two blocks opens that note from either block", async ({
  page,
  setup
}) => {
  await page.setViewportSize({ height: DESKTOP.height, width: DESKTOP.width });

  const work = await seedWork(
    page,
    setup,
    "Cross Block",
    "Alpha bravo charlie.\n\nDelta echo foxtrot."
  );
  const first = await blockContaining(page, "Alpha");
  const second = await blockContaining(page, "Delta");
  // A single note anchored from a word in the first paragraph to a word in the second: it underlines
  // the first block's tail and the second block's head, both carrying the same note id.
  await addNote(
    page,
    setup,
    work.workEntryId,
    {
      blockEntryId: first.blockEntryId,
      contextSnapshot: "charlie",
      endBlockEntryId: second.blockEntryId,
      endOffset: second.text.indexOf("Delta") + "Delta".length,
      selectedTextSnapshot: "charlie",
      startOffset: first.text.indexOf("charlie")
    },
    "Cross-block note body."
  );
  await reloadReader(page, work.readerUrl);

  // Two underline fragments render for the one note; activating the fragment in the SECOND block opens
  // that exact note directly (no chooser — it is a single note, only split across blocks).
  const fragments = page.locator(`${READING} span.noteMark[aria-label="Open note on 'charlie'"]`);
  await expect(fragments).toHaveCount(2);
  await fragments.nth(1).click();

  const editor = page.getByRole("dialog", EDIT_DIALOG);
  await expect(editor).toBeVisible();
  await expect(page.getByRole("complementary", CHOOSER)).toHaveCount(0);
});

test("a bodyless mark underline opens its compact actions directly", async ({ page, setup }) => {
  await page.setViewportSize({ height: DESKTOP.height, width: DESKTOP.width });

  const work = await seedWork(page, setup, "Mark Actions", PARAGRAPH);
  const block = await blockContaining(page, "Alpha");
  await addMark(
    page,
    setup,
    work.workEntryId,
    anchorFor(block.blockEntryId, block.text, "charlie")
  );
  await reloadReader(page, work.readerUrl);

  await underlineFor(page, "mark", "charlie").click();

  // A lone bodyless Mark has no editor; activating it opens the compact chooser scoped to just that
  // mark, exposing its own Jump/Delete actions.
  const chooser = page.getByRole("complementary", CHOOSER);
  await expect(chooser).toBeVisible();
  await expect(chooser.getByText("Mark", { exact: true })).toBeVisible();
  await expect(chooser.getByRole("button", { name: "Delete mark: charlie" })).toBeVisible();
  await expect(chooser.getByRole("button", { name: "Jump to text: charlie" })).toBeVisible();
});

test("the Notes tool is an alternate path that opens a whole-block note with no inline underline", async ({
  page,
  setup
}) => {
  await page.setViewportSize({ height: DESKTOP.height, width: DESKTOP.width });

  const work = await seedWork(page, setup, "Notes Panel Path", PARAGRAPH);
  const block = await blockContaining(page, "Alpha");
  // A whole-block anchor (no offsets) draws no inline underline, so its only home is the Notes tool.
  await addNote(
    page,
    setup,
    work.workEntryId,
    {
      blockEntryId: block.blockEntryId,
      contextSnapshot: "Alpha",
      selectedTextSnapshot: "Alpha"
    },
    "Whole-block note body."
  );
  await reloadReader(page, work.readerUrl);

  // No inline underline exists for the whole-block note, but its block is still flagged annotated.
  await expect(page.locator(NOTE_MARK)).toHaveCount(0);
  await expect(page.locator(`${READING} [data-has-notes="true"]`).first()).toBeVisible();

  // The 44px Notes tool opens the list, which reaches the note's editor.
  await page.getByRole("button", { name: "Your notes" }).click();
  await page.getByRole("button", { name: "Edit note: Alpha" }).click();

  const editor = page.getByRole("dialog", EDIT_DIALOG);
  await expect(editor).toBeVisible();
  await expect(editor.getByText("Whole-block note body.")).toBeVisible();
});
