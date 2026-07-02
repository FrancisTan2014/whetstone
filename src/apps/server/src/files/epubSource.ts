import { initEpubFile, type ManifestItem } from "@lingo-reader/epub-parser";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  strToU8,
  unzipSync,
  zipSync,
  type Unzipped,
  type Zippable,
  type ZippableFile
} from "fflate";

import { normalizeEpubMetadata, type NormalizedEpubMetadata } from "@whetstone/domain";

import { selectNavResource } from "./epubNav.js";
import { isZipArchive } from "./zipArchive.js";

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

// One spine chapter's processed body HTML plus the images it references. `sourceFile` is the spine
// item's manifest href (its source-file identity), so a unit's anchors can be scoped by source file
// and a cross-file reference resolved to the owning chapter (#366). CSS is ignored in v0; images are
// surfaced (not yet stored) so a later slice can persist figures.
export type ParsedEpubChapter = Readonly<{
  html: string;
  images: ReadonlyArray<ParsedEpubImage>;
  sourceFile: string;
}>;

// The EPUB's authored navigation document (#379), surfaced additively so ingestion can persist the
// nav tree. `source` is the decoded document text (fed to `parseNavDocument`), `kind` selects the
// grammar (EPUB3 `nav.xhtml` vs EPUB2 `toc.ncx`), and `path` is the nav document's own manifest href
// — the base each entry href is resolved against to recover a spine source-file identity. Absent when
// the EPUB declares no nav resource, or reading/decoding it failed (fail-soft, never a throw).
export type ParsedEpubNav = Readonly<{
  kind: "xhtml-nav" | "ncx";
  path: string;
  source: string;
}>;

export type ParsedEpub = Readonly<{
  chapters: ReadonlyArray<ParsedEpubChapter>;
  metadata: NormalizedEpubMetadata;
  nav?: ParsedEpubNav;
}>;

// The EPUB parsing boundary: bytes in, normalized metadata and ordered chapter HTML +
// images out. Injected as a dependency so ingestion commands test against a fake parser
// while the real `@lingo-reader/epub-parser` integration is covered separately.
export type EpubParser = (bytes: Uint8Array) => Promise<ParsedEpub>;

// The parser rewrites each image reference to an absolute, double-quoted path; capture it from <img
// src>, an SVG <image xlink:href|href> (O'Reilly/DDIA wrap diagrams this way), and <object data>.
const imageSrcPatterns = [
  /<img\b[^>]*?\ssrc="([^"]*)"/gi,
  /<image\b[^>]*?\s(?:xlink:href|href)="([^"]*)"/gi,
  /<object\b[^>]*?\sdata="([^"]*)"/gi
];

function extractImageSrcs(html: string): string[] {
  return imageSrcPatterns.flatMap((pattern) =>
    Array.from(html.matchAll(pattern), (match) => match[1] as string)
  );
}

// The saved-path scheme the parser uses for every manifest resource: the manifest href with `/`
// replaced by `_`, under `resourceSaveDir`. Shared by the media-type map and the nav reader so both
// resolve a manifest href to the file the parser wrote to disk.
function savedResourcePath(href: string, resourceSaveDir: string): string {
  return resolve(resourceSaveDir, href.replace(/\//g, "_"));
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
    byPath.set(savedResourcePath(item.href, resourceSaveDir), item.mediaType);
  }

  return byPath;
}

// Fail-fast UTF-8 decoder for the nav document: an undecodable nav resource must be omitted (fail-soft),
// not surfaced as replacement characters, so the byte stream is decoded with `fatal` and the throw is
// caught by the caller.
const navTextDecoder = new TextDecoder("utf-8", { fatal: true });

// Surface the EPUB's authored navigation document (#379) while the archive's resources are on disk.
// Identify the nav resource from the manifest (`selectNavResource`: EPUB3 `nav` property wins over a
// legacy NCX media type), read its saved bytes with the same path scheme as every other resource, and
// decode to UTF-8. Fail-soft at every step — no nav resource, missing/empty bytes, or an undecodable
// stream all yield `undefined` so ingestion simply persists no TOC, never a throw. `path` is the nav
// resource's own manifest href, the base a nav entry's relative href resolves against.
async function readNavDocument(
  manifest: Record<string, ManifestItem>,
  resourceSaveDir: string
): Promise<ParsedEpubNav | undefined> {
  const selected = selectNavResource(
    Object.values(manifest).map((item) => ({
      href: item.href,
      ...(item.mediaType === undefined ? {} : { mediaType: item.mediaType }),
      ...(item.properties === undefined ? {} : { properties: item.properties })
    }))
  );

  if (selected === undefined) {
    return undefined;
  }

  const bytes = await readResourceBytes(savedResourcePath(selected.href, resourceSaveDir));

  if (bytes === null) {
    return undefined;
  }

  try {
    return { kind: selected.kind, path: selected.href, source: navTextDecoder.decode(bytes) };
  } catch {
    return undefined;
  }
}

// Read one manifest resource's bytes, tolerating the two ways a declared resource can be
// effectively absent: `@lingo-reader/epub-parser` writes an **empty file** for a manifest resource
// whose bytes are missing from the archive (rather than omitting it), and a genuinely absent file
// makes `readFile` reject. Either way the resource is unusable, so return null and let the caller
// skip it — a single missing image must not surface as a 0-byte phantom or fail the whole book
// ("surface what you can", cf. the stray-`<img>` skip).
export async function readResourceBytes(src: string): Promise<Uint8Array | null> {
  try {
    const bytes = await readFile(src);
    return bytes.length === 0 ? null : bytes;
  } catch {
    return null;
  }
}

async function extractChapterImages(
  html: string,
  mediaTypes: Map<string, string>,
  onResourceSkipped: (src: string) => void
): Promise<ParsedEpubImage[]> {
  const images: ParsedEpubImage[] = [];

  for (const src of extractImageSrcs(html)) {
    const contentType = mediaTypes.get(src);

    // An `<img>` whose target is not a manifest resource has no declared media type, so
    // it cannot be surfaced from the manifest and is skipped.
    if (contentType === undefined) {
      continue;
    }

    const bytes = await readResourceBytes(src);
    // A declared resource whose bytes are missing (absent file, or the parser's empty-file
    // fallback) is skipped so the chapter and the rest of the book still parse.
    if (bytes === null) {
      onResourceSkipped(src);
      continue;
    }

    images.push({ bytes, contentType, src });
  }

  return images;
}

// --- EPUB robustness: sanitize brittle input before the third-party parser (#359) ---
//
// @lingo-reader/epub-parser@0.4.6 (the latest release) crashes on two classes of validly
// packaged EPUBs, both on data whetstone never consumes:
//   1. It assumes the spine's `toc` points at a legacy NCX and reads `ncx.navMap`
//      unconditionally, so an EPUB3 that ships only `nav.xhtml` (no `.ncx`) throws
//      `Cannot read properties of undefined (reading 'navMap')` inside the constructor.
//   2. While inlining a chapter's `<link rel="stylesheet">` it `readFileSync`s the referenced
//      CSS unconditionally, so a stylesheet the manifest names but does not ship throws ENOENT.
// whetstone reads spine order (never the NCX table of contents) and ignores CSS entirely in v0,
// so both inputs are inert to us. We neutralize them at the ingestion boundary: drop the spine
// `toc` reference and drop stylesheet `<link>`s from chapter HTML. This removes the whole crash
// surface without changing whetstone's output (spine order, body HTML, and images are untouched),
// and any failure to rewrite falls back to the original bytes so the pass can only help.
const XHTML_EXTENSIONS = [".xhtml", ".html", ".htm"] as const;
const MIMETYPE_ENTRY_NAME = "mimetype";
const textDecoder = new TextDecoder();

function hasExtension(name: string, extension: string): boolean {
  return name.toLowerCase().endsWith(extension);
}

function isXhtmlName(name: string): boolean {
  return XHTML_EXTENSIONS.some((extension) => hasExtension(name, extension));
}

// Remove the `toc` attribute from the spine's opening tag. whetstone derives chapter order from
// the spine itemrefs alone, so dropping the reference makes the parser skip NCX parsing (and its
// navMap assumption) with no effect on what we ingest.
function stripSpineToc(opf: string): string {
  return opf.replace(/(<spine\b[^>]*?)\s+toc\s*=\s*("[^"]*"|'[^']*')/i, "$1");
}

// Whether a `<link>` tag is a stylesheet reference (either `rel="stylesheet"` or a `.css` href),
// the only kind whose absence crashes the parser and the only kind v0 has no use for.
function isStylesheetLink(tag: string): boolean {
  if (/\brel\s*=\s*("[^"]*\bstylesheet\b[^"]*"|'[^']*\bstylesheet\b[^']*')/i.test(tag)) {
    return true;
  }

  return /\bhref\s*=\s*("[^"]*\.css[^"]*"|'[^']*\.css[^']*')/i.test(tag);
}

function stripStylesheetLinks(html: string): string {
  return html.replace(/<link\b[^>]*>/gi, (tag) => (isStylesheetLink(tag) ? "" : tag));
}

function zippableEntry(name: string, content: Uint8Array): ZippableFile {
  // The EPUB `mimetype` entry must stay stored (uncompressed); everything else re-deflates.
  if (name === MIMETYPE_ENTRY_NAME) {
    return [content, { level: 0 }];
  }

  return content;
}

export function sanitizeEpubBytes(bytes: Uint8Array): Uint8Array {
  let files: Unzipped;

  try {
    files = unzipSync(bytes);
  } catch {
    // Not fflate-decodable (e.g. an unsupported or corrupt archive); leave it to the parser,
    // whose failure the caller maps to `invalid_epub`.
    return bytes;
  }

  let mutated = false;
  const next: Zippable = {};

  for (const [name, content] of Object.entries(files)) {
    let entryBytes = content;

    if (hasExtension(name, ".opf")) {
      const opf = textDecoder.decode(content);
      const stripped = stripSpineToc(opf);

      if (stripped !== opf) {
        entryBytes = strToU8(stripped);
        mutated = true;
      }
    } else if (isXhtmlName(name)) {
      const html = textDecoder.decode(content);
      const stripped = stripStylesheetLinks(html);

      if (stripped !== html) {
        entryBytes = strToU8(stripped);
        mutated = true;
      }
    }

    next[name] = zippableEntry(name, entryBytes);
  }

  if (!mutated) {
    return bytes;
  }

  return zipSync(next);
}

// A debug-level sink for expected, recoverable ingestion events (a declared resource skipped). Kept
// as an injected callback so this pure boundary reaches no global logger; the server wires it to its
// logger at construction. `event` is a stable key; `fields` are safe, structured context (a resource
// path — never content). See GUIDELINES logging rules ("expected validation failures — log at debug").
export type EpubParserDebugLog = (event: string, fields: Record<string, unknown>) => void;

export function createEpubParser(
  resourceSaveDir: string,
  logDebug: EpubParserDebugLog
): EpubParser {
  return async function parseEpub(bytes: Uint8Array): Promise<ParsedEpub> {
    // The EPUB library hangs and emits a process-crashing unhandled rejection on non-ZIP input
    // (e.g. a non-EPUB file uploaded with a `.epub` extension), so reject those here — a settled
    // rejection the caller turns into an "invalid EPUB" response — before it ever runs.
    if (!isZipArchive(bytes)) {
      throw new Error("The upload is not a ZIP archive, so it cannot be a valid EPUB.");
    }

    await mkdir(resourceSaveDir, { recursive: true });

    // A valid ZIP that is not a valid EPUB (missing container.xml/OPF, corrupt structure) makes the
    // third-party parser throw an internal, cryptic error. Wrap it so any such failure settles as a
    // single, clear rejection the ingest command maps to "invalid EPUB" — mirroring the non-ZIP
    // guard's intent — instead of leaking the library's internals.
    let epub: Awaited<ReturnType<typeof initEpubFile>>;
    try {
      epub = await initEpubFile(sanitizeEpubBytes(bytes), resourceSaveDir);
    } catch (cause) {
      throw new Error("The upload could not be parsed as a valid EPUB.", { cause });
    }

    try {
      const metadata = normalizeEpubMetadata(epub.getMetadata());
      const manifest = epub.getManifest();
      const mediaTypes = mediaTypeBySavedPath(manifest, resourceSaveDir);
      const chapters: ParsedEpubChapter[] = [];

      for (const item of epub.getSpine()) {
        if (item.linear === "no") {
          continue;
        }

        const chapter = await epub.loadChapter(item.id);
        chapters.push({
          html: chapter.html,
          images: await extractChapterImages(chapter.html, mediaTypes, (src) =>
            logDebug("epub_resource_skipped", { src })
          ),
          sourceFile: item.href
        });
      }

      // The authored nav is read while the parser's saved resources are still on disk (they persist
      // past `destroy()`, but reading here keeps the on-disk contract local). Fail-soft: `undefined`
      // when the EPUB has no nav resource or it could not be read/decoded (#379).
      const nav = await readNavDocument(manifest, resourceSaveDir);

      return Object.freeze({ chapters, metadata, ...(nav === undefined ? {} : { nav }) });
    } finally {
      epub.destroy();
    }
  };
}
