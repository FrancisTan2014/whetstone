import { type Page } from "@playwright/test";

import { type SetupData } from "../stack";
import { expect, test } from "../fixtures";
import { pdfMixedFixture, pdfScannedFixture } from "../pdfFixture";

// #745: an English scanned or mixed PDF upload runs OCR as one durable phase of the #721 import attempt,
// before #701 structured conversion, then publishes ONE canonical Work that opens in the existing Reader.
// The env-gated fixture OCR lane (PDF_IMPORT_FIXTURE_OCR=1) transforms the ACTUAL uploaded bytes — flipping
// the text-less pages to native and injecting recovered English text — so the journey is honest end to end
// with no OCR toolchain in CI. This drives the real Library front door: a scanned upload adds English text
// and reads/searches/annotates/resumes on canonical blocks, and a mixed upload keeps its native page while
// OCR fills the scanned page.

const DESKTOP = { height: 900, width: 1280 } as const;
const READING = 'article[aria-label="Reading"]';
const RECOVERED_PAGE_1 = "Recovered English text from page 1 via OCR.";
const RECOVERED_PAGE_2 = "Recovered English text from page 2 via OCR.";

async function blockContaining(
  page: Page,
  needle: string
): Promise<{ blockEntryId: string; text: string }> {
  const found = (await page.evaluate(
    ([reading, want]) => {
      for (const block of Array.from(document.querySelectorAll(`${reading} [data-block-id]`))) {
        const text = block.textContent ?? "";
        const blockEntryId = block.getAttribute("data-block-id");
        if (blockEntryId !== null && text.includes(want)) {
          return { blockEntryId, text };
        }
      }
      return null;
    },
    [READING, needle] as const
  )) as { blockEntryId: string; text: string } | null;
  expect(found).not.toBeNull();
  return found!;
}

async function reloadReader(page: Page, readerUrl: string): Promise<void> {
  await page.goto("about:blank");
  await page.goto(readerUrl);
  await expect(page.locator(`${READING} [data-block-id]`).first()).toBeVisible();
}

async function uploadAndOpen(
  page: Page,
  setup: SetupData,
  fixture: typeof pdfScannedFixture,
  expectedTitle: string
): Promise<string> {
  await page.goto(`${setup.baseURL}#/library`);
  await expect(page.getByRole("button", { name: "Add" })).toBeVisible();

  await page.getByLabel("Upload").setInputFiles(fixture);
  const dialog = page.getByRole("dialog", { name: "Add work" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Title")).toHaveValue(expectedTitle);

  const authorField = dialog.getByRole("combobox", { name: "Author or source" });
  await authorField.fill("Smoke Author");
  await dialog.getByRole("option", { name: "Smoke Author" }).click();
  await dialog.getByRole("button", { name: "Create work" }).click();

  // OCR + conversion + publication all run as background phases; navigation never cancels them. When it
  // publishes, the Library opens the Reader on the new Work.
  await expect(page).toHaveURL(/#\/reader\?work=/, { timeout: 30000 });
  await expect(page.locator(`${READING} [data-block-id]`).first()).toBeVisible();
  return page.url();
}

test("imports a scanned English PDF through OCR, then reads, searches, annotates, and resumes it (#745)", async ({
  page,
  setup
}: {
  page: Page;
  setup: SetupData;
}) => {
  await page.setViewportSize(DESKTOP);
  const readerUrl = await uploadAndOpen(page, setup, pdfScannedFixture, "Scanned English Page");
  const workEntryId = new URL(readerUrl.replace("#/", "")).searchParams.get("work");
  expect(workEntryId).not.toBeNull();

  // The scanned page had no native text; OCR added English text, which the canonical Reader now renders.
  const reading = page.locator(READING);
  await expect(reading.getByText(RECOVERED_PAGE_1, { exact: false })).toBeVisible();

  // The OCR'd text is indexed like any other canonical content.
  await page.goto(`${setup.baseURL}#/search`);
  await page.getByRole("searchbox", { name: "Search query" }).fill("Recovered English text");
  await page.getByRole("button", { name: "Search" }).click();
  const results = page.getByRole("list", { name: "Search results" });
  await expect(results.getByText("Scanned English Page", { exact: false })).toBeVisible();

  // Annotation + reload operate on the OCR'd canonical blocks with no PDF-specific path (resume).
  await reloadReader(page, readerUrl);
  const block = await blockContaining(page, RECOVERED_PAGE_1);
  const word = "Recovered";
  const startOffset = block.text.indexOf(word);
  expect(startOffset).toBeGreaterThanOrEqual(0);
  const marked = await page.request.post(
    `${setup.baseURL}api/works/${encodeURIComponent(workEntryId!)}/marks`,
    {
      data: {
        anchor: {
          blockEntryId: block.blockEntryId,
          contextSnapshot: word,
          endOffset: startOffset + word.length,
          selectedTextSnapshot: word,
          startOffset
        }
      }
    }
  );
  expect(marked.status()).toBe(201);

  await reloadReader(page, readerUrl);
  await expect(page.getByRole("button", { name: `Open mark on '${word}'` })).toBeVisible();
});

test("imports a mixed English PDF, preserving the native page while OCR fills the scanned page (#745)", async ({
  page,
  setup
}: {
  page: Page;
  setup: SetupData;
}) => {
  await page.setViewportSize(DESKTOP);
  await uploadAndOpen(page, setup, pdfMixedFixture, "Mixed Scan Report");

  // The mixed document keeps its born-digital page-1 text AND gains the OCR'd page-2 text, in order, in the
  // same opening unit (the title heading opens it; both paragraphs follow).
  const reading = page.locator(READING);
  await expect(reading.getByText("Mixed Scan Report", { exact: false })).toBeVisible();
  await expect(
    reading.getByText("keeps its native text through the OCR phase", { exact: false })
  ).toBeVisible();
  await expect(reading.getByText(RECOVERED_PAGE_2, { exact: false })).toBeVisible();
});
