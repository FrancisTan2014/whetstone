import { expect, test } from "../fixtures";

// A long note list must stay fully usable: the "Your notes" side sheet has to scroll within the
// viewport so every card's Jump/Edit/Delete actions remain reachable (#402). Before the fix the
// fixed sheet had no overflow handling, so lower cards spilled below the viewport and their Delete
// buttons could not be scrolled into view or clicked. This drives the real rendered layout in a
// browser (jsdom cannot lay out or scroll).
//
// Notes are seeded through the notes API rather than the reader UI: the suite shares one booted
// server and one fixed user, and other specs already annotate this work's first blocks, so
// UI-selecting the same words would collide with existing notes ("Notes can't overlap"). Seeding
// distinct whole-block anchors from real block ids/text is collision-free and deterministic.

const anyBlock = 'article[aria-label="Reading"] [data-block-id]';
const SEED_COUNT = 4;

type SeedAnchor = Readonly<{ blockEntryId: string; word: string }>;

test("the notes side sheet scrolls so the lowest note's actions stay reachable (#402)", async ({
  page,
  setup
}) => {
  const notesEndpoint = `${setup.baseURL}api/works/${encodeURIComponent(
    setup.markdown.entryId
  )}/notes`;

  await page.setViewportSize({ height: 900, width: 1280 });
  await page.goto(`${setup.baseURL}#/reader?work=${encodeURIComponent(setup.markdown.entryId)}`);
  await expect(page.locator(anyBlock).first()).toBeVisible();

  // Read real block ids and distinct >=4-letter words from the rendered prose. A whole-block anchor
  // whose context/selected snapshot is a real substring of the block plaintext always validates.
  const anchors = (await page.evaluate(
    ({ blockSelector, count }) => {
      const blocks = Array.from(document.querySelectorAll(blockSelector));
      const picks: Array<{ blockEntryId: string; word: string }> = [];
      const used = new Set<string>();
      for (const block of blocks) {
        const blockEntryId = block.getAttribute("data-block-id");
        if (blockEntryId === null) {
          continue;
        }
        const words = (block.textContent ?? "").match(/[A-Za-z]{4,}/g) ?? [];
        for (const word of words) {
          if (used.has(word)) {
            continue;
          }
          used.add(word);
          picks.push({ blockEntryId, word });
          if (picks.length >= count) {
            return picks;
          }
        }
      }
      return picks;
    },
    { blockSelector: anyBlock, count: SEED_COUNT }
  )) as SeedAnchor[];

  expect(anchors.length).toBe(SEED_COUNT);

  const seededNoteIds: string[] = [];
  for (const anchor of anchors) {
    const response = await page.request.post(notesEndpoint, {
      data: {
        anchor: {
          blockEntryId: anchor.blockEntryId,
          contextSnapshot: anchor.word,
          selectedTextSnapshot: anchor.word
        },
        bodyDoc: {
          content: [
            {
              content: [{ text: `Seed note for ${anchor.word}.`, type: "text" }],
              type: "paragraph"
            }
          ],
          type: "doc"
        }
      }
    });
    expect(response.status()).toBe(201);
    const created = (await response.json()) as { entryId: string };
    seededNoteIds.push(created.entryId);
  }

  try {
    // Reload so the reader fetches the seeded notes into the list (a same-hash goto would not
    // remount the hash-routed reader, so start from a blank page first).
    await page.goto("about:blank");
    await page.goto(`${setup.baseURL}#/reader?work=${encodeURIComponent(setup.markdown.entryId)}`);
    await expect(page.locator(anyBlock).first()).toBeVisible();

    // A short desktop viewport forces the right-docked, full-height sheet's content to overflow.
    await page.setViewportSize({ height: 300, width: 1280 });
    await page.getByRole("button", { name: "Your notes" }).click();

    const sheet = page.getByRole("dialog", { name: "Your notes" });
    await expect(sheet).toBeVisible();

    const deleteButtons = sheet.getByRole("button", { name: /^Delete note:/ });
    const initialCount = await deleteButtons.count();
    expect(initialCount).toBeGreaterThanOrEqual(SEED_COUNT);

    // The lowest card sits below the fold. Clicking its Delete button requires the sheet body to
    // scroll it into view — exactly what failed before the fix, when the button stayed off-screen
    // in a non-scrolling fixed panel. A successful click (and the resulting count drop) proves the
    // sheet now scrolls.
    await deleteButtons.last().click();
    await expect(deleteButtons).toHaveCount(initialCount - 1);
  } finally {
    // Clean up seeded notes so shared server state does not leak into other specs. These run
    // through the API request context, whose responses do not trip the page's runtime-defect guard,
    // so a 404 for an already-deleted note is harmless.
    for (const noteEntryId of seededNoteIds) {
      await page.request.delete(`${notesEndpoint}/${encodeURIComponent(noteEntryId)}`);
    }
  }
});
