import { initEpubFile } from "@lingo-reader/epub-parser";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createEpubParser, sanitizeEpubBytes } from "./epubSource.js";

let imagesDir: string;

const container = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:test-123</dc:identifier>
    <dc:title>史记选读</dc:title>
    <dc:creator>司马迁</dc:creator>
    <dc:language>zh</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>
    <item id="c1" href="chap1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="chap2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="cover" linear="no"/>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
  </spine>
</package>`;

const nav = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>
<nav epub:type="toc"><ol><li><a href="chap1.xhtml">One</a></li></ol></nav>
</body></html>`;

function chapter(title: string, body: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head><body>${body}</body></html>`;
}

function buildEpubBytes(): Uint8Array {
  return zipSync({
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": strToU8(container),
    "OEBPS/content.opf": strToU8(opf),
    "OEBPS/nav.xhtml": strToU8(nav),
    "OEBPS/cover.xhtml": strToU8(chapter("Cover", "<p>cover</p>")),
    "OEBPS/chap1.xhtml": strToU8(chapter("One", "<h1>Chapter One</h1><p>Hello.</p>")),
    "OEBPS/chap2.xhtml": strToU8(chapter("Two", "<h1>五帝本纪</h1><p>黄帝者。</p>"))
  });
}

// A 1×1 PNG, decoded from base64, used as a real raster image inside the in-test EPUB.
function pngBytes(): Uint8Array {
  return Uint8Array.from(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=",
      "base64"
    )
  );
}

const imageOpf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:image-1</dc:identifier>
    <dc:title>Illustrated</dc:title>
    <dc:creator>Anon</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="c1" href="chap1.xhtml" media-type="application/xhtml+xml"/>
    <item id="pixel" href="images/pixel.png" media-type="image/png"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
  </spine>
</package>`;

// One chapter referencing a manifest PNG and a stray `<img>` with no manifest entry.
function buildImageEpubBytes(png: Uint8Array): Uint8Array {
  const body =
    "<h1>Plate</h1><p>See below.</p>" +
    '<img src="images/pixel.png" alt="dot"/>' +
    '<img src="missing.png" alt="gone"/>';

  return zipSync({
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": strToU8(container),
    "OEBPS/content.opf": strToU8(imageOpf),
    "OEBPS/chap1.xhtml": strToU8(chapter("Plate", body)),
    "OEBPS/images/pixel.png": png
  });
}

// An EPUB3 that ships only `nav.xhtml` (no legacy `.ncx`) but whose spine still carries a `toc`
// reference pointing at that nav document. @lingo-reader/epub-parser@0.4.6 reads `ncx.navMap`
// unconditionally on that resource — which parses to an `<html>`, not an `<ncx>` — and crashes
// with `Cannot read properties of undefined (reading 'navMap')` (issue #359, repro 1).
const navOnlyOpf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:nav-only-1</dc:identifier>
    <dc:title>Master TypeScript</dc:title>
    <dc:creator>Anon</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="chap1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="chap2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="nav">
    <itemref idref="c1"/>
    <itemref idref="c2"/>
  </spine>
</package>`;

function buildNavOnlyEpubBytes(): Uint8Array {
  return zipSync({
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": strToU8(container),
    "OEBPS/content.opf": strToU8(navOnlyOpf),
    "OEBPS/nav.xhtml": strToU8(nav),
    "OEBPS/chap1.xhtml": strToU8(chapter("One", "<h1>Chapter One</h1><p>Types.</p>")),
    "OEBPS/chap2.xhtml": strToU8(chapter("Two", "<h1>Generics</h1><p>More.</p>"))
  });
}

const missingCssOpf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:missing-css-1</dc:identifier>
    <dc:title>C++ Templates</dc:title>
    <dc:creator>Anon</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="c1" href="chap1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
  </spine>
</package>`;

// A chapter whose head references stylesheets that are not shipped in the archive: one via
// `rel="stylesheet"`, one via a `.css` href with no rel — both of which the parser tries to
// `readFileSync` and dies with ENOENT (issue #359, repro 2). A non-stylesheet `<link>` (an icon)
// sits alongside to prove only stylesheet links are removed.
function missingCssChapter(): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Ch</title>
<link rel="stylesheet" type="text/css" href="missing.css"/>
<link href="theme.css"/>
<link rel="icon" href="favicon.ico"/>
</head><body><h1>Templates</h1><p>Body.</p></body></html>`;
}

function buildMissingCssEpubBytes(): Uint8Array {
  return zipSync({
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": strToU8(container),
    "OEBPS/content.opf": strToU8(missingCssOpf),
    "OEBPS/chap1.xhtml": strToU8(missingCssChapter())
  });
}

beforeEach(async () => {
  imagesDir = await mkdtemp(join(tmpdir(), "whetstone-epub-img-"));
});

afterEach(async () => {
  await rm(imagesDir, { force: true, recursive: true });
});

describe("createEpubParser", () => {
  it("extracts normalized metadata and ordered linear chapters from real EPUB bytes", async () => {
    const parse = createEpubParser(imagesDir);

    const parsed = await parse(buildEpubBytes());

    expect(parsed.metadata).toEqual({ author: "司马迁", language: "zh-CN", title: "史记选读" });
    expect(parsed.chapters).toHaveLength(2);
    expect(parsed.chapters[0]?.html).toContain("Chapter One");
    expect(parsed.chapters[1]?.html).toContain("五帝本纪");
  });

  it("surfaces no images for chapters that reference none", async () => {
    const parse = createEpubParser(imagesDir);

    const parsed = await parse(buildEpubBytes());

    expect(parsed.chapters.map((chapter) => chapter.images)).toEqual([[], []]);
  });

  it("surfaces a chapter's image with its rewritten src, bytes, and manifest media type", async () => {
    const png = pngBytes();
    const parse = createEpubParser(imagesDir);

    const parsed = await parse(buildImageEpubBytes(png));

    // The chapter references two images: a manifest PNG and an `<img>` with no manifest
    // entry. Only the manifest resource — whose declared media type is known — surfaces.
    const chapter = parsed.chapters[0];
    expect(chapter?.images).toHaveLength(1);
    const image = chapter?.images[0];
    expect(image?.contentType).toBe("image/png");
    expect(Buffer.from(image?.bytes ?? new Uint8Array()).equals(Buffer.from(png))).toBe(true);
    // `src` is exactly the rewritten path emitted into the chapter HTML.
    expect(image?.src).toBe(resolve(imagesDir, "OEBPS_images_pixel.png"));
    expect(chapter?.html).toContain(image?.src ?? "");
  });

  it("rejects non-ZIP bytes with a settled error instead of hanging or crashing", async () => {
    const parse = createEpubParser(imagesDir);
    // A non-EPUB file uploaded with a .epub extension. The underlying library would otherwise leave
    // its promise unsettled and emit a process-crashing unhandled rejection; the parser must turn it
    // into a normal rejection the ingest command can map to "invalid EPUB".
    const notAnEpub = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

    await expect(parse(notAnEpub)).rejects.toThrow("not a ZIP archive");
  });

  it("ingests a nav-only EPUB3 whose spine toc points at a non-NCX resource (#359)", async () => {
    const navOnly = buildNavOnlyEpubBytes();

    // The raw parser crashes on these exact bytes: it reads `navMap` off the nav document as if it
    // were an NCX. This proves the sanitizer is load-bearing, not decorative.
    const rawDir = await mkdtemp(join(tmpdir(), "whetstone-epub-raw-"));
    try {
      await expect(initEpubFile(navOnly, rawDir)).rejects.toThrow(/navMap/);
    } finally {
      await rm(rawDir, { force: true, recursive: true });
    }

    const parsed = await createEpubParser(imagesDir)(navOnly);

    // Chapters come from the spine, in order — the NCX is never needed.
    expect(parsed.metadata).toEqual({ author: "Anon", language: "en", title: "Master TypeScript" });
    expect(parsed.chapters).toHaveLength(2);
    expect(parsed.chapters[0]?.html).toContain("Chapter One");
    expect(parsed.chapters[1]?.html).toContain("Generics");
  });

  it("ingests an EPUB whose chapter links a missing stylesheet, skipping it (#359)", async () => {
    const missingCss = buildMissingCssEpubBytes();

    // The raw parser dies with ENOENT trying to read the absent stylesheet while loading the chapter.
    const rawDir = await mkdtemp(join(tmpdir(), "whetstone-epub-raw-"));
    try {
      const rawEpub = await initEpubFile(missingCss, rawDir);
      await expect(rawEpub.loadChapter(rawEpub.getSpine()[0]?.id ?? "")).rejects.toThrow(/ENOENT/);
      rawEpub.destroy();
    } finally {
      await rm(rawDir, { force: true, recursive: true });
    }

    const parsed = await createEpubParser(imagesDir)(missingCss);

    expect(parsed.chapters).toHaveLength(1);
    expect(parsed.chapters[0]?.html).toContain("Templates");
  });

  it("leaves non-ZIP-decodable archives to the parser to reject", () => {
    // A structurally valid ZIP (so `isZipArchive` accepts it) whose compression method fflate
    // cannot inflate. The sanitizer must fall back to the exact original bytes rather than throw,
    // leaving the parser to reject the archive (tested directly to avoid the third-party parser's
    // process-level unhandled rejection on such input).
    const archive = zipSync({ "a.txt": strToU8("content content content") });
    for (let i = 0; i < archive.length - 4; i += 1) {
      if (archive[i] === 0x50 && archive[i + 1] === 0x4b && archive[i + 2] === 0x03) {
        archive[i + 8] = 99;
      }
      if (archive[i] === 0x50 && archive[i + 1] === 0x4b && archive[i + 2] === 0x01) {
        archive[i + 10] = 99;
      }
    }

    expect(sanitizeEpubBytes(archive)).toBe(archive);
  });
});

describe("sanitizeEpubBytes", () => {
  it("returns the original bytes unchanged when nothing needs stripping", () => {
    const bytes = buildEpubBytes();

    expect(sanitizeEpubBytes(bytes)).toBe(bytes);
  });

  it("rewrites the archive when it strips a spine toc reference", () => {
    const bytes = buildNavOnlyEpubBytes();

    expect(sanitizeEpubBytes(bytes)).not.toBe(bytes);
  });

  it("rewrites the archive when it strips missing stylesheet links", () => {
    const bytes = buildMissingCssEpubBytes();

    expect(sanitizeEpubBytes(bytes)).not.toBe(bytes);
  });
});
