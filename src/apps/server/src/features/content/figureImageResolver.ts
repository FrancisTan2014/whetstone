import {
  decomposeHtmlChapter,
  sanitizeSvg,
  type DecomposedBlock,
  type DecomposedFigureImage
} from "@whetstone/domain";

import type { ParsedEpubChapter, ParsedEpubImage } from "../../files/epubSource.js";
import {
  isAllowedImageContentType,
  type ImageResourceStore
} from "../../files/imageResourceStore.js";
import type { PersistableBlock, PersistableReadingUnit } from "./blockWriter.js";
import { htmlToDocument } from "./htmlToDocument.js";

type ImageStore = Pick<ImageResourceStore, "store">;

// Store a figure's image and return its content-addressed id, or `null` when the figure
// has no resolvable, storable image: the block carries no image, the parser surfaced no
// bytes for its transient src, or the manifest media type is not in the allowlist. SVG is
// allowed but sanitized first (scripts/handlers/external refs stripped) so the stored bytes
// are safe to serve. Identical bytes resolve to the same id and are stored once.
async function storeFigureImage(
  image: DecomposedFigureImage | undefined,
  imageBySrc: ReadonlyMap<string, ParsedEpubImage>,
  store: ImageStore
): Promise<string | null> {
  if (image === undefined) {
    return null;
  }

  const resource = imageBySrc.get(image.src);

  if (resource === undefined || !isAllowedImageContentType(resource.contentType)) {
    return null;
  }

  const bytes =
    resource.contentType === "image/svg+xml"
      ? new TextEncoder().encode(sanitizeSvg(new TextDecoder().decode(resource.bytes)))
      : resource.bytes;

  const stored = await store.store({ bytes, contentType: resource.contentType });

  return stored.id;
}

async function resolveBlock(
  block: DecomposedBlock,
  imageBySrc: ReadonlyMap<string, ParsedEpubImage>,
  store: ImageStore
): Promise<PersistableBlock | undefined> {
  if (block.blockType !== "figure") {
    return {
      alt: null,
      anchorId: block.anchorId ?? null,
      backlinkAnchorId: block.backlinkAnchorId ?? null,
      blockType: block.blockType,
      imageResourceId: null,
      mdast: block.mdast,
      plaintext: block.plaintext
    };
  }

  const imageResourceId = await storeFigureImage(block.image, imageBySrc, store);

  // A figure with neither a stored image nor a caption carries no content, so it is dropped.
  if (imageResourceId === null && block.plaintext.trim().length === 0) {
    return undefined;
  }

  return {
    alt: imageResourceId === null ? null : (block.image?.alt ?? null),
    anchorId: block.anchorId ?? null,
    backlinkAnchorId: block.backlinkAnchorId ?? null,
    blockType: "figure",
    imageResourceId,
    mdast: block.mdast,
    plaintext: block.plaintext
  };
}

// Decompose each EPUB chapter and resolve its figure blocks against that chapter's
// extracted images: storable images are persisted via the image-resource store and
// stamped onto the block (`imageResourceId` + `alt`); unstorable ones degrade to
// caption-only or drop the block. Text blocks pass through with null figure columns.
export async function resolveChapters(
  chapters: ReadonlyArray<ParsedEpubChapter>,
  store: ImageStore
): Promise<PersistableReadingUnit[]> {
  const units: PersistableReadingUnit[] = [];

  for (const chapter of chapters) {
    const decomposed = decomposeHtmlChapter(chapter.html);
    // Alongside the mdast block decomposition (still read by the reader), run the server-side
    // fidelity ingestion (#311) over the same chapter HTML to build the PM/Tiptap block rows and the
    // fail-loud evidence. One chapter == one reading unit, so its decomposed PM blocks and evidence
    // ride on this unit; #312 switches the reader to these PM blocks.
    const ingested = htmlToDocument(chapter.html);
    const imageBySrc = new Map(chapter.images.map((image) => [image.src, image]));
    const blocks: PersistableBlock[] = [];

    for (const block of decomposed.blocks) {
      const resolved = await resolveBlock(block, imageBySrc, store);

      if (resolved !== undefined) {
        blocks.push(resolved);
      }
    }

    units.push({
      blocks,
      docBlocks: ingested.blocks,
      evidence: ingested.evidence,
      title: decomposed.title
    });
  }

  return units;
}
