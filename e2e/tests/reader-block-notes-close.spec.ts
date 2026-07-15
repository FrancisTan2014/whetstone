import { geometry } from "../probes";
import { expect, test } from "../fixtures";

// The block-notes panel's Close control is a primary dismiss action, so it must expose at least a 44px
// touch target (WCAG 2.5.5). Before #413 it rendered as an unstyled text button — 38.3x24px on a 390px
// mobile viewport — and the shared geometry probe flagged it `tooSmall`. This asserts the real rendered
// rect in a browser, where the CSS actually applies (jsdom cannot lay out or evaluate box geometry).
//
// The work and mark are seeded through the API on a dedicated work, so the panel opens deterministically
// regardless of spec order — the shared seeded work accumulates notes from other specs, and reusing it
// here would let an overlapping annotation disable the UI note flow (annotations are disjoint, #163).
// A single bodyless mark routes the edge opener (#555) to the chooser aside (only a lone rich note opens
// the editor directly), which is the panel whose Close button this test measures.

const anyBlock = 'article[aria-label="Reading"] [data-block-id]';
const OPENER = 'article[aria-label="Reading"] .readerBlockOpener';
const CLOSE = 'aside[aria-label="Block notes"] button.readerBlockNotesClose';
const MOBILE = { height: 844, width: 390 } as const;

const rect = (el: Element) => {
  const box = el.getBoundingClientRect();
  return { height: box.height, width: box.width };
};

test("mobile: the block-notes panel Close button is a >=44px hit target (#413)", async ({
  page,
  setup
}) => {
  await page.setViewportSize({ height: MOBILE.height, width: MOBILE.width });

  // Seed a dedicated work so nothing another spec did can interfere with opening the panel.
  const created = await page.request.post(`${setup.baseURL}api/works`, {
    data: {
      author: { mode: "new", name: "Touch Target Author" },
      language: "en",
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

  // Read a real block id and a >=4-letter word from the rendered prose; a whole-block anchor whose
  // snapshots are a real substring of the block plaintext always validates and renders a highlight.
  const anchor = (await page.evaluate((blockSelector) => {
    for (const block of Array.from(document.querySelectorAll(blockSelector))) {
      const blockEntryId = block.getAttribute("data-block-id");
      const word = (block.textContent ?? "").match(/[A-Za-z]{4,}/)?.[0];
      if (blockEntryId !== null && word !== undefined) {
        return { blockEntryId, word };
      }
    }
    return null;
  }, anyBlock)) as { blockEntryId: string; word: string } | null;
  expect(anchor).not.toBeNull();

  const noteResponse = await page.request.post(
    `${setup.baseURL}api/works/${encodeURIComponent(work.entryId)}/marks`,
    {
      data: {
        anchor: {
          blockEntryId: anchor!.blockEntryId,
          contextSnapshot: anchor!.word,
          selectedTextSnapshot: anchor!.word
        }
      }
    }
  );
  expect(noteResponse.status()).toBe(201);

  // Reload so the reader fetches the seeded mark into the document (a same-hash goto would not remount
  // the hash-routed reader), then open the block-notes chooser via the annotated block's edge opener.
  await page.goto("about:blank");
  await page.goto(readerUrl);
  await expect(page.locator(anyBlock).first()).toBeVisible();
  const opener = page.locator(OPENER).first();
  await expect(opener).toBeVisible();
  await opener.click();

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
