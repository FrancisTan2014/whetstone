import { type Page } from "@playwright/test";

import { INTERACTIVE_SELECTOR, geometry } from "../probes";
import { type SetupData } from "../stack";
import { expect, test } from "../fixtures";

// The accessible edge-opener regression (#555). Saved notes/marks used to be an inline underline span
// that WAS the interactive control (role=button + tabindex + click handler) — a ~106x24px target that
// could never reach the 44px WCAG hit size without wrecking the reading rhythm. The fix makes the inline
// `span.noteMark` inert semantic decoration and gives every annotated block ONE always-visible edge
// opener (>=44x44, in the page margin/edge, out of text flow) that opens the block's annotation(s).
//
// jsdom cannot lay out or measure boxes, so this asserts the real rendered geometry AND the interaction
// routing in a browser at both desktop and 390px mobile, seeding works/annotations through the API on a
// dedicated work per test so spec order never interferes (the shared seeded work accumulates notes).

const READING = 'article[aria-label="Reading"]';
const OPENER = `${READING} .readerBlockOpener`;
const NOTE_MARK = `${READING} span.noteMark`;
const MOBILE = { height: 844, width: 390 } as const;
const DESKTOP = { height: 900, width: 1280 } as const;

// Seed a dedicated work with a single multi-word paragraph and return the reader URL plus the paragraph
// block's id and its rendered plaintext (so offsets are computed against exactly what the reader lays
// out, keeping seeded highlights well-anchored rather than needs-repair).
async function seedParagraphWork(
  page: Page,
  setup: SetupData,
  title: string
): Promise<{ blockEntryId: string; readerUrl: string; text: string; workEntryId: string }> {
  const created = await page.request.post(`${setup.baseURL}api/works`, {
    data: {
      author: { mode: "new", name: `${title} Author` },
      language: "en",
      title,
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
        markdown: `# ${title}\n\nAlpha bravo charlie delta echo foxtrot golf hotel india.\n`
      }
    }
  );
  expect(ingest.ok()).toBe(true);

  const readerUrl = `${setup.baseURL}#/reader?work=${encodeURIComponent(work.entryId)}`;
  await page.goto(readerUrl);
  await expect(page.locator(`${READING} [data-block-id]`).first()).toBeVisible();

  // The paragraph is the block whose plaintext holds the seeded prose (not the heading block).
  const paragraph = (await page.evaluate((reading) => {
    for (const block of Array.from(document.querySelectorAll(`${reading} [data-block-id]`))) {
      const text = block.textContent ?? "";
      const blockEntryId = block.getAttribute("data-block-id");
      if (blockEntryId !== null && text.includes("Alpha")) {
        return { blockEntryId, text };
      }
    }
    return null;
  }, READING)) as { blockEntryId: string; text: string } | null;
  expect(paragraph).not.toBeNull();

  return {
    blockEntryId: paragraph!.blockEntryId,
    readerUrl,
    text: paragraph!.text,
    workEntryId: work.entryId
  };
}

// Anchor a sub-block note/mark to `word` in the block's plaintext with real offsets, so the reader
// renders an inline `noteMark` underline for it (a whole-block anchor would only draw the gutter bar).
function anchorFor(
  blockEntryId: string,
  text: string,
  word: string
): {
  blockEntryId: string;
  contextSnapshot: string;
  endOffset: number;
  selectedTextSnapshot: string;
  startOffset: number;
} {
  const startOffset = text.indexOf(word);
  expect(startOffset).toBeGreaterThanOrEqual(0);
  return {
    blockEntryId,
    contextSnapshot: word,
    endOffset: startOffset + word.length,
    selectedTextSnapshot: word,
    startOffset
  };
}

async function addNote(
  page: Page,
  setup: SetupData,
  workEntryId: string,
  anchor: ReturnType<typeof anchorFor>,
  body: string
): Promise<void> {
  const response = await page.request.post(
    `${setup.baseURL}api/works/${encodeURIComponent(workEntryId)}/notes`,
    {
      data: {
        anchor,
        bodyDoc: {
          content: [{ content: [{ text: body, type: "text" }], type: "paragraph" }],
          type: "doc"
        }
      }
    }
  );
  expect(response.status()).toBe(201);
}

async function addMark(
  page: Page,
  setup: SetupData,
  workEntryId: string,
  anchor: ReturnType<typeof anchorFor>
): Promise<void> {
  const response = await page.request.post(
    `${setup.baseURL}api/works/${encodeURIComponent(workEntryId)}/marks`,
    { data: { anchor } }
  );
  expect(response.status()).toBe(201);
}

// Force the hash-routed reader to remount so it fetches the freshly seeded annotations.
async function reloadReader(page: Page, readerUrl: string): Promise<void> {
  await page.goto("about:blank");
  await page.goto(readerUrl);
  await expect(page.locator(`${READING} [data-block-id]`).first()).toBeVisible();
}

// Measure the opener rect and the block's prose text box (every block child except the opener itself),
// so the test can assert the opener is a >=44px target that never crosses into the prose content box.
async function measureOpenerAndProse(page: Page): Promise<{
  opener: { bottom: number; height: number; left: number; right: number; top: number; width: number };
  prose: { bottom: number; left: number; right: number; top: number };
}> {
  return page.evaluate((openerSelector) => {
    const opener = document.querySelector(openerSelector);
    if (opener === null) {
      throw new Error("no opener rendered");
    }
    const block = opener.closest("[data-block-id]");
    if (block === null) {
      throw new Error("opener not inside a block");
    }
    const o = opener.getBoundingClientRect();

    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const child of Array.from(block.children)) {
      if (child === opener || child.classList.contains("readerBlockOpener")) {
        continue;
      }
      const r = child.getBoundingClientRect();
      left = Math.min(left, r.left);
      top = Math.min(top, r.top);
      right = Math.max(right, r.right);
      bottom = Math.max(bottom, r.bottom);
    }

    return {
      opener: {
        bottom: o.bottom,
        height: o.height,
        left: o.left,
        right: o.right,
        top: o.top,
        width: o.width
      },
      prose: { bottom, left, right, top }
    };
  }, OPENER);
}

for (const [name, viewport] of [
  ["desktop", DESKTOP],
  ["mobile", MOBILE]
] as const) {
  test(`${name}: the inline noteMark is inert and the edge opener is an accessible >=44px target (#555)`, async ({
    page,
    setup
  }) => {
    await page.setViewportSize({ height: viewport.height, width: viewport.width });

    const work = await seedParagraphWork(page, setup, `Opener Inert ${name}`);
    await addNote(
      page,
      setup,
      work.workEntryId,
      anchorFor(work.blockEntryId, work.text, "Alpha"),
      "The opening word."
    );
    await reloadReader(page, work.readerUrl);

    // The inline underline is present but pure decoration: no role, not in the shared interactive
    // selector the hit-target sweep enumerates, and not tab-focusable.
    const mark = page.locator(NOTE_MARK).first();
    await expect(mark).toBeVisible();
    const inert = await page.evaluate(
      ([selector, interactive]) => {
        const span = document.querySelector(selector) as HTMLElement | null;
        if (span === null) {
          return null;
        }
        span.focus();
        return {
          focusable: document.activeElement === span,
          matchesInteractive: span.matches(interactive),
          role: span.getAttribute("role"),
          tabIndex: span.tabIndex
        };
      },
      [NOTE_MARK, INTERACTIVE_SELECTOR] as const
    );
    expect(inert).not.toBeNull();
    expect(inert!.role).toBeNull();
    expect(inert!.matchesInteractive).toBe(false);
    expect(inert!.tabIndex).toBe(-1);
    expect(inert!.focusable).toBe(false);

    // The opener carries an accurate accessible name from the pure label helper.
    const opener = page.locator(OPENER);
    await expect(opener).toBeVisible();
    await expect(opener).toHaveAccessibleName("Open note on 'Alpha'");

    // The opener is a >=44x44 target that the geometry probe does not flag, and its box never crosses
    // into the block's prose text content box (LTR: opener right edge <= prose left edge).
    const measured = await measureOpenerAndProse(page);
    expect(measured.opener.width).toBeGreaterThanOrEqual(44);
    expect(measured.opener.height).toBeGreaterThanOrEqual(44);
    expect(measured.opener.right).toBeLessThanOrEqual(measured.prose.left);
    const overlaps =
      measured.opener.right > measured.prose.left &&
      measured.opener.left < measured.prose.right &&
      measured.opener.top < measured.prose.bottom &&
      measured.opener.bottom > measured.prose.top;
    expect(overlaps).toBe(false);

    const flags = (await page.evaluate(geometry, OPENER)).issues.flatMap((issue) => issue.flags);
    expect(flags).not.toContain("tooSmall");
    expect(flags).not.toContain("offScreen");
    expect(flags).not.toContain("clipped");
  });

  test(`${name}: a lone rich note opens its editor directly from the opener (#555)`, async ({
    page,
    setup
  }) => {
    await page.setViewportSize({ height: viewport.height, width: viewport.width });

    const work = await seedParagraphWork(page, setup, `Opener Direct ${name}`);
    await addNote(
      page,
      setup,
      work.workEntryId,
      anchorFor(work.blockEntryId, work.text, "Alpha"),
      "Directly editable note body."
    );
    await reloadReader(page, work.readerUrl);

    // Keyboard reaches the opener in source order (before the prose) and Enter activates it; a single
    // rich note opens the editor directly — never the chooser.
    const opener = page.locator(OPENER);
    await opener.focus();
    await page.keyboard.press("Enter");

    const editor = page.getByRole("dialog", { name: "Edit note" });
    await expect(editor).toBeVisible();
    await expect(editor.getByText("Directly editable note body.")).toBeVisible();
    await expect(
      page.getByRole("complementary", { name: "Block notes" })
    ).toHaveCount(0);
  });

  test(`${name}: multiple annotations open the chooser and each row targets its own annotation (#555)`, async ({
    page,
    setup
  }) => {
    await page.setViewportSize({ height: viewport.height, width: viewport.width });

    const work = await seedParagraphWork(page, setup, `Opener Chooser ${name}`);
    await addNote(
      page,
      setup,
      work.workEntryId,
      anchorFor(work.blockEntryId, work.text, "Alpha"),
      "First annotation body."
    );
    await addMark(page, setup, work.workEntryId, anchorFor(work.blockEntryId, work.text, "charlie"));
    await reloadReader(page, work.readerUrl);

    // With more than one annotation the opener names the count and routes to the chooser (pointer here;
    // the direct-open test exercises the keyboard path).
    const opener = page.locator(OPENER);
    await expect(opener).toHaveAccessibleName("Open 2 annotations in this passage");
    await opener.click();

    const chooser = page.getByRole("complementary", { name: "Block notes" });
    await expect(chooser).toBeVisible();
    await expect(chooser.getByText("“Alpha”")).toBeVisible();
    await expect(chooser.getByText("“charlie”")).toBeVisible();
    // The mark row carries the Mark label; the note row shows its body preview.
    await expect(chooser.getByText("Mark", { exact: true })).toBeVisible();
    await expect(chooser.getByText("First annotation body.")).toBeVisible();

    // Editing the note row targets exactly that annotation (by entryId) — the editor shows its body,
    // never the mark's.
    await chooser.getByRole("button", { name: "Edit note: Alpha" }).click();
    const editor = page.getByRole("dialog", { name: "Edit note" });
    await expect(editor).toBeVisible();
    await expect(editor.getByText("First annotation body.")).toBeVisible();
  });
}
