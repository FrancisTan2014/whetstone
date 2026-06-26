import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createEpubParser } from "./epubSource.js";

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
});
