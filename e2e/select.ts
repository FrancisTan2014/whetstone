import { expect, type Page } from "@playwright/test";

// Apply a block style (Text / Heading 1-3 / Quote / Code block) through the Work editor's persistent
// "Formatting" toolbar. The single "Block style" menu replaced the former per-style buttons (#791): open
// the menu from its trigger, then choose the style. The menu content is portaled, so the item is queried
// at page scope, not inside the toolbar.
export async function chooseBlockStyle(page: Page, style: string): Promise<void> {
  const toolbar = page.getByRole("toolbar", { exact: true, name: "Formatting" });
  await expect(toolbar).toBeVisible();
  await toolbar.getByRole("button", { name: "Block style" }).click();
  await page.getByRole("menuitem", { exact: true, name: style }).click();
  // The menu closes asynchronously and, on close, returns focus to the editor (restoring the selection).
  // Wait for it to be gone so a following selection/keystroke lands in the editor, not the closing menu.
  await expect(page.getByRole("menu", { name: "Block style" })).toBeHidden();
}

// Select the first real word (>= 4 letters) inside the given reader block and raise `mouseup`, the
// way a user dragging across text does, so the reader's selection handler opens the toolbar. Driven
// in-page because text selection is a browser-only DOM operation.
export async function selectWordIn(page: Page, blockSelector: string): Promise<void> {
  await page.locator(blockSelector).first().waitFor();
  await page.locator(blockSelector).first().evaluate((block) => {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node !== null && (node.textContent ?? "").trim().length < 4) {
      node = walker.nextNode();
    }
    if (node === null) {
      throw new Error("no selectable text node in block");
    }
    const text = node.textContent ?? "";
    const match = text.match(/[A-Za-z]{4,}/);
    if (match === null) {
      throw new Error("no word to select in block");
    }
    const start = text.indexOf(match[0]);
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + match[0].length);
    const selection = window.getSelection();
    if (selection === null) {
      throw new Error("no selection available");
    }
    selection.removeAllRanges();
    selection.addRange(range);
    block.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
}

// Select the EXACT literal substring `target` inside the given reader block (an explicit drag, not a
// collapsed tap), then raise `mouseup` the way a real drag-selection does. Unlike `selectWordIn` (ASCII
// `[A-Za-z]{4,}` only), this matches any Unicode substring verbatim — including CJK, where an explicit
// drag range is captured as-is (`selectionCapture.ts` only snaps a COLLAPSED tap to a segmented word),
// so this is what lets the semantic-lookup E2E suite drive exact English and Chinese selections deterministically.
export async function selectExactTextIn(
  page: Page,
  blockSelector: string,
  target: string
): Promise<void> {
  await page.locator(blockSelector).first().waitFor();
  await page.locator(blockSelector).first().evaluate((block, wanted) => {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node !== null) {
      const text = node.textContent ?? "";
      const start = text.indexOf(wanted);
      if (start !== -1) {
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + wanted.length);
        const selection = window.getSelection();
        if (selection === null) {
          throw new Error("no selection available");
        }
        selection.removeAllRanges();
        selection.addRange(range);
        block.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        return;
      }
      node = walker.nextNode();
    }
    throw new Error(`text "${wanted}" not found as a single text node in block`);
  }, target);
}
