import { type Page } from "@playwright/test";

import { type SetupData } from "../stack";
import { chooseBlockStyle } from "../select";
import { expect, test } from "../fixtures";

// The shared Work editor composition-workspace regression (#791). The reported bug was a ~258px editor
// squeezed beside an always-present empty Outline sidebar. jsdom cannot lay out the responsive grid, the
// sticky attached toolbar, or the sidebar-vs-drawer breakpoint, so these prove the real layout in the
// browser: a wide centered document, no empty-Outline track, a one-row attached toolbar, and a populated
// Outline that is a sticky sidebar at desktop widths and an overlay drawer below 80rem — without page
// overflow. Fails before the fix (narrow editor, permanent empty sidebar), passes after.

const DESKTOP = { height: 768, width: 1440 } as const;
const TABLET = { height: 900, width: 768 } as const;
const PHONE = { height: 851, width: 390 } as const;

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

// The px value of one rem, so the rem-denominated acceptance thresholds compare against the real root
// font size rather than assuming 16px.
async function remPx(page: Page): Promise<number> {
  return page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
}

test("1440×768 headingless Work: wide centered document, no empty Outline track, one-row toolbar", async ({
  page,
  setup
}) => {
  await page.setViewportSize({ height: DESKTOP.height, width: DESKTOP.width });

  const title = "Workspace regression";
  const workEntryId = await createManualWork(page, setup, title);

  await page.goto(`${setup.baseURL}#/library/works/${encodeURIComponent(workEntryId)}/edit`);
  const editor = page.getByRole("textbox", { name: `Edit ${title}` });
  await expect(editor).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Saved");

  const rem = await remPx(page);

  // A headingless Work reserves NO Outline track: the sidebar/drawer is absent and section creation is a
  // single 44px control above the canvas — the exact regression (an empty permanent sidebar) reversed.
  const workspace = page.locator(".manualWorkWorkspace");
  await expect(workspace).toHaveAttribute("data-outline", "empty");
  await expect(page.getByRole("navigation", { name: "Outline" })).toHaveCount(0);
  const addSection = page.getByRole("button", { name: "Add section after current" });
  await expect(addSection).toBeVisible();
  const addBox = await addSection.boundingBox();
  expect(addBox!.height).toBeGreaterThanOrEqual(44);

  // The document surface is wide and centered: at 1440×768 the paper is at least 52rem, not ~258px.
  const paper = page.locator('[data-presentation="work"]');
  const paperBox = await paper.boundingBox();
  expect(paperBox!.width).toBeGreaterThanOrEqual(52 * rem);
  // Centered within its own column (the canvas centers via margin-inline:auto inside the workspace),
  // with roughly equal left/right slack — not pinned to one edge.
  const workspaceBox = await workspace.boundingBox();
  const leftSlack = paperBox!.x - workspaceBox!.x;
  const rightSlack = workspaceBox!.x + workspaceBox!.width - (paperBox!.x + paperBox!.width);
  expect(Math.abs(leftSlack - rightSlack)).toBeLessThan(2 * rem);

  // The formatting bar is one attached row: sticky, non-wrapping, and at most 56px tall.
  const toolbar = page.getByRole("toolbar", { exact: true, name: "Formatting" });
  await expect(toolbar).toBeVisible();
  const toolbarBox = await toolbar.boundingBox();
  expect(toolbarBox!.height).toBeLessThanOrEqual(56);
  expect(await toolbar.evaluate((el) => getComputedStyle(el).flexWrap)).toBe("nowrap");
  expect(await toolbar.evaluate((el) => getComputedStyle(el).position)).toBe("sticky");

  // The body reserves a tall composition area: at least 32rem even at this short viewport.
  const bodyBox = await editor.boundingBox();
  expect(bodyBox!.height).toBeGreaterThanOrEqual(32 * rem);
});

test("populated Outline is a sticky sidebar at 1440 and an overlay drawer below 80rem without page overflow", async ({
  page,
  setup
}) => {
  await page.setViewportSize({ height: DESKTOP.height, width: DESKTOP.width });

  const title = "Workspace outline";
  const workEntryId = await createManualWork(page, setup, title);

  await page.goto(`${setup.baseURL}#/library/works/${encodeURIComponent(workEntryId)}/edit`);
  const editor = page.getByRole("textbox", { name: `Edit ${title}` });
  await expect(editor).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Saved");

  const rem = await remPx(page);

  // Draft two headings in the single seeded section so the live Outline projects a two-entry hierarchy
  // (one heading alone is not a useful outline). The caret's block is what each style targets.
  await editor.click();
  await page.keyboard.type("Alpha");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Gamma");
  await editor.getByText("Alpha", { exact: true }).click();
  await chooseBlockStyle(page, "Heading 1");
  await editor.getByText("Gamma", { exact: true }).click();
  await chooseBlockStyle(page, "Heading 2");

  // At 1440 (>= 80rem) the Outline is an always-visible sticky sidebar ~14rem wide; its drawer toggle is
  // hidden. The workspace reserves the sidebar track.
  const workspace = page.locator(".manualWorkWorkspace");
  await expect(workspace).toHaveAttribute("data-outline", "populated");
  const outlineNav = page.getByRole("navigation", { name: "Outline" });
  await expect(outlineNav.getByRole("button", { name: "Alpha" })).toBeVisible();
  await expect(page.getByRole("button", { exact: true, name: "Outline" })).toBeHidden();
  const sidebarBox = await page.locator(".workOutline").boundingBox();
  expect(Math.abs(sidebarBox!.width - 14 * rem)).toBeLessThan(0.5 * rem);

  // Shrink to 768 (48–79.999rem): the sidebar collapses to a 44px toggle opening a 20rem overlay drawer.
  await page.setViewportSize({ height: TABLET.height, width: TABLET.width });
  const toggle = page.getByRole("button", { exact: true, name: "Outline" });
  await expect(toggle).toBeVisible();
  const toggleBox = await toggle.boundingBox();
  expect(toggleBox!.height).toBeGreaterThanOrEqual(44);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const drawerBox = await outlineNav.boundingBox();
  expect(Math.abs(drawerBox!.width - 20 * rem)).toBeLessThan(1 * rem);
  // Escape dismisses the drawer and restores focus to the control that opened it.
  await page.keyboard.press("Escape");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toBeFocused();

  // Shrink to 390 (below 48rem): the drawer is full viewport width, the page never scrolls horizontally,
  // and the attached toolbar stays a single (horizontally scrollable) row.
  await page.setViewportSize({ height: PHONE.height, width: PHONE.width });
  await page.getByRole("button", { exact: true, name: "Outline" }).click();
  const phoneDrawerBox = await outlineNav.boundingBox();
  expect(phoneDrawerBox!.width).toBeGreaterThanOrEqual(PHONE.width - 1);
  const noHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth
  );
  expect(noHorizontalOverflow).toBe(true);
  await page.keyboard.press("Escape");
  const toolbar = page.getByRole("toolbar", { exact: true, name: "Formatting" });
  const toolbarBox = await toolbar.boundingBox();
  expect(toolbarBox!.height).toBeLessThanOrEqual(56);
  expect(await toolbar.evaluate((el) => getComputedStyle(el).flexWrap)).toBe("nowrap");
});
