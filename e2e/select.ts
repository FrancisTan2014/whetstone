import { type Page } from "@playwright/test";

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
