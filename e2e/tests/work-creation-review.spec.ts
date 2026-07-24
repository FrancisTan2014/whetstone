import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures";

// #747: importing Markdown whose metadata resembles an existing Work must route through the
// server-owned duplicate-review boundary BEFORE anything is created. This drives the real Library
// upload front door in a browser: a same-title / same-author upload with different bytes surfaces the
// existing Work as a factual candidate in the "Possible duplicate" panel, and the learner's semantic
// decision — Open existing, Keep separate, or Back — is the only way past review. The browser never
// creates around the boundary; it holds only the opaque attempt from the panel.

const DESKTOP = { height: 900, width: 1280 } as const;

// Distinct bytes per upload so none is an EXACT re-upload (that path reopens silently, #706). Identical
// title + author with DIFFERENT bytes is what trips the exact title-key candidate and opens the panel.
function markdownUpload(title: string, body: string): { buffer: Buffer; mimeType: string; name: string } {
  return {
    buffer: Buffer.from(`# ${body}\n\nA durable paragraph for “${title}”.\n`, "utf8"),
    mimeType: "text/markdown",
    name: `${title}.md`
  };
}

// Upload Markdown and fill the "Add work" confirm form with the seeded "Smoke Author", then submit.
// Returns once the server has answered — either the review panel is up or a toast has landed.
async function submitMarkdown(page: Page, title: string, body: string): Promise<void> {
  await page.getByLabel("Upload").setInputFiles(markdownUpload(title, body));

  const dialog = page.getByRole("dialog", { name: "Add work" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Title")).toHaveValue(title);

  const authorField = dialog.getByRole("combobox", { name: "Author or source" });
  await authorField.fill("Smoke Author");
  await dialog.getByRole("option", { name: "Smoke Author" }).click();
  await dialog.getByRole("button", { name: "Create work" }).click();
}

async function returnToShelf(page: Page, setup: { baseURL: string }): Promise<void> {
  // Landing a creation/reopen opens the Manage-content sheet (React state, not a route), so a hash-only
  // navigation would leave it covering the shelf. A full reload drops back to a clean shelf.
  await page.goto(`${setup.baseURL}#/library`);
  await page.reload();
  await expect(page.getByRole("button", { name: "Add" })).toBeVisible();
}

test("routes look-alike Markdown through the duplicate-review panel and honors each decision (#747)", async ({
  page,
  setup
}) => {
  await page.setViewportSize(DESKTOP);
  await returnToShelf(page, setup);

  // Seed the original imported Work through the atomic front door.
  const title = "Duplicate Review Probe 747";
  await submitMarkdown(page, title, "Original body");
  await expect(page.getByText(`Imported “${title}”.`)).toBeVisible();
  await returnToShelf(page, setup);
  await expect(page.getByRole("heading", { name: title })).toHaveCount(1);

  // 1) Open existing: a same-title, same-author upload with new bytes surfaces the existing Work as a
  // factual candidate. Choosing "Open existing" reopens it and creates nothing — the count stays one.
  await submitMarkdown(page, title, "Second body");
  const panel = page.getByRole("dialog", { name: "Possible duplicate" });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("list", { name: "Possible duplicates" })).toBeVisible();
  await expect(panel.getByText("Title match 100%")).toBeVisible();
  await expect(panel.getByText("Same author")).toBeVisible();
  await panel.getByRole("button", { name: `Open existing “${title}”` }).click();
  await expect(page.getByText(`“${title}” is already in your library — opened it.`)).toBeVisible();
  await returnToShelf(page, setup);
  await expect(page.getByRole("heading", { name: title })).toHaveCount(1);

  // 2) Back: the same look-alike upload reopens the panel; going Back cancels the attempt and returns to
  // the still-filled Add-work form (title preserved) without creating anything — the count stays one.
  await submitMarkdown(page, title, "Third body");
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "Back" }).click();
  const addDialog = page.getByRole("dialog", { name: "Add work" });
  await expect(addDialog).toBeVisible();
  await expect(addDialog.getByLabel("Title")).toHaveValue(title);
  await returnToShelf(page, setup);
  await expect(page.getByRole("heading", { name: title })).toHaveCount(1);

  // 3) Keep separate: despite the credible candidate, the learner may still commit a distinct Work. The
  // shelf then holds two Works under the same title — the decision, not the panel, minted the second.
  await submitMarkdown(page, title, "Fourth body");
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "Keep separate" }).click();
  await expect(page.getByText(`Imported “${title}”.`)).toBeVisible();
  await returnToShelf(page, setup);
  await expect(page.getByRole("heading", { name: title })).toHaveCount(2);
});
