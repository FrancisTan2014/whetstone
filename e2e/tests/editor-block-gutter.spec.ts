import { expect, test } from "../fixtures";
import type { APIRequestContext } from "@playwright/test";

// The contextual block gutter (#590) is built on Tiptap's official React drag handle, which reveals
// its grip only under a real hovering pointer by rendering into a detached, positioned portal. jsdom
// cannot drive that reveal/drag, so those seams are coverage-excluded and validated here in a real
// browser: the grip appears on hover (never as permanent chrome), sits in a narrow left lane, carries
// the native drag affordance, opens the block-actions menu, washes the block it targets, and runs the
// id-preserving block commands end to end.

const DOCUMENT = {
  content: [
    { content: [{ text: "Alpha the first block", type: "text" }], type: "paragraph" },
    { content: [{ text: "Bravo the second block", type: "text" }], type: "paragraph" },
    { content: [{ text: "Charlie the third block", type: "text" }], type: "paragraph" }
  ],
  type: "doc"
} as const;

// Create an owned Work and replace its canonical document with three distinct paragraphs, so the
// editor opens on a real multi-block document reached through the same API the app uses. v0 resolves a
// single DEFAULT_USER_ID, so a Work authored over the API is owned by the same user the browser acts as.
async function seedAuthoredWork(baseURL: string, request: APIRequestContext): Promise<string> {
  const created = await request.post(`${baseURL}api/authored-works`, {
    data: { language: "en", title: "Block Gutter Fixture", workType: "essay" }
  });
  expect(created.status()).toBe(201);
  const { entryId } = (await created.json()) as { entryId: string };

  const saved = await request.put(`${baseURL}api/authored-works/${entryId}/content`, {
    data: { document: DOCUMENT }
  });
  expect(saved.ok()).toBe(true);
  return entryId;
}

test.describe("editor contextual block gutter (#590)", () => {
  test("reveals the grip on hover in a left lane with the native drag affordance, never as chrome", async ({
    page,
    setup
  }) => {
    const entryId = await seedAuthoredWork(setup.baseURL, page.request);
    await page.goto(`${setup.baseURL}#/write?work=${encodeURIComponent(entryId)}`);

    const content = page.locator(".richContentEditorContent");
    const firstBlock = content.locator("p").first();
    await expect(firstBlock).toHaveText("Alpha the first block");

    // No permanent chrome: the grip is not shown until a block is hovered.
    const grip = page.getByRole("button", { exact: true, name: "Block actions" });
    await expect(grip).toBeHidden();

    await firstBlock.hover();
    await expect(grip).toBeVisible();

    // The grip sits in a narrow left lane, left of the writing column, and carries the native drag
    // affordance the drag-handle uses to reorder whole blocks.
    const gripBox = await grip.boundingBox();
    const blockBox = await firstBlock.boundingBox();
    expect(gripBox).not.toBeNull();
    expect(blockBox).not.toBeNull();
    if (gripBox !== null && blockBox !== null) {
      expect(gripBox.x).toBeLessThan(blockBox.x);
      expect(gripBox.width).toBeGreaterThanOrEqual(40);
      expect(gripBox.width).toBeLessThanOrEqual(56);
    }
    // While revealed over a block, the gutter wrapper is the native drag source the drag-handle uses
    // to reorder whole blocks (a single block move is also proven, id-preserving, in the next test).
    const gutterDraggable = await page
      .locator(".richContentEditorGutter")
      .evaluate((element) => (element as HTMLElement).draggable);
    expect(gutterDraggable).toBe(true);
  });

  test("the grip menu washes the target block and moves it, preserving its id", async ({
    page,
    setup
  }) => {
    const entryId = await seedAuthoredWork(setup.baseURL, page.request);
    await page.goto(`${setup.baseURL}#/write?work=${encodeURIComponent(entryId)}`);

    const content = page.locator(".richContentEditorContent");
    await expect(content.locator("p").first()).toHaveText("Alpha the first block");
    const firstId = await content.locator("p").first().getAttribute("data-id");
    expect(firstId).not.toBeNull();

    await content.locator("p").first().hover();
    await page.getByRole("button", { exact: true, name: "Block actions" }).click();
    const menu = page.getByRole("menu", { exact: true, name: "Block actions" });
    await expect(menu).toBeVisible();

    // The transient wash marks exactly the block the menu acts on while it is open.
    await expect(content.locator(".is-block-gutter-active")).toHaveText("Alpha the first block");

    await menu.getByRole("menuitem", { name: "Move down" }).click();

    // Alpha is now the second block, and it kept its id across the move (a move is a delete + re-insert
    // of the very same node), so any note anchored to it stays valid.
    await expect(content.locator("p").nth(1)).toHaveText("Alpha the first block");
    await expect(content.locator("p").nth(1)).toHaveAttribute("data-id", firstId ?? "");
    await expect(content.locator("p").first()).toHaveText("Bravo the second block");
  });

  test("the grip menu turns a block into a heading and deletes a block", async ({ page, setup }) => {
    const entryId = await seedAuthoredWork(setup.baseURL, page.request);
    await page.goto(`${setup.baseURL}#/write?work=${encodeURIComponent(entryId)}`);

    const content = page.locator(".richContentEditorContent");
    await expect(content.locator("p").first()).toHaveText("Alpha the first block");

    // Turn the first block into a Heading 1 through the "Turn into" submenu.
    await content.locator("p").first().hover();
    await page.getByRole("button", { exact: true, name: "Block actions" }).click();
    await page
      .getByRole("menu", { exact: true, name: "Block actions" })
      .getByRole("menuitem", { name: "Turn into" })
      .click();
    await page
      .getByRole("menu", { exact: true, name: "Turn into" })
      .getByRole("menuitem", { name: "Heading 1" })
      .click();
    await expect(content.locator("h1")).toHaveText("Alpha the first block");

    // Delete the (now heading) block; the document drops to two blocks and Alpha is gone.
    await content.locator("h1").first().hover();
    await page.getByRole("button", { exact: true, name: "Block actions" }).click();
    await page
      .getByRole("menu", { exact: true, name: "Block actions" })
      .getByRole("menuitem", { name: "Delete" })
      .click();
    await expect(content.getByText("Alpha the first block")).toHaveCount(0);
    await expect(content.locator("p")).toHaveCount(2);
  });
});
