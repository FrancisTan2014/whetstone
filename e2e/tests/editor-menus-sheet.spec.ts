import { type Locator, type Page } from "@playwright/test";

import { type SetupData } from "../stack";
import { expect, test } from "../fixtures";

// Open the slash menu deterministically. A fast keyboard sequence (`Ctrl+A → ArrowRight → Enter →
// "/"`) races ProseMirror's async transactions: on a slow CI worker the trigger could be typed before
// the new paragraph committed, dropping "/" after a non-space character where the suggestion's prefix
// rule never fires and the menu never opens (#645). Instead focus the editor, clear it to a single
// empty paragraph, and wait for that settled empty state before typing the trigger — so "/" always
// lands at the start of a plain paragraph where the menu opens.
async function openSlashMenu(page: Page, editor: Locator): Promise<void> {
  await editor.click();
  await expect(editor).toBeFocused();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
  await expect(editor).toHaveText("");
  await page.keyboard.type("/");
}

// The shared rich editor's four floating surfaces — the formatting toolbar, the link form, the
// slash-command menu, and the block-actions menu — must stay VISIBLE and INTERACTIVE when the editor
// is opened inside a modal Sheet ("Edit note"), never dimmed behind the overlay or rendered inert by
// the dialog's aria-hidden sweep (#645). jsdom cannot lay out stacking contexts, honor `overflow`/
// `transform` clipping, or run the real pointer chain, so this drives the actual rendered browser: it
// proves each surface renders inside the dialog AND is clickable (Playwright's actionability check
// fails if the overlay intercepts the pointer), in BOTH the Day and Night themes.

const READING = 'article[aria-label="Reading"]';
const EDIT_DIALOG = { name: "Edit note" } as const;
const DESKTOP = { height: 900, width: 1280 } as const;

// Seed a dedicated work from a single paragraph so specs never collide over shared annotations, then
// anchor a sub-block note to `word` (real offsets) so the reader draws an inline underline to open.
async function seedWorkWithNote(
  page: Page,
  setup: SetupData,
  title: string,
  paragraph: string,
  word: string,
  body: string
): Promise<string> {
  const created = await page.request.post(`${setup.baseURL}api/works`, {
    data: {
      author: { mode: "new", name: `${title} Author` },
      language: "en",
      origin: "manual",
      title,
      workType: "essay"
    }
  });
  expect(created.status()).toBe(201);
  const { work } = (await created.json()) as { work: { entryId: string } };

  const ingest = await page.request.post(
    `${setup.baseURL}api/works/${encodeURIComponent(work.entryId)}/content`,
    { data: { kind: "manual", markdown: `# ${title}\n\n${paragraph}\n` } }
  );
  expect(ingest.ok()).toBe(true);

  const readerUrl = `${setup.baseURL}#/reader?work=${encodeURIComponent(work.entryId)}`;
  await page.goto(readerUrl);
  await expect(page.locator(`${READING} [data-block-id]`).first()).toBeVisible();

  const block = (await page.evaluate(
    ([reading, want]) => {
      for (const node of Array.from(document.querySelectorAll(`${reading} [data-block-id]`))) {
        const text = node.textContent ?? "";
        const blockEntryId = node.getAttribute("data-block-id");
        if (blockEntryId !== null && text.includes(want)) {
          return { blockEntryId, text };
        }
      }
      return null;
    },
    [READING, word] as const
  )) as { blockEntryId: string; text: string } | null;
  expect(block).not.toBeNull();

  const startOffset = block!.text.indexOf(word);
  const response = await page.request.post(
    `${setup.baseURL}api/works/${encodeURIComponent(work.entryId)}/notes`,
    {
      data: {
        anchor: {
          blockEntryId: block!.blockEntryId,
          contextSnapshot: word,
          endOffset: startOffset + word.length,
          selectedTextSnapshot: word,
          startOffset
        },
        bodyDoc: {
          content: [{ content: [{ text: body, type: "text" }], type: "paragraph" }],
          type: "doc"
        }
      }
    }
  );
  expect(response.status()).toBe(201);

  // Remount the hash-routed reader so it fetches the seeded note and draws the underline.
  await page.goto("about:blank");
  await page.goto(readerUrl);
  await expect(page.locator(`${READING} [data-block-id]`).first()).toBeVisible();
  return word;
}

// Reach a known theme from the shell's utility-bar theme toggle (labelled by its DESTINATION: "Switch
// to Night" shows in Day, "Switch to Day" shows in Night). The theme control lives once in the shell now
// that the reader is framed by it (#638), so this name resolves to a single button. Idempotent — only
// clicks when a flip is needed.
async function setTheme(page: Page, target: "day" | "night"): Promise<void> {
  const isNight = await page.evaluate(() => document.documentElement.classList.contains("dark"));
  if (isNight === (target === "night")) {
    return;
  }
  const label = isNight ? "Switch to Day" : "Switch to Night";
  await page.getByRole("button", { name: label }).click();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.classList.contains("dark")))
    .toBe(target === "night");
}

for (const theme of ["day", "night"] as const) {
  test(`${theme}: every editor floating surface stays above the Edit note sheet and usable`, async ({
    page,
    setup
  }) => {
    await page.setViewportSize({ height: DESKTOP.height, width: DESKTOP.width });

    const word = await seedWorkWithNote(
      page,
      setup,
      `Editor Menus ${theme}`,
      "The quick brown fox jumps over the lazy dog near the riverbank.",
      "quick",
      "Format sample here."
    );
    await setTheme(page, theme);

    // Open THIS note's editor by activating its inline underline.
    await page.getByRole("button", { name: `Open note on '${word}'` }).click();
    const dialog = page.getByRole("dialog", EDIT_DIALOG);
    await expect(dialog).toBeVisible();

    const editor = dialog.getByRole("textbox", { name: "Note body" });
    await expect(editor).toBeVisible();

    // 1) Formatting toolbar — selecting text reveals it INSIDE the dialog; clicking Bold proves it
    //    receives the pointer (an overlay-covered surface would intercept the click and fail).
    await editor.click();
    await page.keyboard.press("ControlOrMeta+a");
    const toolbar = dialog.getByRole("toolbar", { name: "Text formatting" });
    await expect(toolbar).toBeVisible();
    await toolbar.getByRole("button", { name: "Bold" }).click();
    await expect(editor.locator("strong")).toHaveCount(1);

    // 2) Slash menu — in a fresh empty paragraph it opens above the sheet, filters, navigates, and
    //    selects; then Escape closes it leaving the slash literal. Runs before the link is applied so
    //    the host paragraph is a plain (non-link) context where `/` is allowed.
    await openSlashMenu(page, editor);
    const slashMenu = dialog.getByRole("listbox", { name: "Block commands" });
    await expect(slashMenu).toBeVisible();

    await page.keyboard.type("quote"); // filter narrows the catalog
    await expect(slashMenu.getByRole("option", { name: /Quote/ })).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter"); // select the highlighted command
    await expect(slashMenu).toBeHidden();
    await expect(editor.locator("blockquote")).toHaveCount(1);

    // Escape closes the menu and leaves the typed slash as literal text.
    await openSlashMenu(page, editor);
    await expect(slashMenu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(slashMenu).toBeHidden();
    await expect(editor).toContainText("/");

    // 3) Link form — a Radix Popover nested in the bubble; must open above the sheet and apply a link.
    //    Runs last among the toolbar surfaces so its link mark never bleeds into the slash context.
    await editor.click();
    await page.keyboard.press("ControlOrMeta+a");
    await expect(toolbar).toBeVisible();
    await toolbar.getByRole("button", { name: "Link" }).click();
    const linkInput = dialog.getByRole("textbox", { name: "Link URL" });
    await expect(linkInput).toBeVisible();
    await linkInput.fill("https://example.com/notes");
    await dialog.getByRole("button", { name: "Apply link" }).click();
    await expect(linkInput).toBeHidden();
    await expect(editor.locator('a[href="https://example.com/notes"]').first()).toBeVisible();
  });
}

// The fourth surface — the block-actions menu — is reached on desktop through the hover-only gutter
// grip, whose lane the compact note editor clips (`overflow: hidden`), and its keyboard/coarse-pointer
// triggers are hidden under a fine pointer. Under a real coarse pointer the always-present "More block
// actions" trigger is shown, so this drives an emulated touch device to prove the menu opens visible
// and usable above the sheet — the same shared floating host the other three surfaces portal into.
test.describe("block-actions menu inside the Edit note sheet (coarse pointer)", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { height: 851, width: 393 } });

  for (const theme of ["day", "night"] as const) {
    test(`${theme}: the block-actions menu opens above the sheet and is usable`, async ({
      page,
      setup
    }) => {
      const word = await seedWorkWithNote(
        page,
        setup,
        `Block Menu ${theme}`,
        "The quick brown fox jumps over the lazy dog near the riverbank.",
        "quick",
        "Block sample here."
      );
      await setTheme(page, theme);

      await page.getByRole("button", { name: `Open note on '${word}'` }).click();
      const dialog = page.getByRole("dialog", EDIT_DIALOG);
      await expect(dialog).toBeVisible();

      // A coarse pointer surfaces the always-present compact trigger; opening it must portal the Radix
      // menu into the sheet's floating host and render it clickable above the overlay.
      const moreTrigger = dialog.getByRole("button", { name: "More block actions" });
      await expect(moreTrigger).toBeVisible();
      await moreTrigger.click();

      const blockMenu = dialog.getByRole("menu", { name: "Block actions" });
      await expect(blockMenu).toBeVisible();
      await expect(blockMenu.getByRole("menuitem", { name: /Delete/ })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(blockMenu).toBeHidden();
    });
  }
});
