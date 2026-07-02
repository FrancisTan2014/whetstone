import { geometry } from "../probes";
import { expect, test } from "../fixtures";
import { selectWordIn } from "../select";

// The block-notes panel's Close control is a primary dismiss action, so it must expose at least a 44px
// touch target (WCAG 2.5.5). Before #413 it rendered as an unstyled text button — 38.3x24px on a 390px
// mobile viewport — and the shared geometry probe flagged it `tooSmall`. This asserts the real rendered
// rect in a browser, where the CSS actually applies (jsdom cannot lay out or evaluate box geometry).

const anyBlock = 'article[aria-label="Reading"] [data-block-id]';
const blockWithParagraph = 'article[aria-label="Reading"] [data-block-id]:has(p)';
const CLOSE = 'aside[aria-label="Block notes"] button.readerBlockNotesClose';
const MOBILE = { height: 844, width: 390 } as const;

const rect = (el: Element) => {
  const box = el.getBoundingClientRect();
  return { height: box.height, width: box.width };
};

test("mobile: the block-notes panel Close button is a >=44px hit target (#413)", async ({
  page,
  setup
}) => {
  await page.setViewportSize({ height: MOBILE.height, width: MOBILE.width });
  await page.goto(`${setup.baseURL}#/reader?work=${encodeURIComponent(setup.markdown.entryId)}`);
  await expect(page.locator(anyBlock).first()).toBeVisible();

  // Annotate a paragraph, then open the annotated block's note panel by clicking its highlight.
  await selectWordIn(page, blockWithParagraph);
  await expect(page.getByRole("toolbar", { name: "Annotate selection" })).toBeVisible();
  await page.getByRole("button", { name: "Add note" }).click();
  const editor = page.getByRole("dialog");
  await expect(editor).toBeVisible();
  await editor.locator("textarea, input[type=text]").first().fill("Touch-target note.");
  await page.getByRole("button", { name: "Save note" }).click();

  await page.locator("[data-note-id]").first().click();
  const closeButton = page.locator(CLOSE);
  await expect(closeButton).toBeVisible();

  const box = await closeButton.evaluate(rect);
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.width).toBeGreaterThanOrEqual(44);

  // The shared geometry probe must not flag the control as too small.
  const result = await page.evaluate(geometry, CLOSE);
  const flags = result.issues.flatMap((issue) => issue.flags);
  expect(flags).not.toContain("tooSmall");
});
