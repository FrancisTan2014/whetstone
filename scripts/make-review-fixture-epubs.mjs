// Generates the two small public-domain EPUB fixtures the EPUB creation-review E2E
// (`e2e/tests/work-creation-review-epub.spec.ts`) adopts as one imported Work plus a look-alike
// second EDITION. Both carry the SAME title + author but DIFFERENT chapter bytes (a different
// sha256), so the second upload trips the exact title-key candidate and opens the shared duplicate
// -review panel (#748) instead of an exact reopen. Each edition also carries authored navigation
// (a `nav.xhtml` TOC over two chapters) and a figure image, so the E2E can prove the "Keep separate"
// edition commits its navigation and images intact. The text is more of Aesop's fables,
// unambiguously in the public domain. Re-run with `node scripts/make-review-fixture-epubs.mjs`; the
// output is deterministic. fflate is a devDependency.

import { strToU8, zipSync } from "fflate";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// A tiny, valid 1x1 PNG. The figure resolver stores raster images as-is once the OPF manifest
// media-type is allowlisted (`image/png`), so a minimal-but-real PNG is enough to prove the image
// survives the Keep-separate commit and renders in the reader.
const pngBytes = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgAB4iG8MwAAAABJRU5ErkJggg==",
    "base64"
  )
);

function container() {
  return `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;
}

function opf(identifier, title, author) {
  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">${identifier}</dc:identifier>
    <dc:title>${title}</dc:title>
    <dc:creator>${author}</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="plate" href="images/plate.png" media-type="image/png"/>
    <item id="c1" href="chap1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="chap2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
  </spine>
</package>`;
}

function nav(entries) {
  const items = entries.map((e) => `<li><a href="${e.href}">${e.heading}</a></li>`).join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head>
<body><nav epub:type="toc"><ol>
${items}
</ol></nav></body></html>`;
}

// The first chapter carries an authored figure (image + caption) so the E2E can prove the image
// commits and renders; the remaining chapters are text-only.
function chapter(heading, paragraphs, figure) {
  const figureHtml =
    figure === undefined
      ? ""
      : `<figure><img src="images/plate.png" alt="${figure.alt}"/><figcaption>${figure.caption}</figcaption></figure>\n`;
  const body = paragraphs.map((p) => `<p>${p}</p>`).join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${heading}</title></head>
<body><h1>${heading}</h1>
${figureHtml}${body}
</body></html>`;
}

function writeEpub(fileName, identifier, title, author, chapters) {
  const outPath = path.join(root, "fixtures", "epub", fileName);
  const bytes = zipSync({
    // The mimetype entry must be first and stored (uncompressed) per the EPUB OCF spec.
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": strToU8(container()),
    "OEBPS/content.opf": strToU8(opf(identifier, title, author)),
    "OEBPS/nav.xhtml": strToU8(
      nav(chapters.map((c, index) => ({ heading: c.heading, href: `chap${index + 1}.xhtml` })))
    ),
    "OEBPS/images/plate.png": pngBytes,
    ...Object.fromEntries(
      chapters.map((c, index) => [
        `OEBPS/chap${index + 1}.xhtml`,
        strToU8(chapter(c.heading, c.paragraphs, c.figure))
      ])
    )
  });
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, bytes);
  console.log(`Wrote ${outPath} (${bytes.length} bytes)`);
}

const REVIEW_TITLE = "The Fox Fables — Illustrated Review (748)";
const REVIEW_AUTHOR = "Aesop";

writeEpub(
  "illustrated-review-edition-a.epub",
  "urn:uuid:whetstone-fixture-illustrated-review-a",
  REVIEW_TITLE,
  REVIEW_AUTHOR,
  [
    {
      heading: "The Fox and the Grapes",
      figure: { alt: "First-edition frontispiece", caption: "Frontispiece of the first edition." },
      paragraphs: [
        "A Fox one day spied a beautiful bunch of ripe grapes hanging from a vine trained along the branches of a tree.",
        "The grapes seemed ready to burst with juice, and the Fox's mouth watered as he gazed longingly at them.",
        "The bunch hung from a high branch, and the Fox had to jump for it. The first time he jumped he missed it by a long way.",
        "So he walked off, turning up his nose and saying, They are probably sour anyway. It is easy to despise what you cannot get."
      ]
    },
    {
      heading: "The Fox and the Stork",
      paragraphs: [
        "The Fox one day invited the Stork to dinner and served the meal on a broad flat dish that the Stork could not touch with her long bill.",
        "The Fox lapped up the soup easily, while the hungry Stork could get nothing.",
        "Not long after, the Stork invited the Fox and served the meal in a tall jar with a narrow neck, into which she could easily thrust her bill.",
        "The Fox, unable to reach the food, went home hungry. He was well served by the trick he had played on his guest."
      ]
    }
  ]
);

writeEpub(
  "illustrated-review-edition-b.epub",
  "urn:uuid:whetstone-fixture-illustrated-review-b",
  REVIEW_TITLE,
  REVIEW_AUTHOR,
  [
    {
      heading: "The Fox and the Crow",
      figure: { alt: "Second-edition plate", caption: "Plate added for the second edition." },
      paragraphs: [
        "A Crow, having stolen a piece of cheese from a cottage window, flew up into a high tree to enjoy her prize.",
        "A Fox, spying the dainty morsel, thought to himself, I will have that cheese, and he sat below the tree and began to flatter the Crow.",
        "How handsome you are, said the Fox, and if your voice is as sweet as your feathers are fine, you must be the queen of birds.",
        "The Crow, wishing to prove her voice, opened her beak to caw, and down dropped the cheese, which the Fox snapped up. Do not trust flatterers."
      ]
    },
    {
      heading: "The Fox and the Lion",
      paragraphs: [
        "When a Fox who had never seen a Lion met one for the first time in the forest he was so terrified that he nearly died of fright.",
        "On meeting the Lion for the second time he was still much alarmed, but not nearly so much as before.",
        "The third time he saw the Lion he was so far from being afraid that he went up to him and began a familiar conversation.",
        "Familiarity, we see, may breed contempt, and even the most fearful things lose their terror when we grow used to them."
      ]
    }
  ]
);
