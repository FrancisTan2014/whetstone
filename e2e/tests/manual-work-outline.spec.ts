import { type Page } from "@playwright/test";

import { type SetupData } from "../stack";
import { chooseBlockStyle } from "../select";
import { expect, test } from "../fixtures";

// The manual-Work live Outline journey (#697): build a real Part/Chapter/Section hierarchy out of ordered
// sections in the responsive editor, prove the live Outline (derived only from the persisted heading
// blocks) reflects it, navigate between distant sections through the Outline, exercise the narrow-viewport
// drawer (open, select-to-dismiss, Escape restores focus), and finally prove the Reader shows the SAME
// persisted hierarchy in its table of contents. jsdom cannot lay out the sticky sidebar vs. drawer, run
// the real pointer chain, or drive the ProseMirror save/reload transactions, so this proves the whole loop
// in the actual browser at both a desktop and a narrow viewport.

const READING = 'article[aria-label="Reading"]';
const DESKTOP = { height: 900, width: 1280 } as const;
const NARROW = { height: 851, width: 393 } as const;

async function createManualWork(page: Page, setup: SetupData, title: string): Promise<string> {
  const created = await page.request.post(`${setup.baseURL}api/works/manual`, {
    data: {
      author: { mode: "new", name: `${title} Author` },
      language: "en",
      title,
      workType: "book"
    }
  });
  expect(created.status()).toBe(201);
  const { result } = (await created.json()) as { result: { work: { entryId: string } } };
  return result.work.entryId;
}

test("build a Part/Chapter/Section hierarchy, navigate distant sections, and read the same hierarchy", async ({
  page,
  setup
}) => {
  await page.setViewportSize({ height: DESKTOP.height, width: DESKTOP.width });

  const title = "Manual outline";
  const workEntryId = await createManualWork(page, setup, title);

  await page.goto(`${setup.baseURL}#/library/works/${encodeURIComponent(workEntryId)}/edit`);
  const editor = page.getByRole("textbox", { name: `Edit ${title}` });
  await expect(editor).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Saved");
  const outline = page.getByRole("navigation", { name: "Outline" });

  // Section 1: turn the opening block into a level-1 "Part One" heading and save.
  await editor.click();
  await page.keyboard.type("Part One");
  await page.keyboard.press("ControlOrMeta+a");
  await chooseBlockStyle(page, "Heading 1");
  await expect(editor.locator("h1")).toContainText("Part One");
  await page.getByRole("button", { exact: true, name: "Save" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved");
  // A single-section Work has no useful outline yet — it reserves no sidebar track, so section creation is
  // a single proper action above the canvas instead of an empty Outline.
  await expect(outline).toBeHidden();
  await expect(page.getByRole("button", { name: "Add section after current" })).toBeVisible();

  // Section 2: add a section, name its seeded heading, and demote it to level 2 ("Chapter One").
  await page.getByRole("button", { name: "Add section after current" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved");
  await editor.locator("h1").click();
  await page.keyboard.type("Chapter One");
  await chooseBlockStyle(page, "Heading 2");
  await expect(editor.locator("h2")).toContainText("Chapter One");
  await page.getByRole("button", { exact: true, name: "Save" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved");
  await expect(
    outline.getByRole("button", { exact: true, name: "Chapter One" })
  ).toBeVisible();

  // Add a same-level Chapter Two from Chapter One. The server derives Heading 2 and places it after the
  // active branch; no heading-level repair is needed in the editor.
  await outline.getByRole("button", { name: "Add next section after Chapter One" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved");
  await expect(editor).toBeFocused();
  await page.keyboard.type("Chapter Two");
  await page.getByRole("button", { exact: true, name: "Save" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved");

  // Return to Chapter One and add a child. The contextual action creates Heading 3 and inserts it before
  // Chapter Two as the last child of Chapter One.
  await outline.getByRole("button", { exact: true, name: "Chapter One" }).click();
  await outline.getByRole("button", { name: "Add subsection under Chapter One" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved");
  await expect(editor).toBeFocused();
  await page.keyboard.type("Section One");
  await expect(editor.locator("h3")).toContainText("Section One");
  await page.getByRole("button", { exact: true, name: "Save" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved");

  // The live Outline reflects dense depth-first order: Part One > Chapter One > Section One, then Chapter Two.
  const nodes = outline.locator("li.workOutlineNode");
  await expect(nodes).toHaveCount(4);
  await expect(nodes.nth(0)).toHaveAttribute("data-depth", "0");
  await expect(nodes.nth(0)).toContainText("Part One");
  await expect(nodes.nth(1)).toHaveAttribute("data-depth", "1");
  await expect(nodes.nth(1)).toContainText("Chapter One");
  await expect(nodes.nth(2)).toHaveAttribute("data-depth", "2");
  await expect(nodes.nth(2)).toContainText("Section One");
  await expect(nodes.nth(3)).toHaveAttribute("data-depth", "1");
  await expect(nodes.nth(3)).toContainText("Chapter Two");
  await expect(outline.getByRole("button", { exact: true, name: "Section One" })).toHaveAttribute(
    "aria-current",
    "true"
  );
  // The whole ancestor path is highlighted, not just the exact section (#697 active-path requirement).
  await expect(outline.getByRole("button", { exact: true, name: "Section One" })).toHaveAttribute(
    "data-active-path",
    "true"
  );
  await expect(outline.getByRole("button", { exact: true, name: "Chapter One" })).toHaveAttribute(
    "data-active-path",
    "true"
  );
  await expect(outline.getByRole("button", { exact: true, name: "Part One" })).toHaveAttribute(
    "data-active-path",
    "true"
  );
  await outline.getByRole("button", { exact: true, name: "Part One" }).click();
  await expect(editor.locator("h1")).toContainText("Part One");
  await expect(editor.locator("h2")).toHaveCount(0);
  await expect(editor.locator("h3")).toHaveCount(0);
  await expect(outline.getByRole("button", { exact: true, name: "Part One" })).toHaveAttribute(
    "aria-current",
    "true"
  );

  // ...and back to the far section: navigation resolves only persisted content, never a stale draft.
  await outline.getByRole("button", { exact: true, name: "Section One" }).click();
  await expect(editor.locator("h3")).toContainText("Section One");
  await expect(outline.getByRole("button", { exact: true, name: "Section One" })).toHaveAttribute(
    "aria-current",
    "true"
  );

  // Narrow viewport: the sidebar collapses to a single 44px control that opens a full-height drawer.
  await page.setViewportSize({ height: NARROW.height, width: NARROW.width });
  await page.goto("about:blank");
  await page.goto(`${setup.baseURL}#/library/works/${encodeURIComponent(workEntryId)}/edit`);
  const narrowEditor = page.getByRole("textbox", { name: `Edit ${title}` });
  await expect(narrowEditor).toBeVisible();
  const toggle = page.getByRole("button", { exact: true, name: "Outline" });
  await toggle.click();
  const drawer = page.getByRole("navigation", { name: "Outline" });
  await expect(
    drawer.getByRole("button", { exact: true, name: "Chapter One" })
  ).toBeVisible();

  // Selecting a section closes the drawer and loads it (focus moves into the editor, so no restore).
  await drawer.getByRole("button", { exact: true, name: "Section One" }).click();
  await expect(narrowEditor.locator("h3")).toContainText("Section One");

  // Reopening then Escape dismisses the drawer and restores focus to the control that opened it.
  await toggle.click();
  await expect(drawer.getByRole("button", { exact: true, name: "Part One" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(toggle).toBeFocused();

  // The Reader consumes the same stored blocks and derives the SAME hierarchy in its table of contents.
  await page.setViewportSize({ height: DESKTOP.height, width: DESKTOP.width });
  await page.goto(`${setup.baseURL}#/reader?work=${encodeURIComponent(workEntryId)}`);
  await expect(page.locator(`${READING} [data-block-id]`).first()).toBeVisible();
  await expect(page.locator(`${READING} h1`)).toContainText("Part One");

  await page.getByRole("button", { name: "Table of contents" }).click();
  const toc = page.getByRole("navigation", { name: "Table of Contents" });

  // The derived TOC is a collapsible tree rooted at Part One; expanding reveals Chapter One, then
  // Section One — proving the reader nests exactly the parent/child hierarchy the editor Outline showed.
  await expect(toc.getByRole("button", { exact: true, name: "Part One" })).toBeVisible();
  await expect(toc.getByRole("button", { exact: true, name: "Chapter One" })).toHaveCount(0);

  await toc.getByRole("button", { name: "Expand Part One" }).click();
  await expect(toc.getByRole("button", { exact: true, name: "Chapter One" })).toBeVisible();
  await expect(toc.getByRole("button", { exact: true, name: "Chapter Two" })).toBeVisible();
  await expect(toc.getByRole("button", { exact: true, name: "Section One" })).toHaveCount(0);

  await toc.getByRole("button", { name: "Expand Chapter One" }).click();
  await expect(toc.getByRole("button", { exact: true, name: "Section One" })).toBeVisible();

  // The persisted depths match the editor Outline (root Part, nested Chapter, deeper Section).
  await expect(
    toc.locator('li.readerTocNode:has(> div.readerTocRow:has-text("Part One"))')
  ).toHaveAttribute("data-depth", "0");
  await expect(
    toc.locator('li.readerTocNode:has(> div.readerTocRow:has-text("Chapter One"))')
  ).toHaveAttribute("data-depth", "1");
  await expect(
    toc.locator('li.readerTocNode:has(> div.readerTocRow:has-text("Section One"))')
  ).toHaveAttribute("data-depth", "2");
  await expect(
    toc.locator('li.readerTocNode:has(> div.readerTocRow:has-text("Chapter Two"))')
  ).toHaveAttribute("data-depth", "1");
});
