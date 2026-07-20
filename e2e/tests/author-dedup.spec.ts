import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures";

// #694: adding two Works whose author names are canonically the same (differing only by case/width)
// must reuse ONE author. This drives the real Library "Add work" combobox in a browser: the first Work
// creates the author, the second finds and reuses it from the search list, and the shelf ends with a
// single author group holding both Works — no accidental duplicate identity.

const DESKTOP = { height: 900, width: 1280 } as const;

async function openAddWorkSheet(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Add" }).click();
  await page.getByRole("menuitem", { name: "Add work manually" }).click();
  await expect(page.getByRole("dialog", { name: "Add work" })).toBeVisible();
}

test("reuses one author across two Works added through the Library combobox (#694)", async ({
  page,
  setup
}) => {
  await page.setViewportSize(DESKTOP);
  await page.goto(`${setup.baseURL}#/library`);
  await expect(page.getByRole("button", { name: "Add" })).toBeVisible();

  // First Work: the typed author does not exist yet, so commit it via the explicit "Add" option.
  await openAddWorkSheet(page);
  await page.getByLabel("Title").fill("The Left Hand of Darkness");
  const authorField = page.getByRole("combobox", { name: "Author or source" });
  await authorField.fill("Ursula K. Le Guin");
  await page.getByRole("option", { name: /Add .Ursula K\. Le Guin./ }).click();
  await page.getByRole("button", { name: "Create work" }).click();

  const group = page.getByRole("region", { name: "Ursula K. Le Guin" });
  await expect(group).toHaveCount(1);
  await expect(
    group.getByRole("heading", { name: "The Left Hand of Darkness" })
  ).toBeVisible();

  // Second Work: type the SAME author with different case. The server-canonical search surfaces the
  // existing author as a selectable option (no "Add"); picking it reuses the identity.
  await openAddWorkSheet(page);
  await page.getByLabel("Title").fill("The Dispossessed");
  const authorFieldAgain = page.getByRole("combobox", { name: "Author or source" });
  await authorFieldAgain.fill("ursula k. le guin");
  await expect(page.getByRole("option", { name: /Add /i })).toHaveCount(0);
  await page.getByRole("option", { name: "Ursula K. Le Guin" }).click();
  await page.getByRole("button", { name: "Create work" }).click();

  // One author group, both Works under it — the duplicate author was prevented end to end.
  const finalGroup = page.getByRole("region", { name: "Ursula K. Le Guin" });
  await expect(finalGroup).toHaveCount(1);
  await expect(finalGroup.getByRole("heading", { name: "The Left Hand of Darkness" })).toBeVisible();
  await expect(finalGroup.getByRole("heading", { name: "The Dispossessed" })).toBeVisible();
});
