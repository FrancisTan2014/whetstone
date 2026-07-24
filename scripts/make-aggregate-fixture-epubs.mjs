// Generates the two small public-domain EPUB fixtures the recitation aggregate E2E
// (`e2e/tests/recitation-review-continuation.spec.ts`) adopts as two SEPARATE recitation Works. Each must
// be distinct from every other fixture and from each other along TWO axes, or the shared-user shelf
// collapses them:
//   1. Distinct bytes (a different sha256), so an exact-hash re-upload never reopens the wrong Work.
//   2. Distinct TITLE + AUTHOR metadata, so the #724/#748 duplicate-review boundary — through which EPUB
//      upload now routes — does not flag one as a look-alike edition of the other (or of the seeded
//      `aesop-fables.epub`) and park it for review instead of creating it. The old fixtures shared the
//      author "Aesop" and titles differing by a single character ("(Aggregate A)" vs "(Aggregate B)"),
//      which scored ~0.96 same-author title similarity and parked the second upload. These two are now
//      unrelated works by different authors with well-separated titles.
// The text is public-domain Aesop's fables. Re-run with `node scripts/make-aggregate-fixture-epubs.mjs`;
// the output is deterministic. fflate is a devDependency.

import { strToU8, zipSync } from "fflate";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

function chapter(heading, paragraphs) {
  const body = paragraphs.map((p) => `<p>${p}</p>`).join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${heading}</title></head>
<body><h1>${heading}</h1>
${body}
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
    ...Object.fromEntries(
      chapters.map((c, index) => [
        `OEBPS/chap${index + 1}.xhtml`,
        strToU8(chapter(c.heading, c.paragraphs))
      ])
    )
  });
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, bytes);
  console.log(`Wrote ${outPath} (${bytes.length} bytes)`);
}

writeEpub(
  "recitation-aggregate-a.epub",
  "urn:uuid:whetstone-fixture-recitation-aggregate-a",
  "The Ant and the Crow (Recitation Set A)",
  "Odell Faber",
  [
    {
      heading: "The Ant and the Grasshopper",
      paragraphs: [
        "In a field one summer's day a Grasshopper was hopping about, chirping and singing to its heart's content.",
        "An Ant passed by, bearing along with great toil an ear of corn he was taking to the nest.",
        "Why not come and chat with me, said the Grasshopper, instead of toiling and moiling in that way?",
        "I am helping to lay up food for the winter, said the Ant, and recommend you to do the same."
      ]
    },
    {
      heading: "The Crow and the Pitcher",
      paragraphs: [
        "A Crow, half dead with thirst, came upon a Pitcher which had once been full of water.",
        "But when the Crow put its beak into the mouth of the Pitcher it found that only very little water was left in it.",
        "Then he took a pebble and dropped it into the Pitcher. Then he took another pebble and dropped it in.",
        "At last, at last, he saw the water mount up near him, and after casting in a few more pebbles he was able to quench his thirst."
      ]
    }
  ]
);

writeEpub(
  "recitation-aggregate-b.epub",
  "urn:uuid:whetstone-fixture-recitation-aggregate-b",
  "The Tortoise and the Wind (Recitation Set B)",
  "Priya Marlow",
  [
    {
      heading: "The Tortoise and the Hare",
      paragraphs: [
        "The Hare was once boasting of his speed before the other animals. I have never yet been beaten, said he, when I put forth my full speed.",
        "The Tortoise said quietly, I accept your challenge. That is a good joke, said the Hare; I could dance round you all the way.",
        "The Fox marked out the course, and the two started. The Hare darted almost out of sight at once, then lay down to have a nap.",
        "The Tortoise plodded on and plodded on, and when the Hare awoke from his nap he saw the Tortoise nearing the winning post, and could not catch up in time to save the race. Plodding wins the race."
      ]
    },
    {
      heading: "The North Wind and the Sun",
      paragraphs: [
        "The North Wind and the Sun disputed as to which was the more powerful, and agreed that he should be declared the victor who could first strip a wayfaring man of his clothes.",
        "The North Wind first tried his might and blew with all his main, but the keener his blasts, the closer the Traveller wrapped his cloak around him.",
        "Then the Sun began to shine. At first his beams were gentle, and the Traveller unclasped his cloak. The Sun's rays waxed warmer and warmer.",
        "The man, overcome with the heat, took off his cloak and sat down in the shade. Persuasion is better than force."
      ]
    }
  ]
);
