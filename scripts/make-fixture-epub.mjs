// Generates the small English-language public-domain EPUB fixture used by the screenshot
// harness (`scripts/screenshots.mjs`). The text is Aesop's "The North Wind and the Sun"
// and "The Ant and the Grasshopper" — ancient fables that are unambiguously in the public
// domain. Re-run with `node scripts/make-fixture-epub.mjs` to regenerate the committed file;
// the output is deterministic. fflate is already a repo devDependency.

import { strToU8, zipSync } from "fflate";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outPath = path.join(root, "fixtures", "epub", "aesop-fables.epub");

const title = "Aesop's Fables (Selections)";
const author = "Aesop";

const container = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">urn:uuid:whetstone-fixture-aesop</dc:identifier>
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

const nav = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head>
<body><nav epub:type="toc"><ol>
<li><a href="chap1.xhtml">The North Wind and the Sun</a></li>
<li><a href="chap2.xhtml">The Ant and the Grasshopper</a></li>
</ol></nav></body></html>`;

function chapter(heading, paragraphs) {
  const body = paragraphs.map((p) => `<p>${p}</p>`).join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${heading}</title></head>
<body><h1>${heading}</h1>
${body}
</body></html>`;
}

const chap1 = chapter("The North Wind and the Sun", [
  "The North Wind and the Sun disputed as to which was the most powerful, and agreed that he should be declared the victor who could first strip a wayfaring man of his clothes.",
  "The North Wind first tried his might and blew with all his force, but the keener his blasts, the closer the Traveler wrapped his cloak around him, until at last, resigning all hope of victory, the Wind called upon the Sun to see what he could do.",
  "The Sun suddenly shone out with all his warmth. The Traveler no sooner felt his genial rays than he took off one garment after another, and at last, fairly overcome with heat, undressed and bathed in a stream that lay in his path.",
  "Persuasion is better than force."
]);

const chap2 = chapter("The Ant and the Grasshopper", [
  "In a field one summer's day a Grasshopper was hopping about, chirping and singing to its heart's content. An Ant passed by, bearing along with great toil an ear of corn he was taking to the nest.",
  "Why not come and chat with me, said the Grasshopper, instead of toiling and moiling in that way? I am helping to lay up food for the winter, said the Ant, and recommend you to do the same.",
  "When the winter came the Grasshopper had no food, and found itself dying of hunger, while it saw the ants distributing every day corn from the stores they had collected in the summer.",
  "It is best to prepare for the days of necessity."
]);

const bytes = zipSync({
  // The mimetype entry must be first and stored (uncompressed) per the EPUB OCF spec.
  mimetype: [strToU8("application/epub+zip"), { level: 0 }],
  "META-INF/container.xml": strToU8(container),
  "OEBPS/content.opf": strToU8(opf),
  "OEBPS/nav.xhtml": strToU8(nav),
  "OEBPS/chap1.xhtml": strToU8(chap1),
  "OEBPS/chap2.xhtml": strToU8(chap2)
});

mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, bytes);
console.log(`Wrote ${outPath} (${bytes.length} bytes)`);
