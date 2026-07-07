import { smallHitTargets, type HitTargetViolation } from "../probes";
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

// Every primary route (Today, Library, Practice, Map, Search, Diary) from the app's hash router.
const ROUTES: ReadonlyArray<readonly [string, string]> = [
  ["Today", "#/"],
  ["Library", "#/library"],
  ["Practice", "#/practice"],
  ["Map", "#/progress"],
  ["Search", "#/search"],
  ["Diary", "#/diary"]
];

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

    for (const [name, hash] of ROUTES) {
      test(`route ${name} has no sub-44px controls`, async ({ page, setup }) => {
        await page.goto(`${setup.baseURL}${hash}`);
        await expect(page.locator("main").first()).toBeVisible();
        // The primary navigation renders on every route; wait for it so its tab targets are measured.
        await expect(page.getByRole("navigation").first()).toBeVisible();

        const violations = await page.evaluate(smallHitTargets, ALLOWLIST);
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
        const violations = await page.evaluate(smallHitTargets, ALLOWLIST);
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
