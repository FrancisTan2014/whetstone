import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

    expect(parsed.metadata).toEqual({ author: "司马迁", language: "zh", title: "史记选读" });
    expect(parsed.chapters).toHaveLength(2);
    expect(parsed.chapters[0]?.html).toContain("Chapter One");
    expect(parsed.chapters[1]?.html).toContain("五帝本纪");
  });
});
