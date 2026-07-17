import { expect, test } from "../fixtures";

// At a phone width the primary navigation is exactly four destinations (Today, Library, Notes,
// Search) laid out as a SINGLE non-wrapping row of >=44px touch targets — the theme toggle is
// shell chrome, not a tab, so it can never push the row onto a second line (#390, #573). This replaces
// the pre-#390 behaviour where nine destinations + the toggle were allowed to wrap.

const MOBILE = { height: 844, width: 390 } as const;
const MIN_TARGET = 44;
const PRIMARY_LABELS = ["Today", "Library", "Notes", "Search"] as const;

const horizontalOverflow = () =>
  ({
    innerWidth: window.innerWidth,
    scrollWidth: document.scrollingElement?.scrollWidth ?? 0
  }) as const;

test.describe("mobile app shell (390px)", () => {
  for (const route of ["/", "/library"] as const) {
    test(`#${route} shows the four primary destinations as one non-wrapping row of >=44px targets (#390, #573)`, async ({
      page,
      setup
    }) => {
      await page.setViewportSize({ height: MOBILE.height, width: MOBILE.width });
      await page.goto(`${setup.baseURL}#${route}`);

      const nav = page.getByRole("navigation", { name: "Primary" });
      await expect(nav).toBeVisible();

      // Exactly the four primary destinations, in order.
      await expect(nav.getByRole("link")).toHaveText([...PRIMARY_LABELS]);

      // No horizontal page overflow: the document never grows wider than the viewport (allow 1px for
      // sub-pixel rounding).
      const { innerWidth, scrollWidth } = await page.evaluate(horizontalOverflow);
      expect(scrollWidth).toBeLessThanOrEqual(innerWidth + 1);

      // Collect each destination's box: a single row means they all share the same top edge, and each
      // is a >=44px touch target that stays within the viewport.
      const tops: number[] = [];
      for (const label of PRIMARY_LABELS) {
        const box = await nav.getByRole("link", { name: label }).boundingBox();
        expect(box).not.toBeNull();
        const { height, width, x, y } = box ?? { height: 0, width: 0, x: 0, y: 0 };
        expect(height).toBeGreaterThanOrEqual(MIN_TARGET);
        expect(width).toBeGreaterThanOrEqual(MIN_TARGET);
        expect(x + width).toBeLessThanOrEqual(innerWidth + 1);
        tops.push(y);
      }

      // Single row: every destination sits on the same line (tolerate sub-pixel rounding). Before #390
      // the row wrapped, so the later tabs dropped to a second line with a larger `y`.
      const firstTop = tops[0] ?? 0;
      for (const top of tops) {
        expect(Math.abs(top - firstTop)).toBeLessThanOrEqual(1);
      }
    });
  }
});
