import { expect, test } from "../fixtures";
import { selectWordIn } from "../select";

// The reader renders each stored block in an `article[aria-label="Reading"]` with a `data-block-id`.
const blockWith = (inner: string): string =>
  `article[aria-label="Reading"] [data-block-id]:has(${inner})`;
const anyBlock = 'article[aria-label="Reading"] [data-block-id]';
const toolbar = { name: "Annotate selection" } as const;

test.describe("core reader loop", () => {
  test("opens a work from the library into its chapter content", async ({ page, setup }) => {
    await page.goto(setup.baseURL);

    await expect(page.getByRole("heading", { name: setup.epub.title }).first()).toBeVisible();
    await page
      .locator(`a[href="#/reader?work=${encodeURIComponent(setup.epub.entryId)}"]`)
      .first()
      .click();

    // The chapter's blocks render — the EPUB ingest → store → read pipeline works end to end.
    await expect(page.locator(anyBlock).first()).toBeVisible();
  });

  test("captures a note and surfaces the toolbar for paragraph, blockquote, and list", async ({
    page,
    setup
  }) => {
    await page.goto(`${setup.baseURL}#/reader?work=${encodeURIComponent(setup.markdown.entryId)}`);
    await expect(page.locator(anyBlock).first()).toBeVisible();

    // Paragraph: selection raises the toolbar; add a note; it persists across a reload.
    await selectWordIn(page, blockWith("p"));
    await expect(page.getByRole("toolbar", toolbar)).toBeVisible();

    await page.getByRole("button", { name: "Add note" }).click();
    const editor = page.getByRole("dialog");
    await expect(editor).toBeVisible();
    await editor.locator("textarea, input[type=text]").first().fill("E2E smoke note.");
    await page.getByRole("button", { name: "Save note" }).click();
    await expect(page.locator('[data-has-notes="true"]').first()).toBeVisible();

    await page.reload();
    await expect(page.locator(anyBlock).first()).toBeVisible();
    await expect(page.locator('[data-has-notes="true"]').first()).toBeVisible();

    // A blockquote and a list block also yield a valid selection that raises the toolbar.
    await selectWordIn(page, blockWith("blockquote"));
    await expect(page.getByRole("toolbar", toolbar)).toBeVisible();

    await selectWordIn(page, blockWith("ul, ol"));
    await expect(page.getByRole("toolbar", toolbar)).toBeVisible();
  });

  test("looks up a word and shows a definition", async ({ page, setup }) => {
    await page.goto(`${setup.baseURL}#/reader?work=${encodeURIComponent(setup.markdown.entryId)}`);
    await expect(page.locator(anyBlock).first()).toBeVisible();

    await selectWordIn(page, blockWith("p"));
    await page.getByRole("button", { name: "Look up" }).click();

    const lookup = page.getByRole("dialog", { name: /^Look up:/ });
    await expect(lookup).toBeVisible();
    // A real definition rendered — not the loading, empty, or error state (`.lookupGloss` is a sense).
    await expect(lookup.locator(".lookupGloss").first()).toBeVisible();
  });
});
