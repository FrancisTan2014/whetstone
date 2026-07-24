import { expect, test } from "../fixtures";

// On mobile the revealed reading chrome must read as a proper top bar: the work title sits on the same
// translucent blurred surface as the bottom tools bar, so its background masks the body text beneath
// rather than colliding with it (#343). On desktop the title stays the minimal top-left affordance in
// the column's left margin (no bar surface). These assert the real computed CSS in a browser, where the
// `@media (max-width: 55.999rem)` rule actually applies (jsdom cannot evaluate media queries).

const MOBILE = { height: 844, width: 390 } as const;
const DESKTOP = { height: 900, width: 1280 } as const;
const TRANSPARENT = new Set(["rgba(0, 0, 0, 0)", "transparent"]);
const anyBlock = 'article[aria-label="Reading"] [data-block-id]';

const titleStyle = (el: Element) => {
  const style = getComputedStyle(el);
  return {
    backgroundColor: style.backgroundColor,
    backdropFilter: style.backdropFilter,
    width: el.getBoundingClientRect().width
  };
};

test.describe("reader title bar (#343)", () => {
  test("mobile: the title reads on an opaque, blurred, full-width top bar", async ({ page, setup }) => {
    await page.setViewportSize({ height: MOBILE.height, width: MOBILE.width });
    await page.goto(`${setup.baseURL}#/reader?work=${encodeURIComponent(setup.markdown.entryId)}`);
    await expect(page.locator(anyBlock).first()).toBeVisible();

    const title = page.locator(".readingHeaderTitle");
    await expect(title).toHaveCount(1);
    const style = await title.evaluate(titleStyle);

    // The surface is opaque enough to mask the text beneath (not transparent) and blurred.
    expect(TRANSPARENT.has(style.backgroundColor)).toBe(false);
    expect(style.backdropFilter).toContain("blur");
    // It spans the full viewport width — a top bar, not a left-margin label.
    expect(style.width).toBeGreaterThanOrEqual(MOBILE.width - 1);
  });

  test("desktop: the title stays the minimal top-left affordance with no bar surface", async ({
    page,
    setup
  }) => {
    await page.setViewportSize({ height: DESKTOP.height, width: DESKTOP.width });
    await page.goto(`${setup.baseURL}#/reader?work=${encodeURIComponent(setup.markdown.entryId)}`);
    await expect(page.locator(anyBlock).first()).toBeVisible();

    const style = await page.locator(".readingHeaderTitle").evaluate(titleStyle);

    // Unchanged: no bar background, and it does not span the viewport (it sits in the left margin).
    expect(TRANSPARENT.has(style.backgroundColor)).toBe(true);
    expect(style.width).toBeLessThan(DESKTOP.width);
  });
});
