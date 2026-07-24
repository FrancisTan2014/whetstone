import type { APIRequestContext, Page } from "@playwright/test";

import { expect, test } from "../fixtures";

// Open the Reader's 目录 drawer idempotently: a fresh reader load may restore an already-open drawer
// (whose backdrop button also matches "Table of contents"), so click the toggle by its exact name only
// when the drawer is closed. Returns the drawer navigation region.
async function openReaderToc(page: Page) {
  const drawer = page.getByRole("navigation", { name: "Table of Contents" });
  if (!(await drawer.isVisible())) {
    await page.getByRole("button", { name: "Table of contents", exact: true }).click();
  }
  await expect(drawer).toBeVisible();
  return drawer;
}

// A manually-added Markdown Work exposes a hierarchical Table of Contents DERIVED from its heading
// structure (#680) — no second, separately-editable TOC is stored. This spec proves the whole slice
// end-to-end in the real browser: the same heading outline appears in the Library "Manage content"
// sheet and in the Reader's 目录 drawer, and because it is derived (never persisted) re-ingesting a
// reordered source recomputes it with no stale entry surviving. Unit tests cover the projection rules;
// this guards the wiring jsdom cannot — the Radix overflow menu, the Sheet, and the reader drawer.

const READING = 'article[aria-label="Reading"]';

// A preface (no heading) + two chapters, one with a nested section. The derived outline is:
//   Start · Chapter One · (Section 1.1) · Chapter Two.
const initialMarkdown = [
  "A short preface before any heading.",
  "",
  "# Chapter One",
  "",
  "Chapter one body text.",
  "",
  "## Section 1.1",
  "",
  "Section one point one body.",
  "",
  "# Chapter Two",
  "",
  "Chapter two body text.",
  ""
].join("\n");

// A reordered source: Section 1.1 and Chapter Two are gone, Chapter Three is new. If the TOC were
// persisted rather than derived, the dropped headings would linger; deriving it recomputes cleanly.
const reorderedMarkdown = [
  "A short preface before any heading.",
  "",
  "# Chapter One",
  "",
  "Chapter one body text.",
  "",
  "# Chapter Three",
  "",
  "Chapter three body text.",
  ""
].join("\n");

async function createHeadingWork(
  request: APIRequestContext,
  baseURL: string,
  title: string,
  markdown: string
): Promise<{ entryId: string; title: string }> {
  const created = await request.post(`${baseURL}api/works`, {
    data: {
      author: { mode: "new", name: `${title} Author` },
      language: "en",
      origin: "imported",
      title,
      workType: "essay"
    }
  });
  expect(created.status(), `create → ${await created.text()}`).toBe(201);
  const { work } = (await created.json()) as { work: { entryId: string; title: string } };

  await ingest(request, baseURL, work.entryId, markdown);
  return work;
}

async function ingest(
  request: APIRequestContext,
  baseURL: string,
  entryId: string,
  markdown: string
): Promise<void> {
  const response = await request.post(
    `${baseURL}api/works/${encodeURIComponent(entryId)}/content`,
    { data: { kind: "manual", markdown } }
  );
  expect(response.ok(), `ingest → ${response.status()}: ${await response.text()}`).toBe(true);
}

test.describe("heading-derived Work table of contents (#680)", () => {
  test("shows the same derived outline in Manage content and the Reader, and recomputes on re-ingest", async ({
    page,
    setup
  }) => {
    const { baseURL } = setup;
    const work = await createHeadingWork(
      page.request,
      baseURL,
      "Heading Outline Book",
      initialMarkdown
    );

    // Manage content: the derived outline renders as a labelled list, nesting Section 1.1 under
    // Chapter One in reading order.
    await page.goto(`${baseURL}#/library`);
    const card = page.getByRole("listitem").filter({ hasText: work.title });
    await card.getByRole("button", { name: `More actions for ${work.title}` }).click();
    await page
      .getByRole("menu", { name: `More actions for ${work.title}` })
      .getByRole("menuitem", { name: "Manage content" })
      .click();

    const managedToc = page.getByRole("list", { name: "Table of contents" });
    await expect(managedToc.getByRole("listitem")).toHaveText([
      "Start",
      "Chapter One",
      "Section 1.1",
      "Chapter Two"
    ]);

    // Reader: the identical outline drives the 目录 drawer. Chapter One's nested section is revealed by
    // expanding it, proving the derived hierarchy (not a flat unit list).
    await page.goto(`${baseURL}#/reader?work=${encodeURIComponent(work.entryId)}`);
    await expect(page.locator(`${READING} [data-block-id]`).first()).toBeVisible();
    const drawer = await openReaderToc(page);
    await expect(drawer.getByRole("button", { name: "Start", exact: true })).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Chapter One", exact: true })).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Chapter Two", exact: true })).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Section 1.1", exact: true })).toBeHidden();
    await drawer.getByRole("button", { name: "Expand Chapter One" }).click();
    await expect(drawer.getByRole("button", { name: "Section 1.1", exact: true })).toBeVisible();

    // Re-ingest a reordered source: the TOC is derived, so the dropped headings vanish and the new one
    // appears — nothing stale is carried over. Route via the Library so the reader unmounts and refetches
    // (navigating straight to the identical reader URL is a same-document no-op that would keep stale data).
    await ingest(page.request, baseURL, work.entryId, reorderedMarkdown);
    await page.goto(`${baseURL}#/library`);
    await page.goto(`${baseURL}#/reader?work=${encodeURIComponent(work.entryId)}`);
    await expect(page.locator(`${READING} [data-block-id]`).first()).toBeVisible();
    const recomputed = await openReaderToc(page);
    await expect(
      recomputed.getByRole("button", { name: "Chapter Three", exact: true })
    ).toBeVisible();
    await expect(recomputed.getByRole("button", { name: "Chapter Two", exact: true })).toHaveCount(
      0
    );
    await expect(recomputed.getByRole("button", { name: "Section 1.1", exact: true })).toHaveCount(
      0
    );
  });
});
