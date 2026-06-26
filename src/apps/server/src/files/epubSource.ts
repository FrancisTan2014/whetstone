import { initEpubFile, type ManifestItem } from "@lingo-reader/epub-parser";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { normalizeEpubMetadata, type NormalizedEpubMetadata } from "@whetstone/domain";

// One image referenced by a chapter: `src` is the rewritten `<img src>` exactly as it
// appears in the chapter HTML (an absolute path under the parser's resource directory),
// `bytes` are the extracted image bytes, and `contentType` is the OPF manifest's
// `media-type` for that resource — taken from the manifest only, never sniffed or
// guessed from the file extension.
export type ParsedEpubImage = Readonly<{
  bytes: Uint8Array;
  contentType: string;
  src: string;
}>;

// One spine chapter's processed body HTML plus the images it references. CSS is ignored
// in v0; images are surfaced (not yet stored) so a later slice can persist figures.
export type ParsedEpubChapter = Readonly<{
  html: string;
  images: ReadonlyArray<ParsedEpubImage>;
}>;

export type ParsedEpub = Readonly<{
  chapters: ReadonlyArray<ParsedEpubChapter>;
  metadata: NormalizedEpubMetadata;
}>;

// The EPUB parsing boundary: bytes in, normalized metadata and ordered chapter HTML +
// images out. Injected as a dependency so ingestion commands test against a fake parser
// while the real `@lingo-reader/epub-parser` integration is covered separately.
export type EpubParser = (bytes: Uint8Array) => Promise<ParsedEpub>;

// The parser rewrites each `<img src>` to an absolute, double-quoted path; capture it.
const imgSrcPattern = /<img\b[^>]*?\ssrc="([^"]*)"/gi;

function extractImageSrcs(html: string): string[] {
  // Group 1 is always present when the pattern matches, so the src is never undefined.
  return Array.from(html.matchAll(imgSrcPattern), (match) => match[1] as string);
}

// The parser saves each manifest resource under `resourceSaveDir`, naming it by the
// manifest href with `/` replaced by `_`, and rewrites chapter `<img src>` to that same
// absolute path. Mapping saved path -> manifest media type lets a rewritten src resolve
// back to its declared content type without sniffing bytes.
function mediaTypeBySavedPath(
  manifest: Record<string, ManifestItem>,
  resourceSaveDir: string
): Map<string, string> {
  const byPath = new Map<string, string>();

  for (const item of Object.values(manifest)) {
    byPath.set(resolve(resourceSaveDir, item.href.replace(/\//g, "_")), item.mediaType);
  }

  return byPath;
}

async function extractChapterImages(
  html: string,
  mediaTypes: Map<string, string>
): Promise<ParsedEpubImage[]> {
  const images: ParsedEpubImage[] = [];

  for (const src of extractImageSrcs(html)) {
    const contentType = mediaTypes.get(src);

    // An `<img>` whose target is not a manifest resource has no declared media type, so
    // it cannot be surfaced from the manifest and is skipped.
    if (contentType === undefined) {
      continue;
    }

    images.push({ bytes: await readFile(src), contentType, src });
  }

  return images;
}

export function createEpubParser(resourceSaveDir: string): EpubParser {
  return async function parseEpub(bytes: Uint8Array): Promise<ParsedEpub> {
    await mkdir(resourceSaveDir, { recursive: true });
    const epub = await initEpubFile(bytes, resourceSaveDir);

    try {
      const metadata = normalizeEpubMetadata(epub.getMetadata());
      const mediaTypes = mediaTypeBySavedPath(epub.getManifest(), resourceSaveDir);
      const chapters: ParsedEpubChapter[] = [];

      for (const item of epub.getSpine()) {
        if (item.linear === "no") {
          continue;
        }

        const chapter = await epub.loadChapter(item.id);
        chapters.push({
          html: chapter.html,
          images: await extractChapterImages(chapter.html, mediaTypes)
        });
      }

      return Object.freeze({ chapters, metadata });
    } finally {
      epub.destroy();
    }
  };
}
