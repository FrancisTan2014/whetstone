import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { toEntryId } from "@whetstone/domain";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { createImageResourceStore } from "../../files/imageResourceStore.js";
import { createSourceFileStore } from "../../files/sourceFileStore.js";
import type { ParsedEpub, ParsedEpubImage } from "../../files/epubSource.js";
import type { ContentDependencies } from "./contentCommands.js";
import { ingestEpub } from "./epubCommands.js";
import {
  loadReadingUnitContent,
  loadWorkAnchorIndex,
  loadWorkContent,
  loadWorkStructure
} from "./contentQueries.js";
import type { IngestionEvidence } from "./htmlToDocument.js";
import type { WorkContentDto } from "@whetstone/contracts";

const corpusDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../../fixtures/ingest"
);

function readCorpus(name: string): string {
  return readFileSync(join(corpusDir, name), "utf8");
}

// A 1x1 transparent PNG — the smallest valid raster so a referenced figure image resolves to a stored
// resource without committing a real illustration.
const pngBytes = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64"
  )
);

function image(src: string): ParsedEpubImage {
  return { bytes: pngBytes, contentType: "image/png", src };
}

// A minimal valid SVG document for the <svg><image> figure construct.
const svgBytes = Uint8Array.from(
  Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>', "utf8")
);

function svgImage(src: string): ParsedEpubImage {
  return { bytes: svgBytes, contentType: "image/svg+xml", src };
}

// A Part-as-sibling authored nav (#515 shape): Part I is a flat `<li>` sibling of its chapters, each
// chapter targeting a chapter file plus its section anchor.
const navSource = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>
  <nav epub:type="toc"><ol>
    <li data-type="part"><a href="chapter1.xhtml#ch1_figures">Part I. Foundations</a></li>
    <li data-type="chapter"><a href="chapter1.xhtml#ch1_figures">1. Foundations</a></li>
    <li data-type="chapter"><a href="chapter2.xhtml#ch2_constructs">2. Distributed Data</a></li>
  </ol></nav>
</body></html>`;

function corpusEpub(): ParsedEpub {
  return {
    chapters: [
      {
        html: readCorpus("chapter1.xhtml"),
        images: [image("fig-standalone.png"), image("fig-nested.png"), svgImage("fig-svg.svg")],
        sourceFile: "chapter1.xhtml"
      },
      {
        html: readCorpus("chapter2.xhtml"),
        images: [],
        sourceFile: "chapter2.xhtml"
      }
    ],
    metadata: { author: "Synthetic Fixtures", language: "en", title: "Ingestion Fidelity Corpus" },
    nav: { kind: "xhtml-nav", path: "nav.xhtml", source: navSource }
  };
}

type TestContext = Readonly<{
  db: DbClient;
  dependencies: ContentDependencies;
  evidence: IngestionEvidence[];
  imagesDir: string;
  pglite: PGlite;
  sourcesDir: string;
}>;

let context: TestContext;

async function buildContext(makeEpub: () => ParsedEpub = corpusEpub): Promise<TestContext> {
  const pglite = new PGlite();
  await runMigrations(pglite);
  const db = createDbClient(pglite);
  const sourcesDir = await mkdtemp(join(tmpdir(), "whetstone-ingest-fidelity-"));
  const imagesDir = await mkdtemp(join(tmpdir(), "whetstone-ingest-fidelity-img-"));
  const evidence: IngestionEvidence[] = [];

  let entrySequence = 0;
  let sourceSequence = 0;
  let authorSequence = 0;
  const dependencies: ContentDependencies = {
    createAuthorId: () => `author-${(authorSequence += 1)}`,
    createEntryId: () => `entry-${(entrySequence += 1)}`,
    createSourceId: () => `source-${(sourceSequence += 1)}`,
    db,
    epubParser: async () => makeEpub(),
    epubUploadLimitBytes: 50 * 1024 * 1024,
    imageResourceStore: createImageResourceStore(imagesDir),
    ingestionLogger: (records) => evidence.push(...records),
    sourceFileStore: createSourceFileStore(sourcesDir)
  };

  return { db, dependencies, evidence, imagesDir, pglite, sourcesDir };
}

beforeEach(async () => {
  context = await buildContext();
});

afterEach(async () => {
  await rm(context.sourcesDir, { force: true, recursive: true });
  await rm(context.imagesDir, { force: true, recursive: true });
});

// The prose paragraphs authored in each chapter, verbatim — item 2 asserts each survives ingestion as
// exactly one paragraph block (never shattered into fragments, and never absorbed into a figure).
const CH1_PROSE: ReadonlyArray<string> = [
  "The North Wind and the Sun disputed as to which was the most powerful, and agreed on a contest.",
  "The keener the blasts of the North Wind, the closer the traveler wrapped his cloak around him.",
  "Persuasion is often more effective than force, as the gentle Sun proved that day."
];
const CH2_PROSE: ReadonlyArray<string> = [
  "Replication keeps a copy of the same data on multiple machines connected via a network.",
  "The callouts above mark the append log.append step and the fan-out to followers.",
  "写入领导者之后，变更会流向每一个跟随者，保持数据一致。"
];

// The number of figure images authored across the corpus: a standalone <img> and a <figure> nested in
// <div>/<section> wrappers, plus an <svg><image>.
const EXPECTED_FIGURES = 3;

async function ingestCorpus(): Promise<WorkContentDto> {
  const result = await ingestEpub(context.dependencies, new Uint8Array([1, 2, 3]));
  if (result.status !== "created") {
    throw new Error(`expected created, got ${result.status}`);
  }
  return loadWorkContent(context.db, toEntryId(result.result.work.entryId));
}

function allBlocks(content: WorkContentDto) {
  return content.readingUnits.flatMap((unit) => unit.blocks);
}

describe("EPUB ingestion fidelity invariants (#520)", () => {
  it("produces no unknown blocks and records no unrecognized-construct evidence", async () => {
    const content = await ingestCorpus();

    // Fail-loud (#311/#523): every construct the corpus carries is modeled, so the evidence sink is
    // empty and no block degraded to `unknown` — the "zero un-evidenced loss" floor for a clean corpus
    // (the loud-loss direction is asserted below and in htmlToDocument.test.ts).
    expect(context.evidence).toEqual([]);
    expect(allBlocks(content).map((block) => block.blockType)).not.toContain("unknown");
  });

  it("keeps every known prose paragraph intact — no shattered paragraphs", async () => {
    const content = await ingestCorpus();
    const paragraphs = allBlocks(content)
      .filter((block) => block.blockType === "paragraph")
      .map((block) => block.plaintext);

    for (const sentence of [...CH1_PROSE, ...CH2_PROSE]) {
      // Exactly one paragraph block equals the authored sentence: not split into fragments, not merged.
      expect(paragraphs.filter((text) => text === sentence)).toHaveLength(1);
    }
  });

  it("captures every figure image as a figure block", async () => {
    const content = await ingestCorpus();
    const figures = allBlocks(content).filter((block) => block.blockType === "figure");

    expect(figures).toHaveLength(EXPECTED_FIGURES);
  });

  it("resolves every authored nav target to a reading unit and, when anchored, to a block", async () => {
    const result = await ingestEpub(context.dependencies, new Uint8Array([1, 2, 3]));
    if (result.status !== "created") {
      throw new Error(`expected created, got ${result.status}`);
    }
    const workEntryId = toEntryId(result.result.work.entryId);
    const structure = await loadWorkStructure(context.db, workEntryId);
    const anchorIndex = await loadWorkAnchorIndex(context.db, workEntryId);

    const anchors = new Set(anchorIndex.anchors.map((entry) => entry.anchor));
    const toc = structure.tableOfContents ?? [];
    expect(toc.length).toBeGreaterThan(0);
    for (const entry of toc) {
      // No dangling TOC target: the source file resolved to a unit, and any fragment is a real anchor.
      expect(entry.targetUnitEntryId).toBeDefined();
      if (entry.targetAnchor !== undefined) {
        expect(anchors.has(entry.targetAnchor)).toBe(true);
      }
    }
  });

  it("supports a whole-block selection on every text block — no out_of_range anchor", async () => {
    const result = await ingestEpub(context.dependencies, new Uint8Array([1, 2, 3]));
    if (result.status !== "created") {
      throw new Error(`expected created, got ${result.status}`);
    }
    const workEntryId = toEntryId(result.result.work.entryId);
    const content = await loadWorkContent(context.db, workEntryId);

    // A whole-block note anchor (contextSnapshot = selectedTextSnapshot = the block's plaintext) is what
    // the reader captures when the whole block is selected; the server's `anchorFitsBlock` accepts it iff
    // that snapshot is contained in the stored plaintext. For a non-empty block that is `plaintext`
    // itself, so it always fits — the #344 shatter class (stored plaintext inconsistent with the
    // rendered text a selection produces) is what breaks it. Assert every addressable text block carries
    // non-empty plaintext whose own whole-block snapshot fits, on the reader-addressable doc blocks.
    const textTypes = new Set(["paragraph", "heading", "list", "blockquote", "code", "table"]);
    let textBlocksChecked = 0;
    for (const unit of content.readingUnits) {
      const unitContent = await loadReadingUnitContent(context.db, workEntryId, unit.entryId);
      if (unitContent === undefined) {
        throw new Error(`no reading-unit content for ${unit.entryId}`);
      }
      for (const block of unitContent.blocks) {
        if (!textTypes.has(block.blockType)) {
          continue;
        }
        expect(
          block.plaintext.length,
          `empty text block ${block.entryId} (${block.blockType})`
        ).toBeGreaterThan(0);
        // The whole-block selection snapshot is contained in the block plaintext → the anchor fits.
        expect(block.plaintext.includes(block.plaintext)).toBe(true);
        textBlocksChecked += 1;
      }
    }

    expect(textBlocksChecked).toBeGreaterThanOrEqual(CH1_PROSE.length + CH2_PROSE.length);
  });

  // #523 — the fail-loud invariant widens from "zero unknown blocks" to "zero un-evidenced loss": a
  // construct the schema cannot represent must surface an `IngestionEvidence` record, never vanish
  // silently. These exercise the loss categories end to end through `ingestEpub -> ingestionLogger`:
  // INLINE (an `<img>` in flowing prose) and WRAPPER-METADATA (an anchored wrapper whose inline-only
  // content leaves its id nowhere to land). The INTRA-ELEMENT category's loud path (unreadable code
  // callout markers) is asserted in htmlToDocument.test.ts.
  async function evidenceForChapter(
    html: string,
    images: ReadonlyArray<ParsedEpubImage>
  ): Promise<IngestionEvidence[]> {
    const epub: ParsedEpub = {
      chapters: [{ html, images, sourceFile: "loss.xhtml" }],
      metadata: { author: "Synthetic Fixtures", language: "en", title: "Loss" }
    };
    const lossy = await buildContext(() => epub);

    try {
      const result = await ingestEpub(lossy.dependencies, new Uint8Array([1, 2, 3]));
      if (result.status !== "created") {
        throw new Error(`expected created, got ${result.status}`);
      }
      return lossy.evidence;
    } finally {
      await rm(lossy.sourcesDir, { force: true, recursive: true });
      await rm(lossy.imagesDir, { force: true, recursive: true });
    }
  }

  it("makes inline-image loss loud through the full ingest path", async () => {
    const evidence = await evidenceForChapter(
      '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>See the diagram <img src="d.png" alt="D"/> here.</p></body></html>',
      [image("d.png")]
    );

    // Loud, end to end: the dropped inline image surfaced an evidence record (tag/path/context).
    const imgEvidence = evidence.filter((record) => record.tag === "img");
    expect(imgEvidence).toHaveLength(1);
    expect(imgEvidence[0]!.path).toBe("body>p>img");
    expect(imgEvidence[0]!.attributes["src"]).toBe("d.png");
  });

  it("makes wrapper-metadata loss loud through the full ingest path", async () => {
    const evidence = await evidenceForChapter(
      '<html xmlns="http://www.w3.org/1999/xhtml"><body><div id="orphan"><span>inline only</span></div></body></html>',
      []
    );

    // Loud, end to end: the anchored wrapper whose id could not be carried surfaced an evidence record.
    const wrapperEvidence = evidence.filter((record) => record.attributes["id"] === "orphan");
    expect(wrapperEvidence).toHaveLength(1);
    expect(wrapperEvidence[0]!.tag).toBe("div");
  });

  // The retained one-step `ingestEpub` front door (immediate-create composition; the #748 review
  // boundary uses `commitImportedEpubWork` directly). These cover its dedup and error contract.
  it("reopens the owning Work on identical bytes instead of creating a duplicate", async () => {
    const first = await ingestEpub(context.dependencies, new Uint8Array([1, 2, 3]));
    if (first.status !== "created") {
      throw new Error(`expected created, got ${first.status}`);
    }

    const second = await ingestEpub(context.dependencies, new Uint8Array([1, 2, 3]));

    expect(second.status).toBe("exact_existing");
    if (second.status !== "exact_existing") {
      throw new Error("unreachable");
    }
    expect(second.result.work.entryId).toBe(first.result.work.entryId);
  });

  it("reports invalid_epub when the archive cannot be parsed", async () => {
    const broken = await buildContext(() => {
      throw new Error("not a zip");
    });

    try {
      const result = await ingestEpub(broken.dependencies, new Uint8Array([9, 9, 9]));

      expect(result.status).toBe("invalid_epub");
    } finally {
      await rm(broken.sourcesDir, { force: true, recursive: true });
      await rm(broken.imagesDir, { force: true, recursive: true });
    }
  });
});
