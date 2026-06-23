import { initEpubFile } from "@lingo-reader/epub-parser";
import { mkdir } from "node:fs/promises";

import { normalizeEpubMetadata, type NormalizedEpubMetadata } from "@whetstone/domain";

// One spine chapter's processed body HTML; CSS/images are ignored in v0 since only
// text blocks are modeled.
export type ParsedEpubChapter = Readonly<{ html: string }>;

export type ParsedEpub = Readonly<{
  chapters: ReadonlyArray<ParsedEpubChapter>;
  metadata: NormalizedEpubMetadata;
}>;

// The EPUB parsing boundary: bytes in, normalized metadata and ordered chapter HTML
// out. Injected as a dependency so ingestion commands test against a fake parser while
// the real `@lingo-reader/epub-parser` integration is covered separately.
export type EpubParser = (bytes: Uint8Array) => Promise<ParsedEpub>;

export function createEpubParser(resourceSaveDir: string): EpubParser {
  return async function parseEpub(bytes: Uint8Array): Promise<ParsedEpub> {
    await mkdir(resourceSaveDir, { recursive: true });
    const epub = await initEpubFile(bytes, resourceSaveDir);

    try {
      const metadata = normalizeEpubMetadata(epub.getMetadata());
      const chapters: ParsedEpubChapter[] = [];

      for (const item of epub.getSpine()) {
        if (item.linear === "no") {
          continue;
        }

        const chapter = await epub.loadChapter(item.id);
        chapters.push({ html: chapter.html });
      }

      return Object.freeze({ chapters, metadata });
    } finally {
      epub.destroy();
    }
  };
}
