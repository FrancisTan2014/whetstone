import { type Page } from "@playwright/test";

import { type SetupData } from "../stack";
import { expect, test } from "../fixtures";

// The manual-Work editing journey (#720): create a manual Work, open its dedicated Library editor from
// the "Edit content" action, enter and format rich text, save with revision protection, reopen the
// editor to prove the exact document persisted, and open the Reader to prove the same blocks render.
// jsdom cannot lay out the persistent toolbar, run the real pointer chain through Radix menus, or drive
// the ProseMirror transactions a real save/reload exercises, so this proves the whole loop in the actual
// browser, in BOTH the Day and Night themes and at BOTH a desktop and a narrow viewport.

const READING = 'article[aria-label="Reading"]';
const DESKTOP = { height: 900, width: 1280 } as const;
const NARROW = { height: 851, width: 393 } as const;

// Create a manual Work through the real API. Manual creation writes one canonical, id-stamped empty
// paragraph (#696's initializer), so the editor opens on an immediately editable document.
async function createManualWork(page: Page, setup: SetupData, title: string): Promise<string> {
  const created = await page.request.post(`${setup.baseURL}api/works`, {
    data: {
      author: { mode: "new", name: `${title} Author` },
      language: "en",
      origin: "manual",
      title,
      workType: "book"
    }
  });
  expect(created.status()).toBe(201);
  const { work } = (await created.json()) as { work: { entryId: string } };
  return work.entryId;
}

// Persist the theme choice the app reads on load (`whetstone-theme`), so every navigation renders in the
// target theme deterministically — the shell's theme toggle has its own coverage; here the theme is a
// backdrop the editor must work against, not the thing under test.
async function persistTheme(page: Page, theme: "day" | "night"): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      // The init-script runs on every document, including `about:blank`, where localStorage access is
      // blocked; only the real app origin needs the seed, so ignore the security error elsewhere.
      try {
        window.localStorage.setItem(key, value);
      } catch {
        /* not the app origin (e.g. about:blank) — nothing to seed */
      }
    },
    ["whetstone-theme", theme] as const
  );
}

for (const theme of ["day", "night"] as const) {
  for (const [size, viewport] of [
    ["desktop", DESKTOP],
    ["narrow", NARROW]
  ] as const) {
    test(`${theme} · ${size}: create, edit, format, save, reopen, and read a manual Work`, async ({
      page,
      setup
    }) => {
      await page.setViewportSize({ height: viewport.height, width: viewport.width });
      await persistTheme(page, theme);

      const title = `Manual ${theme} ${size}`;
      const workEntryId = await createManualWork(page, setup, title);

      // Open the Library, then route to the editor through the Work's "Edit content" action — the manual
      // origin's content entry, proving the Library exposes editing and routes to the dedicated surface.
      await page.goto(`${setup.baseURL}#/library`);
      await expect
        .poll(() => page.evaluate(() => document.documentElement.classList.contains("dark")))
        .toBe(theme === "night");
      await page.getByRole("button", { name: `More actions for ${title}` }).click();
      await page.getByRole("menuitem", { name: "Edit content" }).click();

      const editor = page.getByRole("textbox", { name: `Edit ${title}` });
      await expect(editor).toBeVisible();
      await expect(page.getByRole("status")).toHaveText("Saved");

      // Enter text and format it into a bold Heading 1 via the persistent toolbar (block + mark controls).
      // `exact` distinguishes the persistent "Formatting" toolbar from the selection "Text formatting" one.
      await editor.click();
      await page.keyboard.type("Hello manual world");
      await page.keyboard.press("ControlOrMeta+a");
      const toolbar = page.getByRole("toolbar", { exact: true, name: "Formatting" });
      await expect(toolbar).toBeVisible();
      await toolbar.getByRole("button", { name: "Heading 1" }).click();
      await page.keyboard.press("ControlOrMeta+a");
      await toolbar.getByRole("button", { name: "Bold" }).click();
      await expect(editor.locator("h1")).toContainText("Hello manual world");
      await expect(editor.locator("h1 strong")).toHaveCount(1);

      // Save explicitly and wait for the confirmed state.
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByRole("status")).toHaveText("Saved");

      // Reopen the editor from a clean navigation: the exact document reloads from the persisted blocks.
      await page.goto("about:blank");
      await page.goto(`${setup.baseURL}#/library/works/${encodeURIComponent(workEntryId)}/edit`);
      const reopened = page.getByRole("textbox", { name: `Edit ${title}` });
      await expect(reopened).toBeVisible();
      await expect(reopened.locator("h1")).toContainText("Hello manual world");
      await expect(reopened.locator("h1 strong")).toHaveCount(1);

      // The Reader consumes the same stored blocks — no projection or dual write.
      await page.goto(`${setup.baseURL}#/reader?work=${encodeURIComponent(workEntryId)}`);
      await expect(page.locator(`${READING} [data-block-id]`).first()).toBeVisible();
      await expect(page.locator(READING)).toContainText("Hello manual world");
    });
  }
}
