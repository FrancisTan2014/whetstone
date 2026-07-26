import { type Page } from "@playwright/test";

import { type SetupData } from "../stack";
import { expect, test } from "../fixtures";

// The imported-Work correction journey (#762): open a canonical imported Work (the pre-seeded EPUB) in the
// SHARED Library editor from its "Correct content" action, correct a stored block and change a block's
// type, save with the Work-revision fence, reopen the editor to prove the correction persisted, and open
// the Reader to prove the same corrected blocks render everywhere. The same run proves the administrative
// affordance ("Open in Reader") is present here yet ABSENT from the owner-scoped manual editor, so the
// shared editor never leaks administrative reach into the manual path. jsdom cannot lay out the persistent
// toolbar, drive the real pointer chain through Radix menus, or run the ProseMirror/repartition
// transactions a real save/reload exercises, so this proves the whole loop in the actual browser, in BOTH
// the Day and Night themes and at BOTH a desktop and a 320px viewport.

const READING = 'article[aria-label="Reading"]';
const DESKTOP = { height: 900, width: 1280 } as const;
const NARROW = { height: 720, width: 320 } as const;

// Create an owner-scoped manual Work through the real review front door (#749). A unique title has no
// duplicate candidate, so begin mints the owned, canonical empty-document Work immediately.
async function createManualWork(page: Page, setup: SetupData, title: string): Promise<string> {
  const created = await page.request.post(`${setup.baseURL}api/works/manual`, {
    data: {
      author: { mode: "new", name: `${title} Author` },
      language: "en",
      title,
      workType: "book"
    }
  });
  expect(created.status()).toBe(201);
  const { result } = (await created.json()) as { result: { work: { entryId: string } } };
  return result.work.entryId;
}

// Persist the theme choice the app reads on load (`whetstone-theme`) so every navigation renders in the
// target theme deterministically — the theme is a backdrop the editor must work against, not the thing
// under test.
async function persistTheme(page: Page, theme: "day" | "night"): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
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
    test(`${theme} · ${size}: correct a canonical imported Work in the shared editor and read the result`, async ({
      page,
      setup
    }) => {
      await page.setViewportSize({ height: viewport.height, width: viewport.width });
      await persistTheme(page, theme);

      const importedTitle = setup.epub.title;
      const marker = `Corrected ${theme} ${size}`;
      const sectionText = `New heading ${theme} ${size}`;

      // Open the Library, then route to the correction editor through the imported Work's "Correct content"
      // action — proving a canonical imported Work exposes correction and routes to the shared surface.
      await page.goto(`${setup.baseURL}#/library`);
      await expect
        .poll(() => page.evaluate(() => document.documentElement.classList.contains("dark")))
        .toBe(theme === "night");
      await page.getByRole("button", { name: `More actions for ${importedTitle}` }).click();
      await page.getByRole("menuitem", { name: "Correct content" }).click();

      const editor = page.getByRole("textbox", { name: `Edit ${importedTitle}` });
      await expect(editor).toBeVisible();
      await expect(page.getByRole("status")).toHaveText("Saved");

      // The administrative correction surface offers "Open in Reader"; the manual editor (asserted below)
      // does not.
      await expect(page.getByRole("link", { name: "Open in Reader" })).toBeVisible();

      // Correct an existing stored block: prepend a marker to the very first block.
      await editor.click();
      await page.keyboard.press("ControlOrMeta+Home");
      await page.keyboard.type(`${marker} `);

      // Change a block's type: append a new line, type it, select it, and promote it to a Heading 2 through
      // the persistent toolbar — a block-type correction that transactionally repartitions a new section.
      await page.keyboard.press("ControlOrMeta+End");
      await page.keyboard.press("Enter");
      await page.keyboard.type(sectionText);
      await page.keyboard.press("Home");
      await page.keyboard.press("Shift+End");
      const toolbar = page.getByRole("toolbar", { exact: true, name: "Formatting" });
      await expect(toolbar).toBeVisible();
      await toolbar.getByRole("button", { name: "Heading 2" }).click();
      await expect(editor.locator("h2")).toContainText(sectionText);

      // Save explicitly and wait for the confirmed state.
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByRole("status")).toHaveText("Saved");

      // Reopen the correction editor from a clean navigation: the exact corrected document reloads from the
      // persisted blocks.
      await page.goto("about:blank");
      await page.goto(
        `${setup.baseURL}#/library/works/${encodeURIComponent(setup.epub.entryId)}/correct`
      );
      const reopened = page.getByRole("textbox", { name: `Edit ${importedTitle}` });
      await expect(reopened).toBeVisible();
      await expect(reopened).toContainText(marker);
      await expect(reopened.locator("h2")).toContainText(sectionText);

      // The Reader consumes the same stored blocks — the correction is readable everywhere.
      await page.goto(`${setup.baseURL}#/reader?work=${encodeURIComponent(setup.epub.entryId)}`);
      await expect(page.locator(`${READING} [data-block-id]`).first()).toBeVisible();
      await expect(page.locator(READING)).toContainText(marker);
      await expect(page.locator(READING)).toContainText(sectionText);

      // The owner-scoped manual editor shares the same editor but must stay owner-scoped: it exposes no
      // administrative "Open in Reader" action, at this same theme and 320px/desktop viewport.
      const manualTitle = `Manual ${theme} ${size}`;
      const manualId = await createManualWork(page, setup, manualTitle);
      await page.goto(`${setup.baseURL}#/library/works/${encodeURIComponent(manualId)}/edit`);
      const manualEditor = page.getByRole("textbox", { name: `Edit ${manualTitle}` });
      await expect(manualEditor).toBeVisible();
      await expect(page.getByRole("link", { name: "Open in Reader" })).toHaveCount(0);
    });
  }
}
