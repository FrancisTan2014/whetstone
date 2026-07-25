import { type Page } from "@playwright/test";

import { type SetupData } from "../stack";
import { expect, test } from "../fixtures";
import {
  pdfScannedChineseSimplifiedFixture,
  pdfScannedChineseTraditionalFixture
} from "../pdfFixture";

// #746: a scanned Chinese PDF upload runs OCR in the language the learner chooses BEFORE starting — the
// pre-import scanned-text override — as one durable phase of the #721 import attempt, then publishes ONE
// canonical Work that opens in the existing Reader. The env-gated fixture OCR lane (PDF_IMPORT_FIXTURE_OCR=1)
// transforms the ACTUAL uploaded bytes, flipping the text-less page to native and injecting recovered text in
// the chosen script, so the journey is honest end to end with no OCR toolchain in CI. The override is set
// while the Work language stays English, proving the OCR language is driven by the explicit choice, not the
// Work language.

const DESKTOP = { height: 900, width: 1280 } as const;
const READING = 'article[aria-label="Reading"]';
const RECOVERED_SIMPLIFIED = "第 1 页通过 OCR 识别出的简体中文文本。";
const RECOVERED_TRADITIONAL = "第 1 頁透過 OCR 辨識出的繁體中文文字。";

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

// Upload a scanned fixture, choose the scanned-text OCR language (the pre-import override) while leaving the
// Work language at its English default, and start the import. Returns the Reader URL once it publishes.
async function uploadWithOcrLanguageAndOpen(
  page: Page,
  setup: SetupData,
  fixture: typeof pdfScannedChineseSimplifiedFixture,
  expectedTitle: string,
  ocrLanguage: "zh-CN" | "zh-TW"
): Promise<string> {
  await page.goto(`${setup.baseURL}#/library`);
  await expect(page.getByRole("button", { name: "Add" })).toBeVisible();

  await page.getByLabel("Upload").setInputFiles(fixture);
  const dialog = page.getByRole("dialog", { name: "Add work" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Title")).toHaveValue(expectedTitle);

  // The scanned-text language control only appears for a held PDF; selecting it sets the OCR override.
  await dialog.getByLabel("Scanned-text language").selectOption(ocrLanguage);

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

test("imports a scanned Simplified-Chinese PDF via the OCR override, then reads, searches, annotates, and resumes it (#746)", async ({
  page,
  setup
}: {
  page: Page;
  setup: SetupData;
}) => {
  await page.setViewportSize(DESKTOP);
  const readerUrl = await uploadWithOcrLanguageAndOpen(
    page,
    setup,
    pdfScannedChineseSimplifiedFixture,
    "Scanned Simplified Chinese Page",
    "zh-CN"
  );
  const workEntryId = new URL(readerUrl.replace("#/", "")).searchParams.get("work");
  expect(workEntryId).not.toBeNull();

  // The scanned page had no native text; OCR in the chosen Simplified-Chinese language added the text, which
  // the canonical Reader now renders.
  const reading = page.locator(READING);
  await expect(reading.getByText(RECOVERED_SIMPLIFIED, { exact: false })).toBeVisible();

  // The OCR'd Chinese text is indexed like any other canonical content.
  await page.goto(`${setup.baseURL}#/search`);
  await page.getByRole("searchbox", { name: "Search query" }).fill("简体中文文本");
  await page.getByRole("button", { name: "Search" }).click();
  const results = page.getByRole("list", { name: "Search results" });
  await expect(
    results.getByText("Scanned Simplified Chinese Page", { exact: false })
  ).toBeVisible();

  // Annotation + reload operate on the OCR'd canonical blocks with no PDF-specific path (resume).
  await reloadReader(page, readerUrl);
  const block = await blockContaining(page, RECOVERED_SIMPLIFIED);
  const phrase = "简体中文";
  const startOffset = block.text.indexOf(phrase);
  expect(startOffset).toBeGreaterThanOrEqual(0);
  const marked = await page.request.post(
    `${setup.baseURL}api/works/${encodeURIComponent(workEntryId!)}/marks`,
    {
      data: {
        anchor: {
          blockEntryId: block.blockEntryId,
          contextSnapshot: phrase,
          endOffset: startOffset + phrase.length,
          selectedTextSnapshot: phrase,
          startOffset
        }
      }
    }
  );
  expect(marked.status()).toBe(201);

  await reloadReader(page, readerUrl);
  await expect(page.getByRole("button", { name: `Open mark on '${phrase}'` })).toBeVisible();
});

test("imports a scanned Traditional-Chinese PDF via the OCR override and recognizes the Traditional script (#746)", async ({
  page,
  setup
}: {
  page: Page;
  setup: SetupData;
}) => {
  await page.setViewportSize(DESKTOP);
  await uploadWithOcrLanguageAndOpen(
    page,
    setup,
    pdfScannedChineseTraditionalFixture,
    "Scanned Traditional Chinese Page",
    "zh-TW"
  );

  // The chosen Traditional-Chinese language produces the Traditional script, distinct from the Simplified run.
  const reading = page.locator(READING);
  await expect(reading.getByText(RECOVERED_TRADITIONAL, { exact: false })).toBeVisible();
});
