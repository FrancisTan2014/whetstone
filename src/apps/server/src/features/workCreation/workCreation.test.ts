import { PGlite } from "@electric-sql/pglite";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { IngestEpubResultDto } from "@whetstone/contracts";
import { epubContentType, parseWorkCreationReviewDto } from "@whetstone/contracts";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import {
  authors,
  blocks,
  entries,
  personalEntries,
  tocEntries,
  uploadedSourceClaims,
  workCreationAttempts,
  workMeta,
  workSources
} from "../../db/schema.js";
import { createImageResourceStore } from "../../files/imageResourceStore.js";
import { createSourceFileStore, hashBytes, hashMarkdown } from "../../files/sourceFileStore.js";
import type { ParsedEpub, ParsedEpubImage } from "../../files/epubSource.js";
import { createServer } from "../../http/createServer.js";
import { DEFAULT_USER_ID } from "../../identity/currentUser.js";
import type { ContentDependencies } from "../content/contentCommands.js";
import { commitImportedMarkdownWork } from "../content/contentCommands.js";
import { ingestEpub as ingestEpubCommand } from "../content/epubCommands.js";
import {
  cancelWorkCreation,
  getWorkCreationReview,
  type WorkCreationDependencies
} from "./workCreationCommands.js";
import { beginFinalizeAttempt, detachStagePath } from "./workCreationAttemptStore.js";

const TTL_MS = 30 * 60 * 1000;
const TITLE = "Politics and the English Language";
const MARKDOWN = "# Politics and the English Language\n\nFirst durable paragraph of the essay.";

const VALID = {
  author: { mode: "new", name: "George Orwell" },
  fileName: "politics.md",
  language: "en",
  markdown: MARKDOWN,
  title: TITLE,
  workType: "essay"
} as const;

type Harness = Readonly<{
  content: ContentDependencies;
  db: DbClient;
  deps: WorkCreationDependencies;
  pglite: PGlite;
  server: ReturnType<typeof createServer>;
  sourcesDir: string;
  clock: { now: Date };
  advance: (ms: number) => void;
  // The injected EPUB parser's next response, reassigned per test so a begin/keep-separate drives a
  // specific book (or a parser failure) without a real archive.
  epub: { respond: (bytes: Uint8Array) => Promise<ParsedEpub> };
}>;

let h: Harness;

async function buildHarness(): Promise<Harness> {
  const pglite = new PGlite();
  await runMigrations(pglite);
  const db = createDbClient(pglite);
  const sourcesDir = await mkdtemp(join(tmpdir(), "whetstone-workcreation-"));
  const imagesDir = await mkdtemp(join(tmpdir(), "whetstone-workcreation-img-"));

  let authorSeq = 0;
  let entrySeq = 0;
  let sourceSeq = 0;
  let attemptSeq = 0;
  let stageSeq = 0;

  const epub: Harness["epub"] = { respond: (bytes) => bookEpub(bytes) };

  const content: ContentDependencies = {
    createAuthorId: () => `author-${(authorSeq += 1)}`,
    createEntryId: () => `work-${(entrySeq += 1)}`,
    createSourceId: () => `source-${(sourceSeq += 1)}`,
    db,
    epubParser: (bytes) => epub.respond(bytes),
    epubUploadLimitBytes: 1024,
    imageResourceStore: createImageResourceStore(imagesDir),
    ingestionLogger: () => undefined,
    pdfToMarkdown: { convert: () => Promise.reject(new Error("pdf not used")) },
    sourceFileStore: createSourceFileStore(sourcesDir)
  };

  const clock = { now: new Date("2026-05-01T00:00:00.000Z") };
  const deps: WorkCreationDependencies = {
    attemptTtlMs: TTL_MS,
    content,
    createAttemptId: () => `attempt-${(attemptSeq += 1)}`,
    createStageId: () => `stage-${(stageSeq += 1)}`,
    log: { info: () => undefined },
    now: () => clock.now
  };

  return {
    advance: (ms) => {
      clock.now = new Date(clock.now.getTime() + ms);
    },
    clock,
    content,
    db,
    deps,
    epub,
    pglite,
    server: createServer({ content, logger: false, workCreation: deps }),
    sourcesDir
  };
}

// The EPUB the fake parser returns by default: a two-chapter book by 司马迁 with no images or nav, so a
// plain begin has clean metadata to weigh. `bytes` is unused (the fake keys off nothing), matching the
// injected-parser seam.
function bookEpub(_bytes: Uint8Array): Promise<ParsedEpub> {
  return Promise.resolve({
    chapters: [
      { html: "<h1>Chapter One</h1><p>First.</p>", images: [], sourceFile: "ch01.xhtml" },
      { html: "<h1>本纪</h1><p>黄帝者。</p>", images: [], sourceFile: "ch02.xhtml" }
    ],
    metadata: { author: "司马迁", language: "zh-CN", title: "史记选读" }
  });
}

// A single-byte 1×1 PNG, so a figure block carries a real stored image on the keep-separate transfer path.
function pngBytes(): Uint8Array {
  return Uint8Array.from(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=",
      "base64"
    )
  );
}

// An EPUB whose first chapter carries a figure image and which declares an authored nav, so a
// keep-separate commit must persist units + a figure block's stored image + toc_entries in one
// transaction (the atomic transfer path, #748).
function figureNavEpub(image: ParsedEpubImage): ParsedEpub {
  const navSource =
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>' +
    '<nav epub:type="toc"><ol>' +
    '<li><a href="ch01.xhtml">Chapter One</a></li>' +
    '<li><a href="ch02.xhtml">Chapter Two</a></li>' +
    "</ol></nav></body></html>";

  return {
    chapters: [
      {
        html: `<h1>Chapter One</h1><figure><img src="${image.src}" alt="A dot"/><figcaption>Cap.</figcaption></figure>`,
        images: [image],
        sourceFile: "ch01.xhtml"
      },
      { html: "<h1>Chapter Two</h1><p>Second.</p>", images: [], sourceFile: "ch02.xhtml" }
    ],
    metadata: { author: "司马迁", language: "zh-CN", title: "史记选读" },
    nav: { kind: "xhtml-nav", path: "nav.xhtml", source: navSource }
  };
}

async function seedAuthor(id: string, name: string): Promise<string> {
  await h.db.execute(
    sql`INSERT INTO authors (id, name, name_key) VALUES (${id}, ${name}, author_name_key(${name}))`
  );
  return id;
}

async function seedCandidateWork(
  input: Readonly<{
    entryId: string;
    title?: string;
    authorId: string;
    origin?: "imported" | "manual" | "authored";
  }>
): Promise<string> {
  await h.db.insert(entries).values({ id: input.entryId, type: "work" });
  await h.db.insert(workMeta).values({
    authorId: input.authorId,
    entryId: input.entryId,
    language: "en",
    origin: input.origin ?? "imported",
    title: input.title ?? TITLE,
    workType: "essay"
  });
  return input.entryId;
}

function begin(overrides: Record<string, unknown> = {}): ReturnType<typeof h.server.inject> {
  return h.server.inject({
    method: "POST",
    payload: { ...VALID, ...overrides },
    url: "/api/works/markdown"
  });
}

const EPUB_TITLE = "史记选读";
const EPUB_AUTHOR = "司马迁";

// A manual-creation begin: metadata only, no uploaded bytes. The `origin` is implicit (`manual`) and never
// accepted from the client, so the payload is the same shape as the Markdown begin minus the file fields.
const MANUAL = {
  author: { mode: "new", name: "George Orwell" },
  language: "en",
  title: TITLE,
  workType: "essay"
} as const;

function beginManual(overrides: Record<string, unknown> = {}): ReturnType<typeof h.server.inject> {
  return h.server.inject({
    method: "POST",
    payload: { ...MANUAL, ...overrides },
    url: "/api/works/manual"
  });
}

// Park a manual attempt on a credible duplicate: a Work sharing the proposed title (different author) is a
// credible #724 candidate, so a plain manual begin returns needs_review with nothing created.
async function beginManualNeedsReview(): Promise<{ attemptId: string; candidateId: string }> {
  const candidateId = await seedCandidateWork({
    authorId: await seedAuthor("existing-author", "Someone Else"),
    entryId: "candidate-1"
  });
  const body = (await beginManual()).json();
  expect(body.status).toBe("needs_review");
  return { attemptId: body.review.attemptId as string, candidateId };
}

function beginEpub(
  bytes: Uint8Array = new Uint8Array([1, 2, 3])
): ReturnType<typeof h.server.inject> {
  return h.server.inject({
    headers: { "content-type": epubContentType },
    method: "POST",
    payload: Buffer.from(bytes),
    url: "/api/works/epub"
  });
}

// Seed a Work whose title matches the fake EPUB's embedded metadata, so a begin sees a credible duplicate.
async function seedEpubCandidate(entryId = "epub-candidate-1"): Promise<string> {
  return seedCandidateWork({
    authorId: await seedAuthor("sima-existing", EPUB_AUTHOR),
    entryId,
    title: EPUB_TITLE
  });
}

function getReview(attemptId: string): ReturnType<typeof h.server.inject> {
  return h.server.inject({ method: "GET", url: `/api/work-creation-attempts/${attemptId}` });
}

function openExisting(attemptId: string, payload: unknown): ReturnType<typeof h.server.inject> {
  return h.server.inject({
    method: "POST",
    payload,
    url: `/api/work-creation-attempts/${attemptId}/open-existing`
  });
}

function keepSeparate(attemptId: string, payload: unknown): ReturnType<typeof h.server.inject> {
  return h.server.inject({
    method: "POST",
    payload,
    url: `/api/work-creation-attempts/${attemptId}/keep-separate`
  });
}

function cancel(attemptId: string): ReturnType<typeof h.server.inject> {
  return h.server.inject({
    method: "POST",
    url: `/api/work-creation-attempts/${attemptId}/cancel`
  });
}

async function fileExists(relativePath: string): Promise<boolean> {
  try {
    await access(join(h.sourcesDir, relativePath));
    return true;
  } catch {
    return false;
  }
}

async function beginNeedsReview(): Promise<{ attemptId: string; candidateId: string }> {
  const candidateId = await seedCandidateWork({
    authorId: await seedAuthor("existing-author", "Someone Else"),
    entryId: "candidate-1"
  });
  const response = await begin();
  const body = response.json();
  expect(body.status).toBe("needs_review");
  return { attemptId: body.review.attemptId as string, candidateId };
}

async function countWorks(): Promise<number> {
  const rows = await h.db.select({ entryId: workMeta.entryId }).from(workMeta);
  return rows.length;
}

beforeEach(async () => {
  h = await buildHarness();
});

afterEach(async () => {
  await h.pglite.close();
  await rm(h.sourcesDir, { force: true, recursive: true });
});

describe("Markdown creation-review begin (#747)", () => {
  it("commits immediately when no credible duplicate exists", async () => {
    const response = await begin();

    expect(response.statusCode).toBe(201);
    const body = response.json() as { result: IngestEpubResultDto; status: string };
    expect(body.status).toBe("created");
    expect(body.result.work).toMatchObject({ origin: "imported", title: TITLE, workType: "essay" });

    expect(await countWorks()).toBe(1);
    expect(await h.db.select().from(workCreationAttempts)).toHaveLength(0);
    expect(await h.db.select().from(uploadedSourceClaims)).toHaveLength(1);
  });

  it("reopens the owning Work when identical bytes are re-uploaded", async () => {
    const first = (await begin()).json() as { result: IngestEpubResultDto };
    const response = await begin();

    expect(response.statusCode).toBe(200);
    const body = response.json() as { result: IngestEpubResultDto; status: string };
    expect(body.status).toBe("exact_existing");
    expect(body.result.work.entryId).toBe(first.result.work.entryId);
    expect(await countWorks()).toBe(1);
  });

  it("parks one review attempt and returns the reviewed candidates when a duplicate is credible", async () => {
    const candidateId = await seedCandidateWork({
      authorId: await seedAuthor("existing-author", "Someone Else"),
      entryId: "candidate-1"
    });

    const response = await begin();

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("needs_review");
    const review = parseWorkCreationReviewDto(body.review);
    expect(review.revision).toBe(0);
    expect(review.proposed).toEqual({
      authorName: "George Orwell",
      language: "en",
      title: TITLE,
      workType: "essay"
    });
    expect(review.candidates).toHaveLength(1);
    expect(review.candidates[0]).toMatchObject({
      entryId: candidateId,
      matchTier: "exact",
      origin: "imported"
    });

    // The attempt persists staged bytes; NO Work, source, or claim is created yet.
    const attempts = await h.db.select().from(workCreationAttempts);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.sourceFileName).toBe("politics.md");
    expect(await fileExists(attempts[0]!.stagePath!)).toBe(true);
    expect(await countWorks()).toBe(1);
    expect(await h.db.select().from(uploadedSourceClaims)).toHaveLength(0);
  });

  it("reuses a name-equivalent existing author when committing a brand-new selection", async () => {
    const existingId = await seedAuthor("orwell", "George Orwell");

    const response = await begin();

    expect(response.statusCode).toBe(201);
    const body = response.json() as { result: IngestEpubResultDto };
    expect(body.result.work.authorId).toBe(existingId);
    expect(await h.db.select().from(authors)).toHaveLength(1);
  });

  it("refuses empty Markdown with 422 and stages nothing", async () => {
    const response = await begin({ markdown: "![only image](x.png)" });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ status: "empty_content" });
    expect(await readdir(h.sourcesDir)).toEqual([]);
    expect(await countWorks()).toBe(0);
  });

  it("refuses an unknown existing author with 400 and stages nothing", async () => {
    const response = await begin({ author: { mode: "existing", authorId: "missing" } });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ status: "author_not_found" });
    expect(await readdir(h.sourcesDir)).toEqual([]);
  });

  it("commits with a selected existing author when no duplicate is credible", async () => {
    const existingId = await seedAuthor("kleppmann", "Martin Kleppmann");

    const response = await begin({ author: { mode: "existing", authorId: existingId } });

    expect(response.statusCode).toBe(201);
    expect((response.json() as { result: IngestEpubResultDto }).result.work.authorId).toBe(
      existingId
    );
  });

  it("reports uncertain (503) when the candidate query cannot be trusted", async () => {
    // Model an untrusted candidate query by removing the shared key function the #724 search depends on:
    // the boundary must report uncertain and create nothing, never a false "no duplicates".
    await h.db.execute(sql`DROP FUNCTION IF EXISTS work_title_key(text) CASCADE`);

    const response = await begin();

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "uncertain" });
    expect(await countWorks()).toBe(0);
    expect(await readdir(h.sourcesDir)).toEqual([]);
  });

  it("rejects a malformed begin body with 400 invalid_request", async () => {
    const response = await h.server.inject({
      method: "POST",
      payload: { title: TITLE },
      url: "/api/works/markdown"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_request" });
  });
});

describe("Markdown creation-review view (#747)", () => {
  it("returns the current review for a pending attempt", async () => {
    const { attemptId, candidateId } = await beginNeedsReview();

    const response = await getReview(attemptId);

    expect(response.statusCode).toBe(200);
    const review = parseWorkCreationReviewDto(response.json());
    expect(review.attemptId).toBe(attemptId);
    expect(review.candidates[0]?.entryId).toBe(candidateId);
  });

  it("persists newly appeared candidates under a bumped revision so Open existing accepts the displayed evidence (#747)", async () => {
    const { attemptId, candidateId } = await beginNeedsReview();
    // A second credible duplicate appears AFTER the attempt was parked; the revision-0 snapshot holds only
    // the first candidate.
    const secondId = await seedCandidateWork({
      authorId: await seedAuthor("second-author", "Another Person"),
      entryId: "candidate-2"
    });

    // GET must persist the refreshed evidence and bump the revision, not display a candidate the decision
    // would then reject as existing_gone.
    const view = await getReview(attemptId);
    expect(view.statusCode).toBe(200);
    const review = parseWorkCreationReviewDto(view.json());
    expect(review.revision).toBe(1);
    expect(review.candidates.map((candidate) => candidate.entryId).sort()).toEqual(
      [candidateId, secondId].sort()
    );

    // Open existing on the newly appeared candidate, at the revision GET returned, now succeeds instead of
    // being fenced out — the shown evidence agrees with the persisted snapshot and revision.
    const opened = await openExisting(attemptId, { entryId: secondId, revision: review.revision });
    expect(opened.statusCode).toBe(200);
    const body = opened.json() as { result: IngestEpubResultDto; status: string };
    expect(body.status).toBe("opened");
    expect(body.result.work.entryId).toBe(secondId);
  });

  it("commits Keep separate against the revision GET refreshed to after the evidence changed (#747)", async () => {
    const { attemptId } = await beginNeedsReview();
    await seedCandidateWork({
      authorId: await seedAuthor("second-author", "Another Person"),
      entryId: "candidate-2"
    });

    // GET persists the changed evidence and bumps the revision to 1.
    const review = parseWorkCreationReviewDto((await getReview(attemptId)).json());
    expect(review.revision).toBe(1);

    // Keep separate at the refreshed revision no longer sees changed evidence, so it commits once instead of
    // bouncing back to needs_review against evidence the learner just reviewed.
    const decided = await keepSeparate(attemptId, { revision: review.revision });
    expect(decided.statusCode).toBe(201);
    expect((decided.json() as { status: string }).status).toBe("created");
  });

  it("resumes the owner's review with the refreshed evidence and bumped revision when a begin races the slot (#747)", async () => {
    const { attemptId, candidateId } = await beginNeedsReview();
    // A second credible duplicate appears, then a second begin for the same owner races the single-attempt
    // slot and resumes the existing review.
    const secondId = await seedCandidateWork({
      authorId: await seedAuthor("second-author", "Another Person"),
      entryId: "candidate-2"
    });

    const resumed = parseWorkCreationReviewDto((await begin()).json().review);
    expect(resumed.attemptId).toBe(attemptId);
    expect(resumed.revision).toBe(1);
    expect(resumed.candidates.map((candidate) => candidate.entryId).sort()).toEqual(
      [candidateId, secondId].sort()
    );

    // The resumed review's candidate is a genuine choice at the returned revision.
    const opened = await openExisting(attemptId, { entryId: secondId, revision: resumed.revision });
    expect(opened.statusCode).toBe(200);
    expect((opened.json() as { status: string }).status).toBe("opened");
  });

  it("answers 404 for an unknown attempt", async () => {
    const response = await getReview("missing");

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ status: "not_found" });
  });

  it("answers 410 once the attempt has outlived its TTL", async () => {
    const { attemptId } = await beginNeedsReview();
    h.advance(TTL_MS + 1);

    const response = await getReview(attemptId);

    expect(response.statusCode).toBe(410);
    expect(response.json()).toEqual({ status: "expired" });
  });

  it("answers 404 for a terminal attempt", async () => {
    const { attemptId, candidateId } = await beginNeedsReview();
    await openExisting(attemptId, { entryId: candidateId, revision: 0 });

    const response = await getReview(attemptId);

    expect(response.statusCode).toBe(404);
  });

  it("reports uncertain when the candidate query cannot be trusted", async () => {
    const { attemptId } = await beginNeedsReview();
    await h.db.execute(sql`DROP FUNCTION IF EXISTS work_title_key(text) CASCADE`);

    const response = await getReview(attemptId);

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "uncertain" });
  });
});

describe("Markdown creation-review open existing (#747)", () => {
  it("reopens the chosen Work and consumes the attempt without creating anything", async () => {
    const { attemptId, candidateId } = await beginNeedsReview();

    const response = await openExisting(attemptId, { entryId: candidateId, revision: 0 });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { result: IngestEpubResultDto; status: string };
    expect(body.status).toBe("opened");
    expect(body.result.work.entryId).toBe(candidateId);
    expect(await countWorks()).toBe(1);

    const attempt = (
      await h.db.select().from(workCreationAttempts).where(eq(workCreationAttempts.id, attemptId))
    )[0];
    expect(attempt?.state).toBe("completed");
    expect(attempt?.stagePath).toBeNull();
  });

  it("answers 409 existing_gone when the chosen Work no longer exists", async () => {
    const { attemptId } = await beginNeedsReview();

    const response = await openExisting(attemptId, { entryId: "vanished", revision: 0 });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ status: "existing_gone" });
  });

  it("answers 409 existing_gone without consuming the attempt when a reviewed candidate is deleted before the decision (#747)", async () => {
    const { attemptId, candidateId } = await beginNeedsReview();
    // A real race: the reviewed candidate Work is deleted between review and decision. Its id is still in
    // the attempt's snapshot, so it clears the fence, but it no longer resolves to a reopenable Work.
    await h.db.delete(workMeta).where(eq(workMeta.entryId, candidateId));
    await h.db.delete(entries).where(eq(entries.id, candidateId));

    const response = await openExisting(attemptId, { entryId: candidateId, revision: 0 });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ status: "existing_gone" });
    // Nothing was reopened, and the staged upload plus the attempt stay live for a Keep separate or Back.
    expect(await countWorks()).toBe(0);
    const attempt = (
      await h.db.select().from(workCreationAttempts).where(eq(workCreationAttempts.id, attemptId))
    )[0];
    expect(attempt?.state).toBe("pending");
    expect(attempt?.revision).toBe(0);
    expect(attempt?.stagePath).not.toBeNull();
  });

  it("rejects an existing but unreviewed Work id without consuming the attempt (fence, #747)", async () => {
    const { attemptId, candidateId } = await beginNeedsReview();
    // A real, reopenable Work the review never surfaced as a candidate (unrelated title/author).
    const unreviewedId = await seedCandidateWork({
      authorId: await seedAuthor("unrelated-author", "Unrelated Author"),
      entryId: "unreviewed-work",
      title: "A Completely Unrelated Title"
    });

    const response = await openExisting(attemptId, { entryId: unreviewedId, revision: 0 });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ status: "existing_gone" });
    // Nothing was opened around review, and the attempt stays live at its revision for a valid choice.
    const attempt = (
      await h.db.select().from(workCreationAttempts).where(eq(workCreationAttempts.id, attemptId))
    )[0];
    expect(attempt?.state).toBe("pending");
    expect(attempt?.revision).toBe(0);

    // The genuinely reviewed candidate still opens on the same live attempt.
    const reopen = await openExisting(attemptId, { entryId: candidateId, revision: 0 });
    expect(reopen.statusCode).toBe(200);
    expect((reopen.json() as { status: string }).status).toBe("opened");
  });

  it("answers 409 superseded for a stale revision", async () => {
    const { attemptId, candidateId } = await beginNeedsReview();

    const response = await openExisting(attemptId, { entryId: candidateId, revision: 5 });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ status: "superseded" });
  });

  it("answers 410 expired after the TTL", async () => {
    const { attemptId, candidateId } = await beginNeedsReview();
    h.advance(TTL_MS + 1);

    const response = await openExisting(attemptId, { entryId: candidateId, revision: 0 });

    expect(response.statusCode).toBe(410);
  });

  it("answers 404 for an unknown attempt", async () => {
    const response = await openExisting("missing", { entryId: "x", revision: 0 });

    expect(response.statusCode).toBe(404);
  });

  it("rejects a malformed open-existing body with 400 invalid_request", async () => {
    const { attemptId } = await beginNeedsReview();

    const response = await openExisting(attemptId, { revision: 0 });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_request" });
  });
});

describe("Markdown creation-review keep separate (#747)", () => {
  it("commits a distinct Work, transferring the staged upload to provenance", async () => {
    const { attemptId } = await beginNeedsReview();
    const attemptRow = (
      await h.db.select().from(workCreationAttempts).where(eq(workCreationAttempts.id, attemptId))
    )[0];
    const stagePath = attemptRow!.stagePath!;

    const response = await keepSeparate(attemptId, { revision: 0 });

    expect(response.statusCode).toBe(201);
    const body = response.json() as { result: IngestEpubResultDto; status: string };
    expect(body.status).toBe("created");
    expect(body.result.work.title).toBe(TITLE);
    expect(await countWorks()).toBe(2);

    const sources = await h.db
      .select()
      .from(workSources)
      .where(eq(workSources.workEntryId, body.result.work.entryId));
    expect(sources[0]).toMatchObject({ fileName: "politics.md", sha256: hashMarkdown(MARKDOWN) });
    // The staged file was transferred in place (still present) and the attempt cleared its stage reference.
    expect(await fileExists(stagePath)).toBe(true);
    const completed = (
      await h.db.select().from(workCreationAttempts).where(eq(workCreationAttempts.id, attemptId))
    )[0];
    expect(completed?.state).toBe("completed");
    expect(completed?.stagePath).toBeNull();
  });

  it("commits a distinct Work reusing the selected existing author", async () => {
    // A needs_review attempt whose proposal referenced an EXISTING author: the recompute and the final commit
    // both carry the non-null proposed author id through, and Keep separate reuses that author.
    const existingId = await seedAuthor("kleppmann", "Martin Kleppmann");
    await seedCandidateWork({
      authorId: await seedAuthor("someone-else", "Someone Else"),
      entryId: "candidate-1"
    });
    const begun = (await begin({ author: { mode: "existing", authorId: existingId } })).json();
    expect(begun.status).toBe("needs_review");
    const attemptId = begun.review.attemptId as string;

    // A GET refresh exercises the recompute against a non-null proposed author id.
    const refreshed = parseWorkCreationReviewDto((await getReview(attemptId)).json());
    expect(refreshed.proposed.authorName).toBe("Martin Kleppmann");

    const response = await keepSeparate(attemptId, { revision: 0 });

    expect(response.statusCode).toBe(201);
    const body = response.json() as { result: IngestEpubResultDto; status: string };
    expect(body.status).toBe("created");
    expect(body.result.work.authorId).toBe(existingId);
    expect(await h.db.select().from(authors)).toHaveLength(2);
  });

  it("reopens the existing Work when identical bytes were claimed meanwhile (exact_existing)", async () => {
    const { attemptId } = await beginNeedsReview();
    const claimed = await commitImportedMarkdownWork(h.content, VALID);
    const claimedEntryId =
      claimed.status === "created" || claimed.status === "exact_existing"
        ? claimed.result.work.entryId
        : "";

    const response = await keepSeparate(attemptId, { revision: 0 });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { result: IngestEpubResultDto; status: string };
    expect(body.status).toBe("exact_existing");
    expect(body.result.work.entryId).toBe(claimedEntryId);
    const attempt = (
      await h.db.select().from(workCreationAttempts).where(eq(workCreationAttempts.id, attemptId))
    )[0];
    expect(attempt?.state).toBe("completed");
    expect(attempt?.stagePath).toBeNull();
  });

  it("refreshes the panel under a bumped revision when the candidate evidence changed", async () => {
    const { attemptId } = await beginNeedsReview();
    await seedCandidateWork({
      authorId: await seedAuthor("second-author", "Another Person"),
      entryId: "candidate-2"
    });

    const response = await keepSeparate(attemptId, { revision: 0 });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("needs_review");
    const review = parseWorkCreationReviewDto(body.review);
    expect(review.revision).toBe(1);
    expect(review.candidates).toHaveLength(2);
    expect(await countWorks()).toBe(2);
  });

  it("answers 409 superseded for a stale revision", async () => {
    const { attemptId } = await beginNeedsReview();

    const response = await keepSeparate(attemptId, { revision: 9 });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ status: "superseded" });
  });

  it("answers 410 expired after the TTL", async () => {
    const { attemptId } = await beginNeedsReview();
    h.advance(TTL_MS + 1);

    const response = await keepSeparate(attemptId, { revision: 0 });

    expect(response.statusCode).toBe(410);
  });

  it("answers 404 for an unknown attempt", async () => {
    const response = await keepSeparate("missing", { revision: 0 });

    expect(response.statusCode).toBe(404);
  });

  it("reports uncertain when the candidate recheck cannot be trusted", async () => {
    const { attemptId } = await beginNeedsReview();
    await h.db.execute(sql`DROP FUNCTION IF EXISTS work_title_key(text) CASCADE`);

    const response = await keepSeparate(attemptId, { revision: 0 });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "uncertain" });
  });

  it("rejects a malformed keep-separate body with 400 invalid_request", async () => {
    const { attemptId } = await beginNeedsReview();

    const response = await keepSeparate(attemptId, {});

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_request" });
  });
});

describe("Markdown creation-review cancel / Back (#747)", () => {
  it("cancels a pending attempt and removes its staged bytes", async () => {
    const { attemptId } = await beginNeedsReview();
    const attempt = (
      await h.db.select().from(workCreationAttempts).where(eq(workCreationAttempts.id, attemptId))
    )[0];
    const stagePath = attempt!.stagePath!;
    expect(await fileExists(stagePath)).toBe(true);

    const response = await cancel(attemptId);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ cancelled: true });
    expect(await fileExists(stagePath)).toBe(false);
    const cancelled = (
      await h.db.select().from(workCreationAttempts).where(eq(workCreationAttempts.id, attemptId))
    )[0];
    expect(cancelled?.state).toBe("cancelled");
    expect(cancelled?.stagePath).toBeNull();
  });

  it("reports not-cancelled for an unknown attempt", async () => {
    const response = await cancel("missing");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ cancelled: false });
  });

  it("refuses to cancel a finalizing Keep separate / Open existing and never deletes its in-flight stage", async () => {
    const { attemptId } = await beginNeedsReview();
    const attempt = (
      await h.db.select().from(workCreationAttempts).where(eq(workCreationAttempts.id, attemptId))
    )[0];
    const stagePath = attempt!.stagePath!;
    expect(await fileExists(stagePath)).toBe(true);

    // A serialized decision (Keep separate / Open existing) claimed the slot: pending -> finalizing. Its
    // stage is still bound while the decision commits.
    await beginFinalizeAttempt(h.db, {
      expectedRevision: 0,
      id: attemptId,
      now: h.clock.now,
      userId: DEFAULT_USER_ID
    });

    // A concurrent or stale Back must be a no-op: it cannot flip the finalizing row to cancelled, and it
    // must not delete the staged bytes the in-flight decision is about to transfer to provenance.
    const result = await cancelWorkCreation(h.deps, DEFAULT_USER_ID, attemptId);

    expect(result).toEqual({ cancelled: false });
    expect(await fileExists(stagePath)).toBe(true);
    const row = (
      await h.db.select().from(workCreationAttempts).where(eq(workCreationAttempts.id, attemptId))
    )[0];
    expect(row?.state).toBe("finalizing");
    expect(row?.stagePath).toBe(stagePath);
  });
});

describe("Markdown creation-review expiry sweep (#747)", () => {
  it("sweeps an expired finalizing attempt with no staged file", async () => {
    const { attemptId } = await beginNeedsReview();
    const fenced = await beginFinalizeAttempt(h.db, {
      expectedRevision: 0,
      id: attemptId,
      now: h.clock.now,
      userId: DEFAULT_USER_ID
    });
    await detachStagePath(h.db, {
      expectedRevision: fenced!.revision,
      id: attemptId,
      now: h.clock.now,
      userId: DEFAULT_USER_ID
    });
    h.advance(TTL_MS + 1);

    // Any operation opportunistically sweeps expired attempts; this one has a null stage path.
    await getWorkCreationReview(h.deps, DEFAULT_USER_ID, "unrelated");

    const swept = (
      await h.db.select().from(workCreationAttempts).where(eq(workCreationAttempts.id, attemptId))
    )[0];
    expect(swept?.state).toBe("expired");
  });

  it("resumes the owner's existing review when a second begin races the single-attempt slot", async () => {
    const { attemptId } = await beginNeedsReview();

    // A second begin for the same owner while an attempt is already pending must not orphan a stage or
    // double-own the slot; it resumes the existing review instead.
    const second = await begin();

    expect(second.statusCode).toBe(200);
    const body = second.json();
    expect(body.status).toBe("needs_review");
    expect(body.review.attemptId).toBe(attemptId);
    expect(await h.db.select().from(workCreationAttempts)).toHaveLength(1);
    // Only the original attempt's stage remains; the raced begin cleaned up its just-staged file.
    const staged = (await readdir(h.sourcesDir)).length;
    expect(staged).toBe(1);
  });

  it("frames the resumed review by the older attempt's own upload, never the racing file (#747)", async () => {
    // The first upload ("politics.md") parks a pending review. A DIFFERENT Markdown upload for the same
    // owner then races the single-active-attempt slot. The resumed review must describe the FIRST attempt
    // — its own filename and proposal — so a refresh / second tab / stale attempt can never make the
    // learner decide on and commit/discard the racing file's bytes while the panel is framed as that file.
    const { attemptId } = await beginNeedsReview();

    const second = await begin({
      fileName: "a-different-upload.md",
      markdown: `${MARKDOWN}\n\nA distinct trailing paragraph.`
    });

    expect(second.statusCode).toBe(200);
    const resumed = parseWorkCreationReviewDto(second.json().review);
    expect(resumed.attemptId).toBe(attemptId);
    // Framed by the reviewed (first) attempt's own upload and proposal — not the racing "a-different-upload.md".
    expect(resumed.sourceFileName).toBe("politics.md");
    expect(resumed.proposed.title).toBe(TITLE);
  });
});

describe("EPUB creation-review begin (#748)", () => {
  it("commits immediately when no credible duplicate exists", async () => {
    const response = await beginEpub();

    expect(response.statusCode).toBe(201);
    const body = response.json() as IngestEpubResultDto;
    expect(body.work).toMatchObject({ origin: "imported", title: EPUB_TITLE, workType: "book" });
    expect(body.content.readingUnits.length).toBeGreaterThan(0);

    expect(await countWorks()).toBe(1);
    expect(await h.db.select().from(workCreationAttempts)).toHaveLength(0);
    expect(await h.db.select().from(uploadedSourceClaims)).toHaveLength(1);
  });

  it("reopens the owning Work when identical bytes are re-uploaded", async () => {
    const first = (await beginEpub()).json() as IngestEpubResultDto;

    const response = await beginEpub();

    expect(response.statusCode).toBe(200);
    const body = response.json() as IngestEpubResultDto;
    expect(body.work.entryId).toBe(first.work.entryId);
    expect(await countWorks()).toBe(1);
    expect(await h.db.select().from(uploadedSourceClaims)).toHaveLength(1);
  });

  it("refuses an unreadable archive with 422 and stages nothing", async () => {
    h.epub.respond = () => Promise.reject(new Error("not a zip"));

    const response = await beginEpub();

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: "invalid_epub" });
    expect(await readdir(h.sourcesDir)).toEqual([]);
    expect(await countWorks()).toBe(0);
    expect(await h.db.select().from(uploadedSourceClaims)).toHaveLength(0);
  });

  it("parks one review attempt keyed on the EPUB when a duplicate is credible", async () => {
    const candidateId = await seedEpubCandidate();

    const response = await beginEpub();

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("needs_review");
    const review = parseWorkCreationReviewDto(body.review);
    expect(review.proposed).toEqual({
      authorName: EPUB_AUTHOR,
      language: "zh-CN",
      title: EPUB_TITLE,
      workType: "book"
    });
    // The upload has no client-supplied name; the DTO derives an `.epub` label from the title.
    expect(review.sourceFileName.endsWith(".epub")).toBe(true);
    expect(review.candidates).toHaveLength(1);
    expect(review.candidates[0]).toMatchObject({ entryId: candidateId, matchTier: "exact" });

    // The attempt persists staged bytes as an EPUB; NO Work, source, or claim is created yet.
    const attempts = await h.db.select().from(workCreationAttempts);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.sourceKind).toBe("epub");
    expect(attempts[0]?.sourceFileName).toBeNull();
    expect(await fileExists(attempts[0]!.stagePath!)).toBe(true);
    expect(await countWorks()).toBe(1);
    expect(await h.db.select().from(uploadedSourceClaims)).toHaveLength(0);
  });

  it("reports uncertain when the candidate query cannot be trusted, staging nothing", async () => {
    await h.db.execute(sql`DROP FUNCTION IF EXISTS work_title_key(text) CASCADE`);

    const response = await beginEpub();

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "uncertain" });
    expect(await readdir(h.sourcesDir)).toEqual([]);
    expect(await countWorks()).toBe(0);
  });

  it("resumes the owner's existing EPUB review when a second begin races the single-attempt slot", async () => {
    await seedEpubCandidate();
    const first = (await beginEpub()).json();
    expect(first.status).toBe("needs_review");
    const attemptId = first.review.attemptId as string;

    // A second begin for the same owner while an attempt is already pending must clean up its
    // just-staged file and resume the existing review rather than double-owning the slot (#748).
    const second = await beginEpub();

    expect(second.statusCode).toBe(200);
    const body = second.json();
    expect(body.status).toBe("needs_review");
    expect(body.review.attemptId).toBe(attemptId);
    expect(await h.db.select().from(workCreationAttempts)).toHaveLength(1);
    // Only the original attempt's stage remains; the raced begin deleted its own just-staged file.
    expect((await readdir(h.sourcesDir)).length).toBe(1);
  });
});

describe("EPUB creation-review keep separate (#748)", () => {
  it("commits a distinct Work atomically, transferring the staged EPUB with units, image, and nav", async () => {
    const png = pngBytes();
    const image: ParsedEpubImage = { bytes: png, contentType: "image/png", src: "img/dot.png" };
    h.epub.respond = () => Promise.resolve(figureNavEpub(image));
    await seedEpubCandidate();

    const begun = (await beginEpub()).json();
    expect(begun.status).toBe("needs_review");
    const attemptId = begun.review.attemptId as string;
    const stagePath = (
      await h.db.select().from(workCreationAttempts).where(eq(workCreationAttempts.id, attemptId))
    )[0]!.stagePath!;

    const response = await keepSeparate(attemptId, { revision: 0 });

    expect(response.statusCode).toBe(201);
    const body = response.json() as { result: IngestEpubResultDto; status: string };
    expect(body.status).toBe("created");
    expect(body.result.work).toMatchObject({ title: EPUB_TITLE, workType: "book" });
    expect(await countWorks()).toBe(2);

    // The figure block carries its stored image — the transferred archive's resources were committed.
    const figure = body.result.content.readingUnits
      .flatMap((unit) => unit.blocks)
      .find((block) => block.blockType === "figure");
    expect(figure?.imageResourceId).toBe(hashBytes(png));

    // The authored nav was persisted as toc_entries in the same transaction.
    const toc = await h.db
      .select()
      .from(tocEntries)
      .where(eq(tocEntries.workEntryId, body.result.work.entryId));
    expect(toc.map((entry) => entry.label)).toEqual(["Chapter One", "Chapter Two"]);

    // The staged EPUB was transferred in place as provenance and the attempt cleared its stage reference.
    const sources = await h.db
      .select()
      .from(workSources)
      .where(eq(workSources.workEntryId, body.result.work.entryId));
    expect(sources[0]).toMatchObject({ fileName: null, filePath: stagePath, kind: "upload" });
    expect(await fileExists(stagePath)).toBe(true);
    const completed = (
      await h.db.select().from(workCreationAttempts).where(eq(workCreationAttempts.id, attemptId))
    )[0];
    expect(completed?.state).toBe("completed");
    expect(completed?.stagePath).toBeNull();
    expect(await h.db.select().from(uploadedSourceClaims)).toHaveLength(1);
  });

  it("reopens the existing Work when identical EPUB bytes were claimed meanwhile (exact_existing)", async () => {
    await seedEpubCandidate();
    const begun = (await beginEpub()).json();
    const attemptId = begun.review.attemptId as string;
    // The same bytes are committed out-of-band (the one-step front door) before the learner decides.
    const claimed = await ingestEpubCommand(h.content, new Uint8Array([1, 2, 3]));
    const claimedEntryId =
      claimed.status === "created" || claimed.status === "exact_existing"
        ? claimed.result.work.entryId
        : "";

    const response = await keepSeparate(attemptId, { revision: 0 });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { result: IngestEpubResultDto; status: string };
    expect(body.status).toBe("exact_existing");
    expect(body.result.work.entryId).toBe(claimedEntryId);
    const attempt = (
      await h.db.select().from(workCreationAttempts).where(eq(workCreationAttempts.id, attemptId))
    )[0];
    expect(attempt?.state).toBe("completed");
    expect(attempt?.stagePath).toBeNull();
  });

  it("reopens the chosen existing Work, consuming the EPUB attempt without creating anything", async () => {
    const candidateId = await seedEpubCandidate();
    const begun = (await beginEpub()).json();
    const attemptId = begun.review.attemptId as string;

    const response = await openExisting(attemptId, { entryId: candidateId, revision: 0 });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { result: IngestEpubResultDto; status: string };
    expect(body.status).toBe("opened");
    expect(body.result.work.entryId).toBe(candidateId);
    expect(await countWorks()).toBe(1);
    const attempt = (
      await h.db.select().from(workCreationAttempts).where(eq(workCreationAttempts.id, attemptId))
    )[0];
    expect(attempt?.state).toBe("completed");
    expect(attempt?.stagePath).toBeNull();
    // The staged EPUB was discarded, not transferred.
    expect(await readdir(h.sourcesDir)).toEqual([]);
  });
});

// Async: reopened content resolves to a canonical empty document (#720) — exactly one reading unit whose
// only PM `docBlocks` node is an empty paragraph, and no legacy mdast blocks (the clean canonical schema
// a manual Work is created with). This is the shape the manual editor opens on.
function assertEmptyDocument(result: IngestEpubResultDto): void {
  expect(result.content.readingUnits).toHaveLength(1);
  const unit = result.content.readingUnits[0];
  expect(unit?.blocks ?? []).toHaveLength(0);
  const docBlocksOfUnit = unit?.docBlocks ?? [];
  expect(docBlocksOfUnit).toHaveLength(1);
  expect(docBlocksOfUnit[0]?.type).toBe("paragraph");
}

describe("Manual creation-review begin (#749)", () => {
  it("creates the manual Work immediately with a canonical empty document when no duplicate is credible", async () => {
    const response = await beginManual();

    expect(response.statusCode).toBe(201);
    const body = response.json() as { result: IngestEpubResultDto; status: string };
    expect(body.status).toBe("created");
    expect(body.result.work).toMatchObject({ origin: "manual", title: TITLE, workType: "essay" });
    assertEmptyDocument(body.result);

    // The Work exists with a manual ownership facet; no review attempt, no upload claim, and — since manual
    // carries no bytes — nothing was ever staged on disk.
    expect(await countWorks()).toBe(1);
    expect(await h.db.select().from(workCreationAttempts)).toHaveLength(0);
    expect(await h.db.select().from(uploadedSourceClaims)).toHaveLength(0);
    expect(await readdir(h.sourcesDir)).toEqual([]);
    const owned = await h.db
      .select()
      .from(personalEntries)
      .where(eq(personalEntries.entryId, body.result.work.entryId));
    expect(owned).toHaveLength(1);
    // The new author was created inside the create transaction, not before it.
    expect(await h.db.select().from(authors)).toHaveLength(1);
  });

  it("reuses a name-matched existing author instead of creating a duplicate identity", async () => {
    const existingId = await seedAuthor("orwell", "George Orwell");

    const response = await beginManual();

    expect(response.statusCode).toBe(201);
    const body = response.json() as { result: IngestEpubResultDto; status: string };
    expect(body.result.work.authorId).toBe(existingId);
    expect(await h.db.select().from(authors)).toHaveLength(1);
  });

  it("parks one metadata-only review attempt when a duplicate is credible, creating nothing", async () => {
    const candidateId = await seedCandidateWork({
      authorId: await seedAuthor("existing-author", "Someone Else"),
      entryId: "candidate-1"
    });

    const response = await beginManual();

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("needs_review");
    const review = parseWorkCreationReviewDto(body.review);
    expect(review.proposed).toEqual({
      authorName: "George Orwell",
      language: "en",
      title: TITLE,
      workType: "essay"
    });
    expect(review.candidates).toHaveLength(1);
    expect(review.candidates[0]).toMatchObject({ entryId: candidateId });

    // The attempt is metadata-only: manual carries no bytes, so hash / filename / stage are all null and the
    // store never handed it a stage. No Work, ownership facet, source claim, or staged file was created.
    const attempts = await h.db.select().from(workCreationAttempts);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      sourceKind: "manual",
      sourceHash: null,
      sourceFileName: null,
      stagePath: null
    });
    expect(await countWorks()).toBe(1);
    expect(await readdir(h.sourcesDir)).toEqual([]);
    expect(await h.db.select().from(uploadedSourceClaims)).toHaveLength(0);
    // The proposed new author is NOT created while the attempt is only parked for review.
    expect(await h.db.select().from(authors)).toHaveLength(1);
  });

  it("refuses an unknown existing author with 400 author_not_found, creating nothing", async () => {
    const response = await beginManual({ author: { mode: "existing", authorId: "ghost-author" } });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ status: "author_not_found" });
    expect(await countWorks()).toBe(0);
    expect(await h.db.select().from(workCreationAttempts)).toHaveLength(0);
  });

  it("reports uncertain (503) when the candidate query cannot be trusted, creating nothing", async () => {
    await h.db.execute(sql`DROP FUNCTION IF EXISTS work_title_key(text) CASCADE`);

    const response = await beginManual();

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "uncertain" });
    expect(await countWorks()).toBe(0);
    expect(await h.db.select().from(workCreationAttempts)).toHaveLength(0);
    expect(await readdir(h.sourcesDir)).toEqual([]);
  });

  it("rejects a malformed begin body with 400 invalid_request", async () => {
    const response = await h.server.inject({
      method: "POST",
      payload: { title: TITLE },
      url: "/api/works/manual"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_request" });
  });

  it("rejects an attempt to forge an origin through the manual front door (strict body)", async () => {
    // `origin` is implicit `manual` and never accepted from the client; a body carrying it is rejected by
    // the strict schema, so no request can create a non-manual Work through this route.
    const response = await beginManual({ origin: "imported" });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_request" });
    expect(await countWorks()).toBe(0);
  });

  it("resumes the owner's existing review when a second manual begin races the single-attempt slot", async () => {
    const { attemptId } = await beginManualNeedsReview();

    // A second manual begin for the same owner while an attempt is already pending must resume the existing
    // review rather than double-owning the slot — and there is no staged file to clean up.
    const second = await beginManual();

    expect(second.statusCode).toBe(200);
    const body = second.json();
    expect(body.status).toBe("needs_review");
    expect(body.review.attemptId).toBe(attemptId);
    expect(await h.db.select().from(workCreationAttempts)).toHaveLength(1);
    expect(await readdir(h.sourcesDir)).toEqual([]);
  });
});

describe("Manual creation-review open existing (#749)", () => {
  it("reopens the chosen Work, consuming the metadata-only attempt without creating anything", async () => {
    const { attemptId, candidateId } = await beginManualNeedsReview();

    const response = await openExisting(attemptId, { entryId: candidateId, revision: 0 });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { result: IngestEpubResultDto; status: string };
    expect(body.status).toBe("opened");
    expect(body.result.work.entryId).toBe(candidateId);
    // Nothing new was created; the attempt is consumed and — having no stage — leaves the disk untouched.
    expect(await countWorks()).toBe(1);
    const attempt = (
      await h.db.select().from(workCreationAttempts).where(eq(workCreationAttempts.id, attemptId))
    )[0];
    expect(attempt?.state).toBe("completed");
    expect(attempt?.stagePath).toBeNull();
    expect(await readdir(h.sourcesDir)).toEqual([]);
  });
});

describe("Manual creation-review keep separate (#749)", () => {
  it("commits a distinct manual Work with a canonical empty document and no staged source", async () => {
    const { attemptId } = await beginManualNeedsReview();

    const response = await keepSeparate(attemptId, { revision: 0 });

    expect(response.statusCode).toBe(201);
    const body = response.json() as { result: IngestEpubResultDto; status: string };
    expect(body.status).toBe("created");
    expect(body.result.work).toMatchObject({ origin: "manual", title: TITLE });
    assertEmptyDocument(body.result);
    // A second, distinct Work now exists alongside the reviewed candidate — with an ownership facet, its
    // empty document persisted, no upload source, and no staged file.
    expect(await countWorks()).toBe(2);
    expect(
      await h.db
        .select()
        .from(workSources)
        .where(eq(workSources.workEntryId, body.result.work.entryId))
    ).toHaveLength(0);
    expect(
      await h.db
        .select()
        .from(personalEntries)
        .where(eq(personalEntries.entryId, body.result.work.entryId))
    ).toHaveLength(1);
    // Manual creation writes only the canonical PM document, never a legacy mdast block row.
    expect(
      await h.db.select().from(blocks).where(eq(blocks.workEntryId, body.result.work.entryId))
    ).toHaveLength(0);
    expect(await readdir(h.sourcesDir)).toEqual([]);
    const completed = (
      await h.db.select().from(workCreationAttempts).where(eq(workCreationAttempts.id, attemptId))
    )[0];
    expect(completed?.state).toBe("completed");
  });

  it("creates the new proposed author only at the Keep separate commit, not while parked", async () => {
    const { attemptId } = await beginManualNeedsReview();
    // Only the seeded candidate's author exists while the attempt is parked for review.
    expect(await h.db.select().from(authors)).toHaveLength(1);

    const response = await keepSeparate(attemptId, { revision: 0 });

    expect(response.statusCode).toBe(201);
    // The proposed "George Orwell" identity is minted inside the commit transaction.
    expect(await h.db.select().from(authors)).toHaveLength(2);
  });

  it("commits a distinct manual Work reusing the selected existing author", async () => {
    const existingId = await seedAuthor("orwell", "George Orwell");
    await seedCandidateWork({
      authorId: await seedAuthor("someone-else", "Someone Else"),
      entryId: "candidate-1"
    });
    const begun = (
      await beginManual({ author: { mode: "existing", authorId: existingId } })
    ).json();
    expect(begun.status).toBe("needs_review");
    const attemptId = begun.review.attemptId as string;

    const response = await keepSeparate(attemptId, { revision: 0 });

    expect(response.statusCode).toBe(201);
    const body = response.json() as { result: IngestEpubResultDto; status: string };
    expect(body.result.work).toMatchObject({ authorId: existingId, origin: "manual" });
    expect(await h.db.select().from(authors)).toHaveLength(2);
  });

  it("refreshes the panel under a bumped revision when the candidate evidence changed", async () => {
    const { attemptId } = await beginManualNeedsReview();
    await seedCandidateWork({
      authorId: await seedAuthor("second-author", "Another Person"),
      entryId: "candidate-2"
    });

    const response = await keepSeparate(attemptId, { revision: 0 });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("needs_review");
    const review = parseWorkCreationReviewDto(body.review);
    expect(review.revision).toBe(1);
    expect(review.candidates).toHaveLength(2);
    // Nothing was committed: only the two seeded candidate Works exist.
    expect(await countWorks()).toBe(2);
  });

  it("answers 409 superseded for a stale revision, committing nothing", async () => {
    const { attemptId } = await beginManualNeedsReview();

    const response = await keepSeparate(attemptId, { revision: 9 });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ status: "superseded" });
    expect(await countWorks()).toBe(1);
  });

  it("does not commit a second manual Work when Keep separate is replayed after it finalized", async () => {
    const { attemptId } = await beginManualNeedsReview();
    const first = await keepSeparate(attemptId, { revision: 0 });
    expect(first.statusCode).toBe(201);
    expect(await countWorks()).toBe(2);

    // The consumed attempt is no longer pending at revision 0: a replayed decision is fenced out (409
    // superseded) and creates nothing more.
    const replay = await keepSeparate(attemptId, { revision: 0 });
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toEqual({ status: "superseded" });
    expect(await countWorks()).toBe(2);
  });

  it("reports uncertain when the candidate recheck cannot be trusted, committing nothing", async () => {
    const { attemptId } = await beginManualNeedsReview();
    await h.db.execute(sql`DROP FUNCTION IF EXISTS work_title_key(text) CASCADE`);

    const response = await keepSeparate(attemptId, { revision: 0 });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "uncertain" });
    expect(await countWorks()).toBe(1);
  });
});

describe("Manual creation-review cancel / Back (#749)", () => {
  it("cancels a pending metadata-only attempt with no staged bytes to remove", async () => {
    const { attemptId } = await beginManualNeedsReview();

    const response = await cancel(attemptId);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ cancelled: true });
    const attempt = (
      await h.db.select().from(workCreationAttempts).where(eq(workCreationAttempts.id, attemptId))
    )[0];
    expect(attempt?.state).toBe("cancelled");
    expect(await countWorks()).toBe(1);
  });
});
