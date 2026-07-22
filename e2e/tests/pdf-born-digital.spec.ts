import { type Page } from "@playwright/test";

import { type SetupData } from "../stack";
import { expect, test } from "../fixtures";

// #702: a born-digital PDF upload flows through #721's staged attempt and publishes ONE canonical
// Author -> Work -> ReadingUnit -> Block Work (doc_blocks only) that opens in the existing Reader — no
// Markdown, no page viewer, no empty shell. The keyless conversion lane converts every upload to the
// deterministic multi-section born-digital preview document (pdfImportSampleDocument.ts), so this drives
// the real Library front door in a browser: upload -> confirm -> progress -> Reader, then proves the
// published canonical blocks are read, searched, annotated, and resurvive a reload through the ordinary
// product surfaces (which never branch on PDF).

const DESKTOP = { height: 900, width: 1280 } as const;
const READING = 'article[aria-label="Reading"]';

const pdfFixture = {
  buffer: Buffer.from("%PDF-1.7\nborn-digital sample bytes for the #702 e2e\n%%EOF\n", "utf8"),
  mimeType: "application/pdf",
  name: "Multi Section Sample.pdf"
} as const;

// The block id and rendered plaintext of the reader block whose prose contains `needle`.
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

test("uploads a born-digital PDF, publishes it, then reads, searches, annotates, and resumes it (#702)", async ({
  page,
  setup
}: {
  page: Page;
  setup: SetupData;
}) => {
  await page.setViewportSize(DESKTOP);
  await page.goto(`${setup.baseURL}#/library`);
  await expect(page.getByRole("button", { name: "Add" })).toBeVisible();

  // Upload streams into the staged attempt behind the "Add work" confirm form, pre-filling the title
  // from the filename stem (never a raw path).
  await page.getByLabel("Upload").setInputFiles(pdfFixture);
  const dialog = page.getByRole("dialog", { name: "Add work" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Title")).toHaveValue("Multi Section Sample");

  // Reuse the seeded author so it exists as a selectable option.
  const authorField = dialog.getByRole("combobox", { name: "Author or source" });
  await authorField.fill("Smoke Author");
  await dialog.getByRole("option", { name: "Smoke Author" }).click();
  await dialog.getByRole("button", { name: "Create work" }).click();

  // The import runs as a background job; navigation never cancels it. When it publishes, the Library
  // opens the Reader on the new Work (deep link `#/reader?work=<id>`).
  await expect(page).toHaveURL(/#\/reader\?work=/, { timeout: 30000 });
  await expect(page.locator(`${READING} [data-block-id]`).first()).toBeVisible();
  const readerUrl = page.url();
  const workEntryId = new URL(readerUrl.replace("#/", "")).searchParams.get("work");
  expect(workEntryId).not.toBeNull();

  // The structured body mapped to canonical blocks across THREE ordered ReadingUnits — the mapping
  // starts a new unit at each heading (work title, then each section header), exactly as the acceptance
  // criteria derive units from the heading tree. The existing Reader renders one unit at a time; unit 1 is
  // the work title + intro paragraph.
  const reading = page.locator(READING);
  await expect(reading.getByText("Born-Digital Preview", { exact: false })).toBeVisible();
  await expect(
    reading.getByText("through the canonical block pipeline", { exact: false })
  ).toBeVisible();

  // Existing library search operates on the published canonical blocks (doc_blocks), deep-linking back
  // to this Work — proving the PDF content is indexed like any other source.
  await page.goto(`${setup.baseURL}#/search`);
  await page.getByRole("searchbox", { name: "Search query" }).fill("canonical block pipeline");
  await page.getByRole("button", { name: "Search" }).click();
  const results = page.getByRole("list", { name: "Search results" });
  await expect(results.getByText("Multi Section Sample", { exact: false })).toBeVisible();

  // Existing annotation operates on the canonical blocks: seed a highlight on a mapped block in the
  // opening unit through the ordinary marks API, then reload the Reader and confirm the inline underline
  // renders (resume + notes on canonical content, no PDF-specific path).
  await reloadReader(page, readerUrl);
  const block = await blockContaining(page, "canonical block pipeline");
  const word = "canonical";
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

  // The remaining ReadingUnits are reachable through the Reader's ordinary chapter pager (no PDF-specific
  // surface): each section header started its own unit, carrying its list and table blocks as canonical
  // content — proving multiple ordered units mapped and render like any multi-chapter Work.
  const pager = page.locator('nav[aria-label="Chapter navigation"]');
  await pager.getByRole("button", { name: /Next/ }).click();
  await expect(reading.getByText("How Import Works", { exact: false })).toBeVisible();
  await expect(
    reading.getByText("Structure and geometry are retained only as ingestion evidence.", {
      exact: false
    })
  ).toBeVisible();

  await pager.getByRole("button", { name: /Next/ }).click();
  await expect(reading.getByText("What Remains", { exact: false })).toBeVisible();
  await expect(reading.getByText("Born-digital import", { exact: false })).toBeVisible();
});
