import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures";

// #706: uploading identical bytes again must REOPEN the existing Work through the shared SHA-256
// source-claim boundary, never mint a duplicate. This drives the real Library upload front door in a
// browser for both mint formats — EPUB (`/api/works/epub`) and imported Markdown (the atomic
// `/api/works/markdown`) — uploading each fixture twice and proving exactly one Work survives per
// source. The EPUB fixture is `aesop-fables.epub`, which `stack.ts` already seeds once, so the two
// browser re-uploads here must keep that Work at a count of one.

const DESKTOP = { height: 900, width: 1280 } as const;

const epubFixture = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "epub",
  "aesop-fables.epub"
);

// A deterministic Markdown payload with real block content (heading + paragraph) so it mints a Work
// rather than tripping the empty-content guard. Re-uploading these exact bytes must reopen it.
const markdownTitle = "Reopen Source Probe 706";
const markdownBytes = Buffer.from(
  `# Chapter One\n\nA durable paragraph proving the imported Markdown source reopens on re-upload.\n`,
  "utf8"
);

async function uploadEpub(page: Page, title: string): Promise<void> {
  await page.getByLabel("Upload").setInputFiles(epubFixture);
  // The seeded EPUB already owns these exact bytes, so every browser upload reopens that Work (#706):
  // EPUB ingests straight through (no confirm form), the shelf toasts "already in your library", and
  // drops the learner into the reopened Work — never minting a duplicate.
  await expect(page.getByText(`“${title}” is already in your library — opened it.`)).toBeVisible();
}

async function uploadMarkdown(page: Page, expectReopen: boolean): Promise<void> {
  await page.getByLabel("Upload").setInputFiles({
    buffer: markdownBytes,
    mimeType: "text/markdown",
    name: "Reopen Source Probe 706.md"
  });

  // PDF/Markdown hold the file behind the "Add work" confirm form, pre-filling the title.
  const dialog = page.getByRole("dialog", { name: "Add work" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Title")).toHaveValue(markdownTitle);

  // Reuse the seeded "Smoke Author" so the author exists as a selectable option on every upload.
  const authorField = dialog.getByRole("combobox", { name: "Author or source" });
  await authorField.fill("Smoke Author");
  await dialog.getByRole("option", { name: "Smoke Author" }).click();
  await dialog.getByRole("button", { name: "Create work" }).click();

  const toast = expectReopen
    ? page.getByText(`“${markdownTitle}” is already in your library — opened it.`)
    : page.getByText(`Imported “${markdownTitle}”.`);
  await expect(toast).toBeVisible();
}

test("re-uploading identical EPUB and Markdown bytes reopens one Work each (#706)", async ({
  page,
  setup
}) => {
  await page.setViewportSize(DESKTOP);
  await page.goto(`${setup.baseURL}#/library`);
  await expect(page.getByRole("button", { name: "Add" })).toBeVisible();

  // The seeded EPUB is already on the shelf exactly once.
  const epubHeading = page.getByRole("heading", { name: setup.epub.title });
  await expect(epubHeading).toHaveCount(1);

  // Two more uploads of the identical EPUB bytes must reopen it — the count stays one. Each reopen
  // drops into Manage content, so return to the shelf between uploads before re-triggering Upload.
  await uploadEpub(page, setup.epub.title);
  await page.goto(`${setup.baseURL}#/library`);
  await expect(page.getByRole("heading", { name: setup.epub.title })).toHaveCount(1);

  await uploadEpub(page, setup.epub.title);
  await page.goto(`${setup.baseURL}#/library`);
  await expect(page.getByRole("heading", { name: setup.epub.title })).toHaveCount(1);

  // First Markdown upload mints the imported Work through the atomic front door.
  await uploadMarkdown(page, false);
  await page.goto(`${setup.baseURL}#/library`);
  await expect(page.getByRole("heading", { name: markdownTitle })).toHaveCount(1);

  // Re-uploading the identical Markdown bytes reopens that same Work — still exactly one.
  await uploadMarkdown(page, true);
  await page.goto(`${setup.baseURL}#/library`);
  await expect(page.getByRole("heading", { name: markdownTitle })).toHaveCount(1);
});
