import { expect, test } from "../fixtures";

// At a phone width the app-shell pages must fit the viewport: the primary nav (9 destinations + the
// theme toggle) wraps instead of forcing a wider-than-viewport row that pushes the right-hand items
// (Recall/Notes/Diary/Search + toggle) off-screen and makes the whole page scroll sideways (#331).

const MOBILE = { height: 844, width: 390 } as const;

const horizontalOverflow = () =>
  ({
    innerWidth: window.innerWidth,
    scrollWidth: document.scrollingElement?.scrollWidth ?? 0
  }) as const;

test.describe("mobile app shell (390px)", () => {
  for (const route of ["/", "/library"] as const) {
    test(`#${route} fits the viewport with every nav destination reachable (#331)`, async ({
      page,
      setup
    }) => {
      await page.setViewportSize({ height: MOBILE.height, width: MOBILE.width });
      await page.goto(`${setup.baseURL}#${route}`);

      const nav = page.getByRole("navigation", { name: "Primary" });
      await expect(nav).toBeVisible();

      // No horizontal page overflow: the document never grows wider than the viewport (allow 1px for
      // sub-pixel rounding). Before the fix this was ~685px at a 390px viewport.
      const { innerWidth, scrollWidth } = await page.evaluate(horizontalOverflow);
      expect(scrollWidth).toBeLessThanOrEqual(innerWidth + 1);

      // The last nav destination (right-most before the fix wrapped it) is within the viewport, so it
      // is reachable without scrolling the page sideways.
      const search = page.getByRole("link", { name: "Search" });
      const box = await search.boundingBox();
      expect(box).not.toBeNull();
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(innerWidth + 1);
    });
  }
});
