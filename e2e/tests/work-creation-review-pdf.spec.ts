import { type Page } from "@playwright/test";

import { type SetupData } from "../stack";
import { expect, test } from "../fixtures";
import {
  pdfReviewBornDigitalEditionFixture,
  pdfReviewBornDigitalOriginalFixture,
  pdfReviewScannedEditionFixture,
  pdfReviewScannedOriginalFixture
} from "../pdfFixture";

// #750: a converted PDF — born-digital or OCR-backed — must enter the SAME server-owned duplicate-review
// boundary as Markdown/EPUB/manual, completing the no-client-bypass invariant. This drives the real Library
// front door in a browser through all three review outcomes per conversion lane: an EXACT re-upload reopens
// the claimed Work silently (no panel); a different-bytes EDITION with the same title/author transitions the
// conversion/OCR progress into the SHARED "Possible duplicate" panel, where Open existing reopens and Keep
// separate mints a distinct Work. There is no PDF-specific duplicate UI — the same panel and decisions the
// other formats use drive it.

const DESKTOP = { height: 900, width: 1280 } as const;

type Fixture = Readonly<{ buffer: Buffer; mimeType: string; name: string }>;

// Landing a creation/reopen opens the Manage-content sheet or the Reader (React state / a route), so return
// to a clean shelf with a full reload before the next upload — mirroring the Markdown review spec.
async function returnToShelf(page: Page, setup: SetupData): Promise<void> {
  await page.goto(`${setup.baseURL}#/library`);
  await page.reload();
  // `exact: true`: the shared smoke shelf can carry a Work whose overflow button substring-matches a loose
  // "Add"; pin the primary Add affordance by its exact accessible name so this settle never resolves to two.
  await expect(page.getByRole("button", { name: "Add", exact: true })).toBeVisible();
}

// Upload a PDF fixture and submit the "Add work" confirm form with the seeded Smoke Author. The title
// pre-fills from the filename stem, so both uploads in a lane share it — the second becomes a same-title
// candidate rather than a fresh Work.
async function submitPdf(page: Page, fixture: Fixture, title: string): Promise<void> {
  await page.getByLabel("Upload").setInputFiles(fixture);
  const dialog = page.getByRole("dialog", { name: "Add work" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Title")).toHaveValue(title);

  const authorField = dialog.getByRole("combobox", { name: "Author or source" });
  await authorField.fill("Smoke Author");
  await dialog.getByRole("option", { name: "Smoke Author" }).click();
  await dialog.getByRole("button", { name: "Create work" }).click();
}

// The Work id the Reader currently shows (a published/reopened PDF deep-links to `#/reader?work=<id>`).
function readerWorkId(page: Page): string {
  const id = new URL(page.url().replace("#/", "")).searchParams.get("work");
  expect(id).not.toBeNull();
  return id!;
}

// Drive one conversion lane through all three review outcomes. `original` and `edition` share the confirm
// title but carry different bytes, so the edition is a fuzzy same-title candidate, never an exact re-upload.
async function runReviewLane(
  page: Page,
  setup: SetupData,
  lane: { edition: Fixture; original: Fixture; title: string }
): Promise<void> {
  const { edition, original, title } = lane;
  await page.setViewportSize(DESKTOP);
  await returnToShelf(page, setup);

  // 1) The original has no credible candidate yet, so review publishes it immediately: the converted PDF
  //    opens in the existing Reader as one canonical Work.
  await submitPdf(page, original, title);
  await expect(page).toHaveURL(/#\/reader\?work=/, { timeout: 30000 });
  const originalWorkId = readerWorkId(page);
  await returnToShelf(page, setup);
  await expect(page.getByRole("heading", { name: title })).toHaveCount(1);

  // 2) Exact reopen: re-uploading the identical bytes reopens the SAME Work through its source claim — no
  //    panel, no duplicate. The Reader lands on the original id and the shelf stays at one.
  await submitPdf(page, original, title);
  await expect(page).toHaveURL(/#\/reader\?work=/, { timeout: 30000 });
  expect(readerWorkId(page)).toBe(originalWorkId);
  await returnToShelf(page, setup);
  await expect(page.getByRole("heading", { name: title })).toHaveCount(1);

  // 3) Fuzzy Open existing: a different-bytes edition with the same title/author transitions the conversion
  //    progress into the SHARED review panel, surfacing the original as a factual candidate. Choosing Open
  //    existing reopens it and creates nothing — the count stays one.
  const panel = page.getByRole("dialog", { name: "Possible duplicate" });
  await submitPdf(page, edition, title);
  await expect(panel).toBeVisible({ timeout: 30000 });
  await expect(panel.getByRole("list", { name: "Possible duplicates" })).toBeVisible();
  await expect(panel.getByText("Title match 100%")).toBeVisible();
  await expect(panel.getByText("Same author")).toBeVisible();
  await panel.getByRole("button", { name: `Open existing “${title}”` }).click();
  await expect(page.getByText(`“${title}” is already in your library — opened it.`)).toBeVisible();
  await returnToShelf(page, setup);
  await expect(page.getByRole("heading", { name: title })).toHaveCount(1);

  // 4) Edition Keep separate: the same edition still trips the candidate, but the learner may still commit a
  //    distinct Work. The shelf then holds two under one title — the decision, not the panel, minted it.
  await submitPdf(page, edition, title);
  await expect(panel).toBeVisible({ timeout: 30000 });
  await panel.getByRole("button", { name: "Keep separate" }).click();
  await expect(page.getByText(`Imported “${title}”.`)).toBeVisible();
  await returnToShelf(page, setup);
  await expect(page.getByRole("heading", { name: title })).toHaveCount(2);
}

test("routes a born-digital PDF through the duplicate-review panel and honors each decision (#750)", async ({
  page,
  setup
}: {
  page: Page;
  setup: SetupData;
}) => {
  await runReviewLane(page, setup, {
    edition: pdfReviewBornDigitalEditionFixture,
    original: pdfReviewBornDigitalOriginalFixture,
    title: "PDF Review Born Digital 750"
  });
});

test("routes an OCR-backed PDF through the duplicate-review panel and honors each decision (#750)", async ({
  page,
  setup
}: {
  page: Page;
  setup: SetupData;
}) => {
  await runReviewLane(page, setup, {
    edition: pdfReviewScannedEditionFixture,
    original: pdfReviewScannedOriginalFixture,
    title: "PDF Review Scanned 750"
  });
});
