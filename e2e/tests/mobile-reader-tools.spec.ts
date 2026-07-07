import { geometry } from "../probes";
import { expect, test } from "../fixtures";

// #511: on mobile the reader tools bar started receded off-screen (the chrome was hidden by default),
// so its controls sat below the viewport (translateY(130%)) and could not be tapped. It must now be
// shown by default: the tools stay inside the viewport and "Your notes" opens the notes panel. These
// assert the real rendered geometry in a browser (jsdom has no layout, so it cannot catch an
// off-viewport control) at the exact 390x844 mobile viewport from the bug report.

const MOBILE = { height: 844, width: 390 } as const;
const READER_TOOLS = '[aria-label="Reading tools"] button, [aria-label="Reading tools"] a';
const anyBlock = 'article[aria-label="Reading"] [data-block-id]';

test.describe("mobile reader tools (#511)", () => {
  test("the reader tools stay inside the viewport and open the notes panel", async ({
    page,
    setup
  }) => {
    await page.setViewportSize({ height: MOBILE.height, width: MOBILE.width });
    await page.goto(`${setup.baseURL}#/reader?work=${encodeURIComponent(setup.markdown.entryId)}`);
    await expect(page.locator(anyBlock).first()).toBeVisible();

    // No reader-tool control is flagged offScreen (the bug flagged all four below the fold).
    const result = await page.evaluate(geometry, READER_TOOLS);
    const flags = result.issues.flatMap((issue) => issue.flags);
    expect(flags).not.toContain("offScreen");

    const notes = page.getByRole("button", { name: "Your notes" });
    const box = await notes.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return { bottom: rect.bottom, top: rect.top };
    });
    // The control sits within the visible viewport (top and bottom both inside 844px).
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.bottom).toBeLessThanOrEqual(MOBILE.height);

    // And it is actually tappable — Playwright would time out clicking an out-of-viewport element.
    await notes.click();
    await expect(page.getByRole("dialog", { name: "Your notes" })).toBeVisible();
  });
});
