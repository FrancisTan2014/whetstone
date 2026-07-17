import { expect, test } from "../fixtures";

// #648: Diary is now a direct reverse-chronological timeline — the month calendar, month navigation,
// date marks, and date-jump are gone. This smoke proves, in a real browser against the real server,
// that (1) the Diary surface carries no calendar chrome, (2) an entry still opens its rich editor and
// an edit updates the visible timeline in place (no reload), and (3) the learner's scroll position is
// preserved when they leave Diary and return within the same app session.
//
// One acceptance scenario is not exercisable end to end here: "entries across more than one page of
// days". The Timeline pages by *day* (7 days per page) and every capture is stamped with the server's
// clock (occurred_at = now), so a single browser session can only ever produce one day — there is no
// public surface to backdate an entry onto an earlier day. Multi-page paging over days and the
// preservation of already-loaded older pages across a return are covered deterministically by the
// server timeline query/route tests (diary.test.ts, bounded `before` cursor) and the web unit tests
// (DiaryPage.test.tsx scroll-restoration + paging), which seed multi-day timelines directly.
test.describe("diary timeline (#648)", () => {
  test("has no calendar chrome, edits in place, and restores scroll on return", async ({
    page,
    setup
  }) => {
    const entriesUrl = new URL("api/diary/entries", setup.baseURL).toString();
    // Seed enough entries that the Diary timeline scrolls well past one viewport, so a restored scroll
    // offset is meaningful. Two-digit labels keep each transcript a unique, non-overlapping string. They
    // all fall on today (one day section) — all a browser session can create — which suffices to prove
    // scroll restoration.
    const seedCount = 16;
    for (let index = 1; index <= seedCount; index += 1) {
      const response = await page.request.post(entriesUrl, {
        data: {
          inputMode: "typed",
          transcript: `Seed diary entry ${String(index).padStart(2, "0")}`
        }
      });
      expect(response.status()).toBe(201);
    }

    await page.goto(`${setup.baseURL}#/diary`);
    await expect(page.getByRole("heading", { name: "Diary", level: 1 })).toBeVisible();
    await expect(page.getByText("Seed diary entry 01", { exact: true })).toBeVisible();

    // (1) No calendar chrome: no calendar region, no month navigation, no date grid.
    await expect(page.getByRole("region", { name: /calendar/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /previous month|next month/i })).toHaveCount(0);
    await expect(page.getByRole("grid")).toHaveCount(0);

    // (2) Editing an entry opens the rich editor and updates the timeline in place (no reload).
    const target = page.locator("li", { hasText: "Seed diary entry 01" });
    await target.getByRole("button", { name: "Edit" }).click();
    const editor = page.getByRole("textbox", { name: "Edit entry" });
    await expect(editor).toBeVisible();
    await editor.fill("Edited diary entry 01");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Edited diary entry 01", { exact: true })).toBeVisible();
    await expect(page.getByText("Seed diary entry 01", { exact: true })).toHaveCount(0);

    // Scroll the Diary timeline down and let the page record the offset (a real scroll event fires the
    // passive listener), so there is a non-trivial position to restore.
    const scroller = page.locator("main");
    const offset = 320;
    await scroller.evaluate((element, top) => {
      element.scrollTop = top;
      element.dispatchEvent(new Event("scroll"));
    }, offset);
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(offset);

    // (3) Leave Diary (its component unmounts) and return within the same app session via Today.
    await page.getByRole("link", { name: "Today" }).click();
    const returnLink = page.getByRole("link", { name: "Return to your diary" });
    await expect(returnLink).toBeVisible();
    await returnLink.click();

    // The timeline (including the in-place edit) is restored, and the scroll offset returns to where the
    // learner left it — no full reload, no refetch to the top.
    await expect(page.getByText("Edited diary entry 01", { exact: true })).toBeVisible();
    await expect
      .poll(() => page.locator("main").evaluate((element) => element.scrollTop))
      .toBe(offset);
  });
});
