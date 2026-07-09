import { INTERACTIVE_SELECTOR, smallHitTargets, type HitTargetViolation } from "../probes";
import { expect, test } from "../fixtures";
import { selectWordIn } from "../select";

// The systemic guard for the whole "sub-44px hit target" class (#519). The closed-bug list has ~15
// per-surface fixes of the SAME defect (#401/#413/#460/#463/#470/#475/#476/#479/#482/#483/#487/#489/
// #491/#502/#505) — each patched on one surface while the next shipped it again. A per-instance test
// cannot catch the class on a NEW surface; this one sweep enumerates every visible, enabled interactive
// control on each primary surface and fails if any renders under 44x44 CSS px (WCAG 2.5.5).

// The allowlist (kept tiny, per the issue), each entry justified:
//  - the reading prose column (`article[aria-label="Reading"]`): its controls — inline cross-reference
//    links, footnote markers, note marks — are content actuated via selection/lookup/tap and sized to
//    the words they annotate (a 44px block would wreck inline reading), not chrome.
//  - visually-hidden (`.sr-only`) inputs: a screen-reader-only control (e.g. the file `<input>` behind a
//    styled "Upload" button) is a 1×1 proxy; the VISIBLE control that actuates it is swept and must meet
//    44px.
// Everything else — all app chrome: nav, reader tools, the 目录 drawer, the selection toolbar, the note
// sheet, the lookup popover — must meet the 44px bar.
const ALLOWLIST = ['article[aria-label="Reading"]', ".sr-only"].join(", ");

const anyBlock = 'article[aria-label="Reading"] [data-block-id]';
const proseParagraph = `${anyBlock}:has(p)`;

const MOBILE = { height: 844, width: 390 } as const;
const DESKTOP = { height: 900, width: 1280 } as const;

// Every primary route from the app's hash router, with an optional route-specific ready marker that
// only mounts once the route has rendered its actual controls (so the sweep never measures a bare
// loading state). Where a route's ready state varies too much for a single positive marker (Practice's
// loading/empty/error/ready, Map's ready/error), the loading-indicator wait below is the guard instead.
const ROUTES: ReadonlyArray<readonly [string, string, string | undefined]> = [
  ["Today", "#/", 'section[aria-label="Capture today"]'],
  ["Library", "#/library", 'a[href^="#/reader?work="]'],
  ["Practice", "#/practice", undefined],
  ["Map", "#/progress", undefined],
  ["Search", "#/search", 'input[type="search"]'],
  ["Diary", "#/diary", 'section[aria-label="Capture today"]']
];

// The shared `LoadingIndicator` renders `[role="status"][aria-busy="true"]`. An async route (Diary,
// Practice, Map, Today's recall/reading cards, the Library shelf) shows it while loading, so waiting for
// it to clear guarantees we sweep the route's READY-state controls, not a spinner (#519 review).
const LOADING = '[role="status"][aria-busy="true"]';

function report(surface: string, violations: ReadonlyArray<HitTargetViolation>): string {
  return violations
    .map(
      (issue) =>
        `  ${surface}: ${issue.descriptor} rendered ${issue.width}×${issue.height} (< 44px)`
    )
    .join("\n");
}

for (const [viewportName, viewport] of [
  ["mobile", MOBILE],
  ["desktop", DESKTOP]
] as const) {
  test.describe(`${viewportName}: interactive controls meet the 44px hit target (#519)`, () => {
    test.use({ reducedMotion: "reduce", viewport });

    for (const [name, hash, readyMarker] of ROUTES) {
      test(`route ${name} has no sub-44px controls`, async ({ page, setup }) => {
        await page.goto(`${setup.baseURL}${hash}`);
        await expect(page.locator("main").first()).toBeVisible();
        // The primary navigation renders on every route; wait for it so its tab targets are measured.
        await expect(page.getByRole("navigation").first()).toBeVisible();
        // Wait out any page/section loading indicators so async routes render their real controls first.
        await expect(page.locator(LOADING)).toHaveCount(0);
        // ...and, where the route exposes one, an explicit ready control so the sweep covers it.
        if (readyMarker !== undefined) {
          await expect(page.locator(readyMarker).first()).toBeVisible();
        }

        const violations = await page.evaluate(smallHitTargets, {
          exclude: ALLOWLIST,
          interactive: INTERACTIVE_SELECTOR
        });
        expect(violations, `sub-44px controls on ${name}:\n${report(name, violations)}`).toEqual(
          []
        );
      });
    }

    test("reader chrome across its key states has no sub-44px controls", async ({
      page,
      setup
    }) => {
      const sweep = async (state: string): Promise<void> => {
        const violations = await page.evaluate(smallHitTargets, {
          exclude: ALLOWLIST,
          interactive: INTERACTIVE_SELECTOR
        });
        expect(
          violations,
          `sub-44px controls in reader (${state}):\n${report(`reader/${state}`, violations)}`
        ).toEqual([]);
      };

      await page.goto(`${setup.baseURL}#/reader?work=${encodeURIComponent(setup.epub.entryId)}`);
      await expect(page.locator(anyBlock).first()).toBeVisible();
      await sweep("default");

      // 目录 drawer open.
      await page.getByRole("button", { name: "Table of contents" }).click();
      await expect(page.getByRole("navigation", { name: "Table of Contents" })).toBeVisible();
      await sweep("toc-drawer");
      await page.keyboard.press("Escape");
      await expect(page.getByRole("navigation", { name: "Table of Contents" })).toBeHidden();

      // Selection toolbar shown.
      await selectWordIn(page, proseParagraph);
      await expect(page.getByRole("toolbar", { name: "Annotate selection" })).toBeVisible();
      await sweep("selection-toolbar");

      // Note sheet open.
      await page.getByRole("button", { name: "Add note" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await sweep("note-sheet");
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toBeHidden();

      // Lookup popover open (final state — re-select, then look up).
      await selectWordIn(page, proseParagraph);
      await expect(page.getByRole("toolbar", { name: "Annotate selection" })).toBeVisible();
      await page.getByRole("button", { name: "Look up" }).click();
      await expect(page.getByRole("dialog", { name: /^Look up:/ })).toBeVisible();
      await sweep("lookup-popover");
    });
  });
}

// Regression for the sweep's own coverage (#519): the Library "Upload" control is a button-styled
// `<label>` wrapping an `.sr-only` `<input type=file>`. The hidden input is allowlisted, so if the
// sweep did not also enumerate the visible label proxy (its earlier blind spot), this whole class of
// app chrome would go unguarded. Assert the label IS matched by the sweep's interactive selector and
// meets the 44px bar — so a regression of the visible proxy would fail the sweep.
test("the Library Upload proxy label is swept and meets the 44px bar (#519)", async ({
  page,
  setup
}) => {
  await page.setViewportSize({ height: 900, width: 1280 });
  await page.goto(`${setup.baseURL}#/library`);

  const upload = page.locator('label:has(input[type="file"])').filter({ hasText: "Upload" });
  await expect(upload).toBeVisible();

  // The visible proxy — not just the hidden input — is in the enumerated set the sweep measures.
  const swept = await upload.evaluate(
    (element, selector) => element.matches(selector),
    INTERACTIVE_SELECTOR
  );
  expect(swept, "the Upload label proxy must be enumerated by the sweep").toBe(true);

  const box = await upload.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { height: rect.height, width: rect.width };
  });
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.width).toBeGreaterThanOrEqual(44);
});
