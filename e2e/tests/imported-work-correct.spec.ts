import { type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { strToU8, zipSync } from "fflate";

import { type SetupData } from "../stack";
import { expect, test } from "../fixtures";

// The imported-Work correction journey (#762): open a canonical imported Work (a per-test EPUB) in the
// SHARED Library editor from its "Correct content" action, correct a stored block and change a block's type
// (a heading that repartitions a new ReadingUnit), save behind the Work-revision fence, and prove the
// corrected blocks are readable everywhere — reopened in the editor and rendered in the Reader. The same
// run proves the administrative affordance ("Open in Reader") is present on the correction surface yet
// ABSENT from the owner-scoped manual editor, so the shared editor never leaks administrative reach into
// the manual path. jsdom cannot lay out the persistent toolbar, drive the Radix overflow menu, or run the
// ProseMirror save/repartition transactions a real save/reload exercises, so this proves the whole loop in
// the actual browser, in BOTH the Day and Night themes and at BOTH a desktop and a 320px viewport.
//
// Each cell seeds its OWN canonical imported Work by uploading a uniquely titled minimal EPUB, so the four
// cells never contend on shared state and never contaminate other specs that read the shared setup fixture.

const READING = 'article[aria-label="Reading"]';
const DESKTOP = { height: 900, width: 1280 } as const;
const NARROW = { height: 720, width: 320 } as const;

type Section = Readonly<{ headingLevel?: number; title?: string; unitEntryId: string }>;

const EPUB_CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

const EPUB_NAV = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>
<nav epub:type="toc"><ol><li><a href="chap1.xhtml">One</a></li></ol></nav>
</body></html>`;

// Build a minimal, valid EPUB with a unique title, author, and identifier so the review front door mints a
// fresh, canonical imported Work (doc_blocks) immediately — a unique author and title share no duplicate
// candidate with any other cell. The server unzips EPUBs with fflate, so an fflate `zipSync` archive
// round-trips through ingestion faithfully.
function buildCorrectableEpubBytes(title: string, author: string, uid: string): Uint8Array {
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:${uid}</dc:identifier>
    <dc:title>${title}</dc:title>
    <dc:creator>${author}</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="chap1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
  </spine>
</package>`;
  const chapter = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>One</title></head><body><h1>Chapter One</h1><p>Original body text.</p></body></html>`;
  return zipSync({
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": strToU8(EPUB_CONTAINER),
    "OEBPS/content.opf": strToU8(opf),
    "OEBPS/nav.xhtml": strToU8(EPUB_NAV),
    "OEBPS/chap1.xhtml": strToU8(chapter)
  });
}

// Seed a per-test canonical imported Work by uploading a uniquely titled EPUB through the real front door
// (`POST /api/works/epub`). A fresh random token makes the title AND author unique, so the review flow finds
// no duplicate candidate and creates the Work immediately — isolated from every other test (even sibling
// matrix cells running in parallel) and from the shared setup fixture. Returns the minted id and its title.
async function seedImportedWork(
  page: Page,
  setup: SetupData,
  label: string
): Promise<{ readonly title: string; readonly workId: string }> {
  const token = randomUUID();
  const title = `${label} ${token}`;
  const bytes = buildCorrectableEpubBytes(title, `Author ${token}`, token);
  const created = await page.request.post(`${setup.baseURL}api/works/epub`, {
    data: Buffer.from(bytes),
    headers: { "content-type": "application/epub+zip" }
  });
  expect(created.ok(), `seed imported work "${title}"`).toBe(true);
  const body = (await created.json()) as { work?: { entryId: string } };
  expect(body.work?.entryId, `seed imported work "${title}" entryId`).toBeDefined();
  return { title, workId: body.work!.entryId };
}

// Create an owner-scoped manual Work through the real review front door (#749). A unique title has no
// duplicate candidate, so begin mints the owned, canonical empty-document Work immediately.
async function createManualWork(page: Page, setup: SetupData, title: string): Promise<string> {
  const created = await page.request.post(`${setup.baseURL}api/works/manual`, {
    data: {
      author: { mode: "new", name: `${title} Author` },
      language: "en",
      title,
      workType: "book"
    }
  });
  expect(created.status()).toBe(201);
  const { result } = (await created.json()) as { result: { work: { entryId: string } } };
  return result.work.entryId;
}

// Persist the theme the app reads on load (`whetstone-theme`) so every navigation renders in the target
// theme deterministically — the theme is a backdrop the editor must work against, not the thing under test.
async function persistTheme(page: Page, theme: "day" | "night"): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        /* not the app origin (e.g. about:blank) — nothing to seed */
      }
    },
    ["whetstone-theme", theme] as const
  );
}

for (const theme of ["day", "night"] as const) {
  for (const [size, viewport] of [
    ["desktop", DESKTOP],
    ["narrow", NARROW]
  ] as const) {
    test(`${theme} · ${size}: correct a canonical imported Work in the shared editor and read the result`, async ({
      page,
      setup
    }) => {
      await page.setViewportSize({ height: viewport.height, width: viewport.width });
      await persistTheme(page, theme);

      const { title: importedTitle, workId } = await seedImportedWork(
        page,
        setup,
        `Imported ${theme} ${size}`
      );
      const marker = `Corrected ${theme} ${size}`;
      const promotedTitle = "Original body text.";

      // Open the Library, then route to the correction editor through the imported Work's "Correct content"
      // action — proving a canonical imported Work exposes correction and routes to the shared surface.
      await page.goto(`${setup.baseURL}#/library`);
      await expect
        .poll(() => page.evaluate(() => document.documentElement.classList.contains("dark")))
        .toBe(theme === "night");
      await page.getByRole("button", { name: `More actions for ${importedTitle}` }).click();
      await page.getByRole("menuitem", { name: "Correct content" }).click();

      const editor = page.getByRole("textbox", { name: `Edit ${importedTitle}` });
      await expect(editor).toBeVisible();
      await expect(page.getByRole("status")).toHaveText("Saved");

      // The administrative correction surface offers "Open in Reader"; the manual editor (asserted below)
      // does not.
      await expect(page.getByRole("link", { name: "Open in Reader" })).toBeVisible();

      // Correct an existing stored block: prepend a marker to the very first (heading) block. Assert it
      // landed before moving on, so the block-type change below acts on a settled document (the editor mounts
      // and focuses asynchronously, which otherwise races the first keystrokes under parallel load).
      await editor.click();
      await expect(editor).toBeFocused();
      await page.keyboard.press("ControlOrMeta+Home");
      await page.keyboard.type(`${marker} `);
      await expect(editor.getByRole("heading").first()).toContainText(marker);

      // Change a block's type: promote the body paragraph to a Heading 2 by clicking its line to place the
      // caret (the proven, viewport-independent way to target a specific block in this editor) and toggling
      // the persistent toolbar. This transactionally repartitions a new ReadingUnit at the promoted heading.
      const toolbar = page.getByRole("toolbar", { exact: true, name: "Formatting" });
      await expect(toolbar).toBeVisible();
      await editor.getByText(promotedTitle, { exact: true }).click();
      await toolbar.getByRole("button", { name: "Heading 2" }).click();
      await expect(editor.getByRole("heading", { name: promotedTitle })).toBeVisible();

      // Save explicitly and wait for the confirmed state.
      await page.getByRole("button", { exact: true, name: "Save" }).click();
      await expect(page.getByRole("status")).toHaveText("Saved");

      // The correction persisted to the canonical blocks: the promotion created a Heading-2 section, and the
      // first ReadingUnit still carries the corrected marker text on its heading.
      const worksResponse = await page.request.get(
        `${setup.baseURL}api/imported-works/${encodeURIComponent(workId)}`
      );
      expect(worksResponse.ok()).toBe(true);
      const savedWork = (await worksResponse.json()) as { sections: ReadonlyArray<Section> };
      const newSection = savedWork.sections.find((section) => section.title === promotedTitle);
      expect(newSection, `section titled "${promotedTitle}"`).toBeDefined();
      expect(newSection!.headingLevel).toBe(2);

      const firstUnit = savedWork.sections[0]!.unitEntryId;
      const firstUnitContent = await page.request.get(
        `${setup.baseURL}api/works/${encodeURIComponent(workId)}/units/${encodeURIComponent(firstUnit)}/content`
      );
      expect(firstUnitContent.ok()).toBe(true);
      expect(JSON.stringify(await firstUnitContent.json())).toContain(marker);

      // Reopen the correction editor from a clean navigation: the active section reloads from the persisted
      // blocks with the corrected marker.
      await page.goto("about:blank");
      await page.goto(`${setup.baseURL}#/library/works/${encodeURIComponent(workId)}/correct`);
      const reopened = page.getByRole("textbox", { name: `Edit ${importedTitle}` });
      await expect(reopened).toBeVisible();
      await expect(reopened).toContainText(marker);

      // The Reader consumes the same stored blocks — the corrected first unit renders.
      await page.goto(`${setup.baseURL}#/reader?work=${encodeURIComponent(workId)}`);
      await expect(page.locator(`${READING} [data-block-id]`).first()).toBeVisible();
      await expect(page.locator(READING)).toContainText(marker);

      // The owner-scoped manual editor shares the same editor but must stay owner-scoped: it exposes no
      // administrative "Open in Reader" action, at this same theme and 320px/desktop viewport.
      const manualTitle = `Manual ${theme} ${size}`;
      const manualId = await createManualWork(page, setup, manualTitle);
      await page.goto(`${setup.baseURL}#/library/works/${encodeURIComponent(manualId)}/edit`);
      const manualEditor = page.getByRole("textbox", { name: `Edit ${manualTitle}` });
      await expect(manualEditor).toBeVisible();
      await expect(page.getByRole("link", { name: "Open in Reader" })).toHaveCount(0);
    });
  }
}
