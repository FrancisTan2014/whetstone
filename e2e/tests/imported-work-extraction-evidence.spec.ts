import { type Page } from "@playwright/test";

import { type SetupData } from "../stack";
import { expect, test } from "../fixtures";
import { pdfExtractionEvidenceFixture } from "../pdfFixture";

// The PDF extraction-evidence correction journey (#763): upload a mixed-confidence born-digital PDF (one
// paragraph the extractor was unsure about, the rest high-confidence), open the published Work in the
// SHARED Library correction editor, and prove the guidance loop end to end in a real browser — jsdom can
// neither lay out the ProseMirror decorations nor run the save/refetch transaction this exercises. Only the
// low-confidence block is cued; its keyboard "Review extraction" disclosure reveals the SAFE source facts
// (page, label, confidence band) and a high-confidence block carries none. After correcting that one block
// and saving, its warning cue clears while its disclosure remains (reframed) and the immutable evidence row
// is unchanged — exactly the acceptance loop: correct one flagged block, save, reload, only that cue clears.

const DESKTOP = { height: 900, width: 1280 } as const;
const LOW_CONFIDENCE_TEXT = "This paragraph mapped with low extractor confidence.";
const HIGH_CONFIDENCE_TEXT = "This paragraph mapped cleanly with high extractor confidence.";

// Upload the mixed-confidence fixture through the real Library front door and wait until it publishes and
// the Library deep-links the Reader, returning the new Work's id.
async function publishEvidenceWork(page: Page, setup: SetupData): Promise<string> {
  await page.goto(`${setup.baseURL}#/library`);
  await expect(page.getByRole("button", { name: "Add" })).toBeVisible();

  await page.getByLabel("Upload").setInputFiles({
    buffer: pdfExtractionEvidenceFixture.buffer,
    mimeType: pdfExtractionEvidenceFixture.mimeType,
    name: pdfExtractionEvidenceFixture.name
  });
  const dialog = page.getByRole("dialog", { name: "Add work" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Title")).toHaveValue("Extraction Evidence Sample");

  const authorField = dialog.getByRole("combobox", { name: "Author or source" });
  await authorField.fill("Smoke Author");
  await dialog.getByRole("option", { name: "Smoke Author" }).click();
  await dialog.getByRole("button", { name: "Create work" }).click();

  await expect(page).toHaveURL(/#\/reader\?work=/, { timeout: 30000 });
  await expect(page.locator('article[aria-label="Reading"] [data-block-id]').first()).toBeVisible();
  const workId = new URL(page.url().replace("#/", "")).searchParams.get("work");
  expect(workId).not.toBeNull();
  return workId!;
}

test("guides PDF correction with extraction evidence: only a corrected block's cue clears (#763)", async ({
  page,
  setup
}: {
  page: Page;
  setup: SetupData;
}) => {
  await page.setViewportSize(DESKTOP);
  const workId = await publishEvidenceWork(page, setup);

  // Open the shared correction editor for the published PDF Work.
  await page.goto(`${setup.baseURL}#/library/works/${encodeURIComponent(workId)}/correct`);
  const editor = page.getByRole("textbox", { name: "Edit Extraction Evidence Sample" });
  await expect(editor).toBeVisible();
  // Scope the save status to the editor header (a transient publish toast also carries role="status").
  const saveStatus = page
    .locator("header")
    .filter({ has: page.getByRole("button", { exact: true, name: "Save" }) })
    .getByRole("status");
  await expect(saveStatus).toHaveText("Saved");

  // The editor mounts and focuses "start" asynchronously; settle that before targeting a specific block,
  // otherwise the async focus snaps the caret back to the heading and races the block clicks below.
  await editor.click();
  await expect(editor).toBeFocused();

  // Exactly one block is cued — the low-confidence paragraph — and it carries the low-confidence text.
  const cues = editor.locator(".is-extraction-review");
  await expect(cues).toHaveCount(1);
  await expect(cues.first()).toContainText(LOW_CONFIDENCE_TEXT);

  // Placing the caret in the flagged block exposes the keyboard "Review extraction" disclosure; expanding
  // it reveals the SAFE source facts — a page and the "Review suggested" band — under the extraction heading.
  await editor.getByText(LOW_CONFIDENCE_TEXT, { exact: true }).click();
  const disclosure = page.getByRole("button", { name: "Review extraction" });
  await expect(disclosure).toBeVisible();
  await disclosure.click();
  const panel = page.locator(".richContentEditorEvidence").getByRole("group");
  await expect(panel).toContainText("Extraction evidence");
  await expect(panel).toContainText("Page");
  await expect(panel).toContainText("Review suggested");

  // A high-confidence block carries no disclosure at all.
  await editor.getByText(HIGH_CONFIDENCE_TEXT, { exact: true }).click();
  await expect(page.getByRole("button", { name: "Review extraction" })).toHaveCount(0);

  // Correct the flagged block: place the caret at its start and prepend a marker, then save. Click near the
  // paragraph's left edge (caret at the block start) and wait for the disclosure to reappear first — that
  // proves the caret settled in the low-confidence block, so the keystrokes prepend there and nowhere else.
  const lowBlock = editor.getByText(LOW_CONFIDENCE_TEXT, { exact: true });
  await lowBlock.click({ position: { x: 1, y: 4 } });
  await expect(disclosure).toBeVisible();
  await page.keyboard.type("Corrected: ");
  await expect(editor).toContainText(`Corrected: ${LOW_CONFIDENCE_TEXT}`);
  await page.getByRole("button", { exact: true, name: "Save" }).click();
  await expect(saveStatus).toHaveText("Saved");

  // After the save the page refetches evidence: the corrected block's cue is gone, yet its disclosure
  // remains — now reframed as the immutable original-extraction account.
  await expect(editor.locator(".is-extraction-review")).toHaveCount(0);
  await editor.getByText(`Corrected: ${LOW_CONFIDENCE_TEXT}`, { exact: true }).click();
  const retained = page.getByRole("button", { name: "Review extraction" });
  await expect(retained).toBeVisible();
  await retained.click();
  await expect(page.locator(".richContentEditorEvidence").getByRole("group")).toContainText(
    "Corrected — original extraction evidence"
  );

  // Reload the editor from a clean navigation: the corrected block still shows no cue, proving the cleared
  // cue is persisted (the block was durably marked corrected), not a transient in-memory state.
  await page.goto("about:blank");
  await page.goto(`${setup.baseURL}#/library/works/${encodeURIComponent(workId)}/correct`);
  const reopened = page.getByRole("textbox", { name: "Edit Extraction Evidence Sample" });
  await expect(reopened).toBeVisible();
  await expect(reopened).toContainText(`Corrected: ${LOW_CONFIDENCE_TEXT}`);
  await expect(reopened.locator(".is-extraction-review")).toHaveCount(0);

  // The original evidence itself is immutable: the endpoint still reports the corrected block as
  // review-suggested with its original page and confidence — correction changed content, not the account.
  const evidenceResponse = await page.request.get(
    `${setup.baseURL}api/imported-works/${encodeURIComponent(workId)}/extraction-evidence`
  );
  expect(evidenceResponse.ok()).toBe(true);
  const evidence = (await evidenceResponse.json()) as {
    items: ReadonlyArray<{
      confidence: number | null;
      corrected: boolean;
      page: number;
      reviewSuggested: boolean;
    }>;
  };
  const correctedRow = evidence.items.find((row) => row.reviewSuggested && row.corrected);
  expect(correctedRow, "the corrected block retains a review-suggested evidence row").toBeDefined();
  expect(correctedRow!.page).toBe(1);
  expect(correctedRow!.confidence).toBeLessThan(0.75);
});
