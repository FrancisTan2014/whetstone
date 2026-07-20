import { expect, test } from "../fixtures";
import type { Page } from "@playwright/test";

// The standalone Memory experience is retired (#662): its pages, nav entry, and quick-add loop are gone,
// folded into Notes + the shared Notes-owned Review session (#657-#661). This spec proves the retirement
// from a booted stack: the primary navigation no longer offers Memory or Recall (in both viewports and
// both themes), the historical `/memory` and `/recall` hashes are compatibility redirects onto Notes and
// Notes Review, and a due prompt is still reviewable end to end when reached through the legacy `/recall`
// entry. Legacy-custom prompt reviewability (rows a browser session can no longer create) is covered at
// the integration layer (notesReviewRoutes.test.ts); this spec covers the redirects and the current-note
// review that a live session can seed.

// The six retained primary destinations, in order. Memory and Recall are absent (Write added in #679).
const PRIMARY_LABELS = ["Today", "Library", "Write", "Recite", "Notes", "Diary"] as const;

// Reach a known theme from the shell's theme toggle (labelled by its DESTINATION: "Switch to Night" shows
// in Day, "Switch to Day" shows in Night). Idempotent — only clicks when a flip is needed.
async function setTheme(page: Page, target: "day" | "night"): Promise<void> {
  const isNight = await page.evaluate(() => document.documentElement.classList.contains("dark"));
  if (isNight === (target === "night")) {
    return;
  }
  await page.getByRole("button", { name: isNight ? "Switch to Day" : "Switch to Night" }).click();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.classList.contains("dark")))
    .toBe(target === "night");
}

// The primary nav offers exactly the six retained destinations — no "Memory", no "Recall" — regardless
// of viewport width or theme.
async function expectRetiredNav(page: Page): Promise<void> {
  const nav = page.getByRole("navigation", { name: "Primary" });
  await expect(nav).toBeVisible();
  await expect(nav.getByRole("link")).toHaveText([...PRIMARY_LABELS]);
  await expect(nav.getByRole("link", { name: "Memory" })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Recall" })).toHaveCount(0);
}

test.describe("Memory experience retirement (#662)", () => {
  test("drops Memory and Recall from the primary nav in both viewports and both themes", async ({
    page,
    setup
  }) => {
    await page.goto(`${setup.baseURL}#/`);

    // Desktop width, Day then Night.
    await page.setViewportSize({ height: 900, width: 1280 });
    await setTheme(page, "day");
    await expectRetiredNav(page);
    await setTheme(page, "night");
    await expectRetiredNav(page);

    // Phone width, Day then Night — the retired destinations never reappear as the shell reflows.
    await page.setViewportSize({ height: 844, width: 390 });
    await setTheme(page, "day");
    await expectRetiredNav(page);
    await setTheme(page, "night");
    await expectRetiredNav(page);
  });

  test("redirects the legacy /memory and /recall hashes onto Notes and Notes Review", async ({
    page,
    setup
  }) => {
    // `/memory` lands on the Notes home, not a Memory page.
    await page.goto(`${setup.baseURL}#/memory`);
    await expect(page).toHaveURL(/#\/notes$/);
    await expect(page.getByRole("heading", { level: 1, name: "Notes" })).toBeVisible();

    // `/recall` lands on the Notes-owned Review session.
    await page.goto(`${setup.baseURL}#/recall`);
    await expect(page).toHaveURL(/#\/notes\/review$/);
    await expect(page.getByRole("heading", { name: "Review" })).toBeVisible();
  });

  test("still grades a due current-note review reached through the legacy /recall entry", async ({
    page,
    setup
  }) => {
    // Compose a card so the note lands already enrolled with one due prompt — the only way a live session
    // seeds a due note prompt now that the Memory quick-add and the standalone note composer are gone.
    await page.goto(`${setup.baseURL}#/notes`);
    await page.getByRole("button", { name: "New card" }).click();
    const composer = page.getByRole("dialog");
    await composer.getByRole("textbox", { name: "Answer" }).fill("kanmusu is a ship girl");
    await composer.getByRole("textbox", { name: "Question" }).fill("What is a kanmusu?");
    await composer.getByRole("button", { name: "Create card" }).click();
    await expect(page.getByText("Card created. Due now.")).toBeVisible();

    // Reach the review session through the HISTORICAL /recall hash (the compat redirect), and grade the
    // due prompt to "Due complete" — proving the legacy entry mounts the same working session and keeps
    // the shared review queue clean for the other specs.
    await page.goto(`${setup.baseURL}#/recall`);
    await expect(page).toHaveURL(/#\/notes\/review$/);
    await expect(page.getByRole("heading", { name: "Review" })).toBeVisible();
    await page.getByRole("button", { name: "Show note" }).click();
    await page.getByRole("button", { name: "Good" }).click();
    await expect(page.getByText(/Due complete/)).toBeVisible();
  });
});
