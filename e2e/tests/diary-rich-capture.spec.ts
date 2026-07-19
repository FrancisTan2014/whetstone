import { type Locator, type Page } from "@playwright/test";

import { expect, test } from "../fixtures";

// The slash query cannot contain a space — the suggestion terminates on the first space — so a filter
// must be a space-free label substring or alias (`h2`, `bulleted`) that narrows to exactly one command.
async function chooseSlashCommand(
  page: Page,
  slashMenu: Locator,
  filter: string,
  optionName: string
): Promise<void> {
  await page.keyboard.type("/");
  await expect(slashMenu).toBeVisible();
  await page.keyboard.type(filter);
  await expect(slashMenu.getByRole("option", { name: optionName })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(slashMenu).toBeHidden();
}

// A freshly created trailing paragraph must have committed (empty) before "/" is typed, or ProseMirror's
// async transaction can drop the trigger where the suggestion rule never fires and the menu never opens.
async function settleEmptyParagraph(editor: Locator): Promise<void> {
  await expect(editor.locator("p").last()).toHaveText("");
}

// #678: typed Diary capture composes in the shared rich editor, not a plain textarea. This spec proves,
// in a real browser against the real server, that a typed capture can author real block structure
// (heading, bulleted list, a paragraph carrying emphasis and a link) during INITIAL composition, that
// the Diary timeline renders that structure through the shared document renderer (not flattened to a
// single paragraph of text), and that the structure survives a full reload and reopening the entry in
// its editor — the create → timeline → reload → edit round-trip. jsdom cannot lay out ProseMirror's
// floating menus or run the real pointer/keyboard chain, so the composition is driven here in the
// actual browser; the byte-for-byte persistence and readable-text projection are additionally covered
// deterministically by the contract/server tests.
test.describe("diary rich typed capture (#678)", () => {
  test("composes rich structure that survives create, timeline render, reload, and edit", async ({
    page,
    setup
  }) => {
    await page.goto(`${setup.baseURL}#/diary`);

    const capture = page.getByRole("region", { name: "Capture today" });
    await expect(capture).toBeVisible();

    const editor = capture.getByRole("textbox", { name: "Capture text" });
    await editor.click();
    await expect(editor).toBeFocused();

    // A heading via the slash menu (the menu portals to the page, not the region). Clear to a settled
    // empty paragraph first, then trigger — mirroring the robust slash pattern the editor specs use.
    const slashMenu = page.getByRole("listbox", { name: "Block commands" });
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Delete");
    await expect(editor).toHaveText("");
    await chooseSlashCommand(page, slashMenu, "h2", "Heading 2");
    await page.keyboard.type("A good day");
    await expect(editor.locator("h2")).toHaveText("A good day");

    // A bulleted-list item on the next line, authored via the slash menu.
    await page.keyboard.press("Enter");
    await settleEmptyParagraph(editor);
    await chooseSlashCommand(page, slashMenu, "bulleted", "Bulleted list");
    await page.keyboard.type("walked outside");
    await expect(editor.locator("li")).toHaveText("walked outside");

    // Leave the list (Enter on the empty item exits to a plain paragraph) and author a paragraph that
    // carries both emphasis and a link — applied last so the link mark never bleeds into a slash context.
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await settleEmptyParagraph(editor);
    await page.keyboard.type("I felt grateful");

    const toolbar = page.getByRole("toolbar", { name: "Text formatting" });
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+End");
    await expect(toolbar).toBeVisible();
    await toolbar.getByRole("button", { name: "Italic" }).click();
    await expect(editor.locator("em")).toHaveText("I felt grateful");

    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+End");
    await expect(toolbar).toBeVisible();
    await toolbar.getByRole("button", { name: "Link" }).click();
    const linkInput = page.getByRole("textbox", { name: "Link URL" });
    await linkInput.fill("https://example.com/gratitude");
    await page.getByRole("button", { name: "Apply link" }).click();
    await expect(editor.locator('a[href="https://example.com/gratitude"]')).toHaveCount(1);

    // Save the capture.
    await capture.getByRole("button", { name: "Capture" }).click();

    // The Diary timeline renders the authored structure through the shared document renderer.
    const entry = page.locator("li", { hasText: "A good day" });
    await expect(entry.getByRole("heading", { name: "A good day" })).toBeVisible();
    await expect(entry.locator("li", { hasText: "walked outside" })).toBeVisible();
    await expect(entry.locator("em", { hasText: "I felt grateful" })).toBeVisible();
    await expect(entry.locator('a[href="https://example.com/gratitude"]')).toBeVisible();

    // The structure survives a full reload (it is durable, not just in-memory).
    await page.reload();
    const reloaded = page.locator("li", { hasText: "A good day" });
    await expect(reloaded.getByRole("heading", { name: "A good day" })).toBeVisible();
    await expect(reloaded.locator("li", { hasText: "walked outside" })).toBeVisible();
    await expect(reloaded.locator("em", { hasText: "I felt grateful" })).toBeVisible();
    await expect(reloaded.locator('a[href="https://example.com/gratitude"]')).toBeVisible();

    // Reopening the entry loads the same rich structure into its editor; a small edit preserves it.
    await reloaded.getByRole("button", { name: "Edit" }).click();
    const editEditor = page.getByRole("textbox", { name: "Edit entry" });
    await expect(editEditor.locator("h2")).toHaveText("A good day");
    await expect(editEditor.locator("li")).toHaveText("walked outside");
    await expect(editEditor.locator("em")).toHaveText("I felt grateful");
    await expect(editEditor.locator('a[href="https://example.com/gratitude"]')).toHaveCount(1);

    await editEditor.locator("h2").click();
    await page.keyboard.press("End");
    await page.keyboard.type(" (updated)");
    await page.getByRole("button", { name: "Save", exact: true }).click();

    const edited = page.locator("li", { hasText: "A good day (updated)" });
    await expect(edited.getByRole("heading", { name: "A good day (updated)" })).toBeVisible();
    await expect(edited.locator("li", { hasText: "walked outside" })).toBeVisible();
    await expect(edited.locator("em", { hasText: "I felt grateful" })).toBeVisible();
    await expect(edited.locator('a[href="https://example.com/gratitude"]')).toBeVisible();
  });
});
