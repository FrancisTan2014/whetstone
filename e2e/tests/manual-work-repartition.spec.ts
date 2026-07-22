import { type Page } from "@playwright/test";

import { type SetupData } from "../stack";
import { expect, test } from "../fixtures";

// The manual-Work heading repartition journey (#698): type a multi-heading "book" into ONE editor
// section, prove that on save the block stream is partitioned into bounded ReadingUnits at every heading
// (no manual TOC builder, no whole-Work editor) and that the Reader TOC shows the same hierarchy. Then
// anchor a note and a saved reading position to a block inside a middle section, remove that section's
// heading so it MERGES into the preceding unit, and prove the note and the reading position follow their
// block to the surviving unit while the Outline and Reader TOC realign — reloaded at the same text. jsdom
// cannot drive the ProseMirror save/repartition transactions, lay out the Reader TOC tree, or render the
// note underline, so this proves the whole loop in a real browser.

const READING = 'article[aria-label="Reading"]';
const DESKTOP = { height: 900, width: 1280 } as const;

async function createManualWork(page: Page, setup: SetupData, title: string): Promise<string> {
  const created = await page.request.post(`${setup.baseURL}api/works`, {
    data: {
      author: { mode: "new", name: `${title} Author` },
      language: "en",
      origin: "manual",
      title,
      workType: "book"
    }
  });
  expect(created.status()).toBe(201);
  const { work } = (await created.json()) as { work: { entryId: string } };
  return work.entryId;
}

// The block id of the reader block whose rendered plaintext contains `needle` (never a heading block).
// The stable PM node id (the reader's `data-block-id`, and the anchor target for notes/positions) of the
// block in `unitEntryId` whose plaintext contains `needle`. Read from the unit-content API rather than the
// reader DOM because the reader renders one unit at a time.
function plaintextOf(node: unknown): string {
  const record = node as { content?: ReadonlyArray<unknown>; text?: string };
  if (typeof record.text === "string") {
    return record.text;
  }
  return (record.content ?? []).map(plaintextOf).join("");
}

async function blockInUnit(
  page: Page,
  setup: SetupData,
  workEntryId: string,
  unitEntryId: string,
  needle: string
): Promise<string> {
  const response = await page.request.get(
    `${setup.baseURL}api/works/${encodeURIComponent(workEntryId)}/units/${encodeURIComponent(unitEntryId)}/content`
  );
  expect(response.ok()).toBe(true);
  const { docBlocks } = (await response.json()) as {
    docBlocks?: ReadonlyArray<{ entryId: string; node: unknown }>;
  };
  const match = (docBlocks ?? []).find((block) => plaintextOf(block.node).includes(needle));
  expect(match, `block containing "${needle}" in unit ${unitEntryId}`).toBeDefined();
  return match!.entryId;
}

type Section = { headingLevel?: number; title?: string; unitEntryId: string };

async function fetchSections(page: Page, setup: SetupData, workEntryId: string): Promise<Section[]> {
  const response = await page.request.get(
    `${setup.baseURL}api/manual-works/${encodeURIComponent(workEntryId)}`
  );
  expect(response.ok()).toBe(true);
  const { sections } = (await response.json()) as { sections: Section[] };
  return sections;
}

function unitOf(sections: Section[], title: string): string {
  const section = sections.find((candidate) => candidate.title === title);
  expect(section, `section titled "${title}"`).toBeDefined();
  return section!.unitEntryId;
}

test("repartition a typed multi-heading book, then merge a section while its note and reading position follow the block", async ({
  page,
  setup
}) => {
  await page.setViewportSize({ height: DESKTOP.height, width: DESKTOP.width });

  const title = "Manual repartition";
  const workEntryId = await createManualWork(page, setup, title);

  await page.goto(`${setup.baseURL}#/library/works/${encodeURIComponent(workEntryId)}/edit`);
  const editor = page.getByRole("textbox", { name: `Edit ${title}` });
  await expect(editor).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Saved");
  const toolbar = page.getByRole("toolbar", { exact: true, name: "Formatting" });
  const outline = page.getByRole("navigation", { name: "Outline" });

  // Type a whole three-heading "book" into the single seeded section as ordinary paragraphs, then convert
  // the three title lines into headings. (This editor's heading is a block command bound to the caret's
  // block, and clicking a toolbar button moves focus off the editor, so headings are applied after all the
  // text is typed by clicking each title line to place the caret before toggling.)
  await editor.click();
  await page.keyboard.type("Part One");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Alpha body.");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Chapter One");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Beta body.");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Chapter Two");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Gamma body.");

  await editor.getByText("Part One", { exact: true }).click();
  await toolbar.getByRole("button", { name: "Heading 1" }).click();
  await editor.getByText("Chapter One", { exact: true }).click();
  await toolbar.getByRole("button", { name: "Heading 2" }).click();
  await editor.getByText("Chapter Two", { exact: true }).click();
  await toolbar.getByRole("button", { name: "Heading 2" }).click();
  await expect(editor.locator("h1")).toContainText("Part One");
  await expect(editor.locator("h2")).toHaveCount(2);

  // Live draft Outline: the three headings project into bounded sections BEFORE any save.
  await expect(outline.getByRole("button", { name: "Part One" })).toBeVisible();
  await expect(outline.getByRole("button", { name: "Chapter One" })).toBeVisible();
  await expect(outline.getByRole("button", { name: "Chapter Two" })).toBeVisible();

  await page.getByRole("button", { exact: true, name: "Save" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved");

  // After the repartition the persisted Outline is three bounded sections with the heading hierarchy.
  const nodes = outline.locator("li.workOutlineNode");
  await expect(nodes).toHaveCount(3);
  await expect(nodes.nth(0)).toHaveAttribute("data-depth", "0");
  await expect(nodes.nth(0)).toContainText("Part One");
  await expect(nodes.nth(1)).toHaveAttribute("data-depth", "1");
  await expect(nodes.nth(1)).toContainText("Chapter One");
  await expect(nodes.nth(2)).toHaveAttribute("data-depth", "1");
  await expect(nodes.nth(2)).toContainText("Chapter Two");

  // Capture the reconciled unit ids and the persisted block id of Chapter One's body, so the note and the
  // saved reading position can anchor to a block that will MOVE units when Chapter One merges away.
  const sections = await fetchSections(page, setup, workEntryId);
  const partOneUnit = unitOf(sections, "Part One");
  const chapterOneUnit = unitOf(sections, "Chapter One");
  const betaBlockId = await blockInUnit(page, setup, workEntryId, chapterOneUnit, "Beta body.");

  // Anchor a note and a saved reading position to Chapter One's body block.
  const noteResponse = await page.request.post(
    `${setup.baseURL}api/works/${encodeURIComponent(workEntryId)}/notes`,
    {
      data: {
        anchor: {
          blockEntryId: betaBlockId,
          contextSnapshot: "Beta",
          endOffset: 4,
          selectedTextSnapshot: "Beta",
          startOffset: 0
        },
        bodyDoc: {
          content: [{ content: [{ text: "A note on Beta.", type: "text" }], type: "paragraph" }],
          type: "doc"
        }
      }
    }
  );
  expect(noteResponse.status()).toBe(201);

  const positionResponse = await page.request.put(
    `${setup.baseURL}api/works/${encodeURIComponent(workEntryId)}/reading-position`,
    { data: { anchorBlockEntryId: betaBlockId, unitEntryId: chapterOneUnit } }
  );
  expect(positionResponse.status()).toBe(204);

  // Back in the editor, open Chapter One and remove its heading (demote to a paragraph) so its leading
  // boundary disappears — on save the section MERGES into the preceding Part One unit.
  await page.goto("about:blank");
  await page.goto(`${setup.baseURL}#/library/works/${encodeURIComponent(workEntryId)}/edit`);
  const editor2 = page.getByRole("textbox", { name: `Edit ${title}` });
  await expect(editor2).toBeVisible();
  const toolbar2 = page.getByRole("toolbar", { exact: true, name: "Formatting" });
  const outline2 = page.getByRole("navigation", { name: "Outline" });

  await outline2.getByRole("button", { name: "Chapter One" }).click();
  await expect(editor2.locator("h2")).toContainText("Chapter One");
  await editor2.locator("h2").click();
  await toolbar2.getByRole("button", { name: "Paragraph" }).click();
  await expect(editor2.locator("h2")).toHaveCount(0);
  await page.getByRole("button", { exact: true, name: "Save" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved");

  // Focus follows the server-reconciled unit: Chapter One is gone and Part One is active.
  await expect(outline2.getByRole("button", { name: "Chapter One" })).toHaveCount(0);
  await expect(outline2.getByRole("button", { name: "Part One" })).toHaveAttribute(
    "aria-current",
    "true"
  );
  await expect(outline2.getByRole("button", { name: "Chapter Two" })).toBeVisible();

  // The anchored reading position followed its block into the surviving Part One unit — the anchor block
  // is unchanged and the unit is now Part One, never silently dropped.
  const positionAfter = await page.request.get(
    `${setup.baseURL}api/works/${encodeURIComponent(workEntryId)}/reading-position`
  );
  expect(positionAfter.ok()).toBe(true);
  expect((await positionAfter.json()) as unknown).toEqual({
    position: { anchorBlockEntryId: betaBlockId, unitEntryId: partOneUnit }
  });

  // Reload the Reader: the note still renders on its block (same text), and the TOC now nests only
  // Part One > Chapter Two — Chapter One merged away.
  await page.goto("about:blank");
  await page.goto(`${setup.baseURL}#/reader?work=${encodeURIComponent(workEntryId)}`);
  await expect(page.locator(`${READING} [data-block-id]`).first()).toBeVisible();
  await expect(page.locator(`${READING}`)).toContainText("Beta body.");
  await expect(page.locator(`${READING} span.noteMark`).first()).toBeVisible();

  await page.getByRole("button", { name: "Table of contents" }).click();
  const toc = page.getByRole("navigation", { name: "Table of Contents" });
  await expect(toc.getByRole("button", { exact: true, name: "Part One" })).toBeVisible();
  await toc.getByRole("button", { name: "Expand Part One" }).click();
  await expect(toc.getByRole("button", { exact: true, name: "Chapter Two" })).toBeVisible();
  await expect(toc.getByRole("button", { exact: true, name: "Chapter One" })).toHaveCount(0);
});
