import { geometry } from "../probes";
import { expect, test } from "../fixtures";

// The annotations chooser panel's Close control is a primary dismiss action, so it must expose at
// least a 44px touch target (WCAG 2.5.5). Before #413 it rendered as an unstyled text button —
// 38.3x24px on a 390px mobile viewport — and the shared geometry probe flagged it `tooSmall`. This
// asserts the real rendered rect in a browser, where the CSS actually applies (jsdom cannot lay out or
// evaluate box geometry).
//
// The work and mark are seeded through the API on a dedicated work, so the panel opens deterministically
// regardless of spec order — the shared seeded work accumulates notes from other specs, and reusing it
// here would let an overlapping annotation change the routing. A single bodyless mark's inline underline
// opens the compact chooser directly (#644) — the panel whose Close button this test measures.

const anyBlock = 'article[aria-label="Reading"] [data-block-id]';
const NOTE_MARK = 'article[aria-label="Reading"] span.noteMark';
const CLOSE = 'aside[aria-label="Annotations"] button.readerBlockNotesClose';
const MOBILE = { height: 844, width: 390 } as const;

const rect = (el: Element) => {
  const box = el.getBoundingClientRect();
  return { height: box.height, width: box.width };
};

test("mobile: the annotations chooser Close button is a >=44px hit target (#413)", async ({
  page,
  setup
}) => {
  await page.setViewportSize({ height: MOBILE.height, width: MOBILE.width });

  // Seed a dedicated work so nothing another spec did can interfere with opening the panel.
  const created = await page.request.post(`${setup.baseURL}api/works`, {
    data: {
      author: { mode: "new", name: "Touch Target Author" },
      language: "en",
      origin: "manual",
      title: "Touch Target Work",
      workType: "essay"
    }
  });
  expect(created.status()).toBe(201);
  const { work } = (await created.json()) as { work: { entryId: string } };
  const ingest = await page.request.post(
    `${setup.baseURL}api/works/${encodeURIComponent(work.entryId)}/content`,
    {
      data: {
        kind: "manual",
        markdown: "# Touch target\n\nA clean paragraph for the close test.\n"
      }
    }
  );
  expect(ingest.ok()).toBe(true);

  const readerUrl = `${setup.baseURL}#/reader?work=${encodeURIComponent(work.entryId)}`;
  await page.goto(readerUrl);
  await expect(page.locator(anyBlock).first()).toBeVisible();

  // Read a real block id and a >=4-letter word from the rendered prose, with its offsets, so the mark
  // anchors to that exact text and renders an inline underline (a whole-block anchor would draw none).
  const anchor = (await page.evaluate((blockSelector) => {
    for (const block of Array.from(document.querySelectorAll(blockSelector))) {
      const blockEntryId = block.getAttribute("data-block-id");
      const text = block.textContent ?? "";
      const match = text.match(/[A-Za-z]{4,}/);
      if (blockEntryId !== null && match !== null && match.index !== undefined) {
        return { blockEntryId, startOffset: match.index, word: match[0] };
      }
    }
    return null;
  }, anyBlock)) as { blockEntryId: string; startOffset: number; word: string } | null;
  expect(anchor).not.toBeNull();

  const noteResponse = await page.request.post(
    `${setup.baseURL}api/works/${encodeURIComponent(work.entryId)}/marks`,
    {
      data: {
        anchor: {
          blockEntryId: anchor!.blockEntryId,
          contextSnapshot: anchor!.word,
          endOffset: anchor!.startOffset + anchor!.word.length,
          selectedTextSnapshot: anchor!.word,
          startOffset: anchor!.startOffset
        }
      }
    }
  );
  expect(noteResponse.status()).toBe(201);

  // Reload so the reader fetches the seeded mark into the document (a same-hash goto would not remount
  // the hash-routed reader), then open the chooser directly from the mark's inline underline.
  await page.goto("about:blank");
  await page.goto(readerUrl);
  await expect(page.locator(anyBlock).first()).toBeVisible();
  const underline = page.locator(NOTE_MARK).first();
  await expect(underline).toBeVisible();
  await underline.click();

  const closeButton = page.locator(CLOSE);
  await expect(closeButton).toBeVisible();
  const box = await closeButton.evaluate(rect);
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.width).toBeGreaterThanOrEqual(44);

  // The shared geometry probe must not flag the control as too small.
  const result = await page.evaluate(geometry, CLOSE);
  const flags = result.issues.flatMap((issue) => issue.flags);
  expect(flags).not.toContain("tooSmall");
});
