import { geometry } from "../probes";
import { expect, test } from "../fixtures";

// The "Back to Library" link is a primary reader navigation control, so it must expose at least a
// 44px pointer/touch hit target (WCAG 2.5.5) at every width. Before #401 it rendered as a 24px-tall
// text link and the shared geometry probe flagged it `tooSmall`. These assert the real rendered rect
// in a browser, where the CSS actually applies (jsdom cannot lay out or evaluate box geometry).

const BACK_LINK = 'a[aria-label="Back to Library"]';
const MOBILE = { height: 844, width: 390 } as const;
const DESKTOP = { height: 900, width: 1280 } as const;

const rect = (el: Element) => {
  const box = el.getBoundingClientRect();
  return { height: box.height, width: box.width };
};

for (const [name, viewport] of [
  ["desktop", DESKTOP],
  ["mobile", MOBILE]
] as const) {
  test(`${name}: the Back to Library link is a >=44px hit target (#401)`, async ({ page, setup }) => {
    await page.setViewportSize({ height: viewport.height, width: viewport.width });
    await page.goto(`${setup.baseURL}#/reader?work=${encodeURIComponent(setup.markdown.entryId)}`);

    const link = page.locator(BACK_LINK);
    await expect(link).toBeVisible();

    const box = await link.evaluate(rect);
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);

    // The shared geometry probe must not flag the control as too small.
    const result = await page.evaluate(geometry, BACK_LINK);
    const flags = result.issues.flatMap((issue) => issue.flags);
    expect(flags).not.toContain("tooSmall");
  });
}
