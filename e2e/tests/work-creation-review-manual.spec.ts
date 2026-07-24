import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures";

// #749: creating a Work through the manual "Add work" front door must route through the SAME
// server-owned duplicate-review boundary that Markdown (#747) and EPUB (#748) use, BEFORE anything is
// committed. Manual creation carries no uploaded bytes, so begin only weighs #724 candidates for the
// typed metadata: with none it mints the owned, editable Work immediately and opens its Library editor;
// with a credible one it parks the shared review panel and the learner's semantic decision — Open
// existing, Keep separate, or Back — is the only way past. The browser never creates around the
// boundary; it holds only the opaque attempt from the panel. jsdom cannot run the real Radix menu +
// combobox pointer chain or the hash navigation into the manual editor, so this proves the loop live.

const DESKTOP = { height: 900, width: 1280 } as const;

// Open the manual "Add work" front door, name the proposed title against the seeded "Smoke Author", and
// submit. Returns once the server has answered — either the review panel is up or a toast has landed.
async function submitManual(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("menuitem", { name: "Add work manually" }).click();

  const dialog = page.getByRole("dialog", { name: "Add work" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Title").fill(title);

  const authorField = dialog.getByRole("combobox", { name: "Author or source" });
  await authorField.fill("Smoke Author");
  await dialog.getByRole("option", { name: "Smoke Author" }).click();
  await dialog.getByRole("button", { name: "Create work" }).click();
}

async function returnToShelf(page: Page, setup: { baseURL: string }): Promise<void> {
  // A manual create lands in the Work's editor (a hash route); Open existing lands in Manage content (a
  // React sheet). A full reload from the Library hash drops back to a clean shelf either way.
  await page.goto(`${setup.baseURL}#/library`);
  await page.reload();
  // `exact: true`: the shared smoke shelf carries Works whose "More actions for …" buttons substring-
  // match a loose "Add" name. Pin the primary shelf Add affordance by its exact accessible name.
  await expect(page.getByRole("button", { name: "Add", exact: true })).toBeVisible();
}

test("routes manual Work creation through the duplicate-review panel and honors each decision (#749)", async ({
  page,
  setup
}) => {
  await page.setViewportSize(DESKTOP);
  await returnToShelf(page, setup);

  // Seed the original Work through the manual front door. A unique title has no candidate, so begin
  // mints the owned empty-document Work immediately and routes straight into its manual editor (#749).
  const title = "Manual Duplicate Probe 749";
  await submitManual(page, title);
  await expect(page.getByRole("textbox", { name: `Edit ${title}` })).toBeVisible();
  await returnToShelf(page, setup);
  await expect(page.getByRole("heading", { name: title })).toHaveCount(1);

  // 1) Open existing: a same-title, same-author manual add surfaces the existing Work as a factual
  // candidate. Choosing "Open existing" reopens it and creates nothing — the count stays one.
  await submitManual(page, title);
  const panel = page.getByRole("dialog", { name: "Possible duplicate" });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("list", { name: "Possible duplicates" })).toBeVisible();
  await expect(panel.getByText("Title match 100%")).toBeVisible();
  await expect(panel.getByText("Same author")).toBeVisible();
  await panel.getByRole("button", { name: `Open existing “${title}”` }).click();
  await expect(page.getByText(`“${title}” is already in your library — opened it.`)).toBeVisible();
  await returnToShelf(page, setup);
  await expect(page.getByRole("heading", { name: title })).toHaveCount(1);

  // 2) Back: the same look-alike manual add reopens the panel; going Back cancels the attempt and
  // returns to the still-filled Add-work form (title preserved) without creating anything — count one.
  await submitManual(page, title);
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "Back" }).click();
  const addDialog = page.getByRole("dialog", { name: "Add work" });
  await expect(addDialog).toBeVisible();
  await expect(addDialog.getByLabel("Title")).toHaveValue(title);
  await returnToShelf(page, setup);
  await expect(page.getByRole("heading", { name: title })).toHaveCount(1);

  // 3) Keep separate: despite the credible candidate the learner may still commit a distinct Work. A
  // manual Keep separate is "Added" and opens the new Work's editor — the shelf then holds two.
  await submitManual(page, title);
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "Keep separate" }).click();
  await expect(page.getByRole("textbox", { name: `Edit ${title}` })).toBeVisible();
  await returnToShelf(page, setup);
  await expect(page.getByRole("heading", { name: title })).toHaveCount(2);
});
