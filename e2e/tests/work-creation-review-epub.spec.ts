import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures";

// #748: uploading an EPUB whose metadata resembles an existing Work must route through the same
// server-owned duplicate-review boundary Markdown uses (#747), BEFORE anything is created. EPUB has no
// confirm form — the OPF metadata is authoritative — so the file goes straight to the front door:
// exact bytes reopen the owning Work silently (#706); a same-title/same-author upload with DIFFERENT
// bytes surfaces the existing Work as a factual candidate in the shared "Possible duplicate" panel, and
// the learner's semantic decision — Open existing, Keep separate, or Back — is the only way past it. The
// browser never creates around the boundary. "Keep separate" must commit the new EDITION's authored
// navigation and figure images intact. jsdom cannot drive the real upload → parse → review → commit
// loop, so this proves it in an actual browser.

const DESKTOP = { height: 900, width: 1280 } as const;

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "epub");
// Two EDITIONS of one book: identical title + author, DIFFERENT chapter bytes (distinct sha256). The
// first seeds the imported Work; the second is the look-alike that trips the exact title-key candidate.
const editionA = join(fixturesDir, "illustrated-review-edition-a.epub");
const editionB = join(fixturesDir, "illustrated-review-edition-b.epub");
const TITLE = "The Fox Fables — Illustrated Review (748)";

async function uploadEpub(page: Page, fixture: string): Promise<void> {
  await page.getByLabel("Upload").setInputFiles(fixture);
}

async function returnToShelf(page: Page, setup: { baseURL: string }): Promise<void> {
  // A reopen/create lands the Manage-content sheet (React state, not a route), so a hash-only navigation
  // would leave it covering the shelf. A full reload drops back to a clean shelf.
  await page.goto(`${setup.baseURL}#/library`);
  await page.reload();
  await expect(page.getByRole("button", { name: "Add", exact: true })).toBeVisible();
}

test("routes a look-alike EPUB edition through the duplicate-review panel and honors each decision (#748)", async ({
  page,
  setup
}) => {
  await page.setViewportSize(DESKTOP);
  await returnToShelf(page, setup);

  // Seed the original imported Work: a unique title has no candidate, so EPUB commits immediately.
  await uploadEpub(page, editionA);
  await expect(page.getByText(`Imported “${TITLE}”.`)).toBeVisible();
  await returnToShelf(page, setup);
  await expect(page.getByRole("heading", { name: TITLE })).toHaveCount(1);

  // 1) Exact reopen: the identical bytes reopen the owning Work and create nothing — the count stays one
  // and no review panel appears (exact bytes outrank metadata, #706).
  await uploadEpub(page, editionA);
  await expect(page.getByText(`“${TITLE}” is already in your library — opened it.`)).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Possible duplicate" })).toHaveCount(0);
  await returnToShelf(page, setup);
  await expect(page.getByRole("heading", { name: TITLE })).toHaveCount(1);

  // 2) Fuzzy Open existing: the second edition shares the title + author but has new bytes, so it
  // surfaces the seeded Work as a factual candidate. Choosing "Open existing" reopens it — count stays one.
  await uploadEpub(page, editionB);
  const panel = page.getByRole("dialog", { name: "Possible duplicate" });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("list", { name: "Possible duplicates" })).toBeVisible();
  await expect(panel.getByText("Title match 100%")).toBeVisible();
  await expect(panel.getByText("Same author")).toBeVisible();
  await panel.getByRole("button", { name: `Open existing “${TITLE}”` }).click();
  await expect(page.getByText(`“${TITLE}” is already in your library — opened it.`)).toBeVisible();
  await returnToShelf(page, setup);
  await expect(page.getByRole("heading", { name: TITLE })).toHaveCount(1);

  // 3) Keep separate: despite the credible candidate, the learner commits the distinct edition. It lands
  // as a second Work whose authored navigation and figure image are intact.
  await uploadEpub(page, editionB);
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "Keep separate" }).click();
  await expect(page.getByText(`Imported “${TITLE}”.`)).toBeVisible();

  // The Manage-content sheet opens on the just-created edition. Its reading-unit overview proves the
  // authored navigation committed as two units, and the reader proves the figure image committed.
  const units = page.getByRole("list", { name: "Reading units" });
  await expect(units.getByText("The Fox and the Crow")).toBeVisible();
  await expect(units.getByText("The Fox and the Lion")).toBeVisible();

  await page.getByRole("link", { name: "Open in Reader" }).click();
  const reading = page.locator('article[aria-label="Reading"]');
  await expect(reading.getByRole("heading", { name: "The Fox and the Crow" })).toBeVisible();
  await expect(reading.getByRole("img", { name: "Second-edition plate" })).toBeVisible();

  await returnToShelf(page, setup);
  await expect(page.getByRole("heading", { name: TITLE })).toHaveCount(2);
});
