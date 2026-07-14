// Generates the small English-language public-domain EPUB fixture the Today daily-cycle E2E
// (`e2e/tests/today-daily-cycle.spec.ts`) adopts as its OWN recitation Work. It must have distinct
// bytes (a different sha256) from the shared `aesop-fables.epub` (`e2e/stack.ts`'s `setup.epub`), which
// the passages spec already adopts — otherwise EPUB upload dedupes to the same Work and the two plans
// collide. The text is Aesop's "The Fox and the Grapes" and "The Lion and the Mouse" — ancient fables
// unambiguously in the public domain. Re-run with `node scripts/make-today-fixture-epub.mjs`; the output
// is deterministic. fflate is already a repo devDependency.

import { strToU8, zipSync } from "fflate";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outPath = path.join(root, "fixtures", "epub", "today-cycle.epub");

const title = "Aesop's Fables (Today Cycle)";
const author = "Aesop";

const container = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">urn:uuid:whetstone-fixture-today-cycle</dc:identifier>
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
<li><a href="chap1.xhtml">The Fox and the Grapes</a></li>
<li><a href="chap2.xhtml">The Lion and the Mouse</a></li>
</ol></nav></body></html>`;

function chapter(heading, paragraphs) {
  const body = paragraphs.map((p) => `<p>${p}</p>`).join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${heading}</title></head>
<body><h1>${heading}</h1>
${body}
</body></html>`;
}

const chap1 = chapter("The Fox and the Grapes", [
  "One hot summer's day a Fox was strolling through an orchard till he came to a bunch of grapes just ripening on a vine which had been trained over a lofty branch.",
  "Just the thing to quench my thirst, said he. Drawing back a few paces, he took a run and a jump, and just missed the bunch.",
  "Turning round again with a One, Two, Three, he jumped up, but with no greater success. Again and again he tried after the tempting morsel, but at last had to give it up, and walked away with his nose in the air.",
  "It is easy to despise what you cannot get."
]);

const chap2 = chapter("The Lion and the Mouse", [
  "Once when a Lion was asleep a little Mouse began running up and down upon him. This soon wakened the Lion, who placed his huge paw upon him and opened his big jaws to swallow him.",
  "Pardon, O King, cried the little Mouse, forgive me this time. I shall never forget it. Who knows but what I may be able to do you a turn some of these days?",
  "The Lion was so tickled at the idea of the Mouse being able to help him that he lifted up his paw and let him go. Some time after, the Lion was caught in a trap, and the hunters bound him to a tree while they went in search of a wagon to carry him on.",
  "Little friends may prove great friends."
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
