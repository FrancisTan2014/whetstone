import { describe, expect, it } from "vitest";

import { parseNavDocument, selectNavResource, type NavEntry } from "./epubNav.js";

// --- EPUB3 nav.xhtml fixtures -------------------------------------------------------------------

// A ≥3-level toc (Part › Chapter › Section) that also exercises the non-obvious rules inline:
// - the first Part label has collapsible inner whitespace and surrounding padding (normalization),
// - a structural wrapper `<li>` with no `<a>` but a nested `<ol>` (its children are hoisted),
// - an `<a>` with no `href` (kept because it still has a label; href becomes ""),
// - a truly empty `<li>` (no label, no href, no children — contributes nothing).
const threeLevelNav = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <body>
    <nav epub:type="toc">
      <ol>
        <li><a href="part1.html">  Part
          One  </a>
          <ol>
            <li><a href="ch01.html">Chapter 1</a>
              <ol>
                <li><a href="ch01.html#sec-intro">Section 1.1</a></li>
                <li><a href="ch01.html#sec-more">Section 1.2</a></li>
              </ol>
            </li>
            <li><a href="ch02.html">Chapter 2</a></li>
          </ol>
        </li>
        <li>
          <ol>
            <li><a href="hoisted.html">Hoisted Chapter</a></li>
          </ol>
        </li>
        <li><a>Label Without Href</a></li>
        <li></li>
        <li><a href="part2.html">Part Two</a></li>
      </ol>
    </nav>
  </body>
</html>`;

// An untyped `<nav>` (no epub:type) that still contains an `<ol>`: the fallback picks the first nav
// with a list. A second untyped nav without a list is ignored.
const fallbackNav = `<html><body>
  <nav>just some prose, no list</nav>
  <nav>
    <ol><li><a href="only.html">Only</a></li></ol>
  </nav>
</body></html>`;

// --- EPUB2 toc.ncx fixtures ---------------------------------------------------------------------

// A nested navMap whose navPoints are authored OUT of document order but carry playOrder, at BOTH
// levels, to prove numeric sorting. Also exercises normalization on a padded label.
const playOrderNcx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="np2" playOrder="2">
      <navLabel><text>Second</text></navLabel>
      <content src="ch02.html"/>
    </navPoint>
    <navPoint id="np1" playOrder="1">
      <navLabel><text>  First
        Chapter  </text></navLabel>
      <content src="ch01.html"/>
      <navPoint id="np1b" playOrder="4">
        <navLabel><text>First-B</text></navLabel>
        <content src="ch01.html#b"/>
      </navPoint>
      <navPoint id="np1a" playOrder="3">
        <navLabel><text>First-A</text></navLabel>
        <content src="ch01.html#a"/>
      </navPoint>
    </navPoint>
  </navMap>
</ncx>`;

// Two navPoints sharing the same playOrder: the numeric sort is stable, so document order breaks the
// tie (Alpha before Beta).
const tiedPlayOrderNcx = `<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/">
  <navMap>
    <navPoint playOrder="5"><navLabel><text>Alpha</text></navLabel><content src="a.html"/></navPoint>
    <navPoint playOrder="5"><navLabel><text>Beta</text></navLabel><content src="b.html"/></navPoint>
  </navMap>
</ncx>`;

// A navMap where playOrder is absent, empty, or non-numeric: because not every sibling has a valid
// playOrder, document order is preserved verbatim. Also covers a structural wrapper navPoint (no label
// and no href, but nested children that are hoisted) and a truly empty navPoint (dropped).
const documentOrderNcx = `<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/">
  <navMap>
    <navPoint><navLabel><text>Beta</text></navLabel><content src="b.html"/></navPoint>
    <navPoint playOrder=""><navLabel><text>Alpha</text></navLabel><content src="a.html"/></navPoint>
    <navPoint playOrder="1.5"><navLabel><text>Gamma</text></navLabel><content src="g.html"/></navPoint>
    <navPoint>
      <navPoint><navLabel><text>Hoisted</text></navLabel><content src="h.html"/></navPoint>
    </navPoint>
    <navPoint></navPoint>
  </navMap>
</ncx>`;

// A navPoint whose navLabel has no <text> child, and one with no <content> src, to exercise the
// missing-piece branches. The first keeps its href (label ""), the second keeps its label (href "").
const partialNcx = `<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/">
  <navMap>
    <navPoint><navLabel></navLabel><content src="labelless.html"/></navPoint>
    <navPoint><navLabel><text>No Src</text></navLabel><content/></navPoint>
  </navMap>
</ncx>`;

describe("parseNavDocument — xhtml-nav", () => {
  it("builds a depth- and order-preserving tree with normalized labels and raw hrefs", () => {
    const expected: NavEntry[] = [
      {
        label: "Part One",
        href: "part1.html",
        children: [
          {
            label: "Chapter 1",
            href: "ch01.html",
            children: [
              { label: "Section 1.1", href: "ch01.html#sec-intro", children: [] },
              { label: "Section 1.2", href: "ch01.html#sec-more", children: [] }
            ]
          },
          { label: "Chapter 2", href: "ch02.html", children: [] }
        ]
      },
      { label: "Hoisted Chapter", href: "hoisted.html", children: [] },
      { label: "Label Without Href", href: "", children: [] },
      { label: "Part Two", href: "part2.html", children: [] }
    ];

    expect(parseNavDocument(threeLevelNav, "xhtml-nav")).toEqual(expected);
  });

  it("falls back to the first <nav> containing an <ol> when none is typed toc", () => {
    expect(parseNavDocument(fallbackNav, "xhtml-nav")).toEqual([
      { label: "Only", href: "only.html", children: [] }
    ]);
  });

  it("returns [] for a typed toc nav that has no list", () => {
    const noList = `<html><body><nav epub:type="toc">no list here</nav></body></html>`;
    expect(parseNavDocument(noList, "xhtml-nav")).toEqual([]);
  });

  it("returns [] when there is a <nav> but none is toc and none has a list", () => {
    const noToc = `<html><body><nav>prose only</nav></body></html>`;
    expect(parseNavDocument(noToc, "xhtml-nav")).toEqual([]);
  });

  it("returns [] for missing, empty, garbage, and wrong-root sources without throwing", () => {
    expect(parseNavDocument("", "xhtml-nav")).toEqual([]);
    expect(parseNavDocument("   ", "xhtml-nav")).toEqual([]);
    expect(parseNavDocument("not markup at all {}{}", "xhtml-nav")).toEqual([]);
    expect(parseNavDocument("<html><body><p>no nav</p></body></html>", "xhtml-nav")).toEqual([]);
    expect(parseNavDocument("<nav><ol><li>", "xhtml-nav")).toEqual([]);
  });

  it("freezes the returned tree", () => {
    const result = parseNavDocument(threeLevelNav, "xhtml-nav");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result[0])).toBe(true);
    expect(Object.isFrozen(result[0]?.children)).toBe(true);
  });
});

describe("parseNavDocument — ncx", () => {
  it("orders nested navPoints by numeric playOrder at every level with normalized labels", () => {
    expect(parseNavDocument(playOrderNcx, "ncx")).toEqual([
      {
        label: "First Chapter",
        href: "ch01.html",
        children: [
          { label: "First-A", href: "ch01.html#a", children: [] },
          { label: "First-B", href: "ch01.html#b", children: [] }
        ]
      },
      { label: "Second", href: "ch02.html", children: [] }
    ]);
  });

  it("keeps document order to break equal-playOrder ties", () => {
    expect(parseNavDocument(tiedPlayOrderNcx, "ncx")).toEqual([
      { label: "Alpha", href: "a.html", children: [] },
      { label: "Beta", href: "b.html", children: [] }
    ]);
  });

  it("preserves document order when playOrder is absent, empty, or non-integer, hoisting wrappers", () => {
    expect(parseNavDocument(documentOrderNcx, "ncx")).toEqual([
      { label: "Beta", href: "b.html", children: [] },
      { label: "Alpha", href: "a.html", children: [] },
      { label: "Gamma", href: "g.html", children: [] },
      { label: "Hoisted", href: "h.html", children: [] }
    ]);
  });

  it("keeps entries missing only a label or only an href", () => {
    expect(parseNavDocument(partialNcx, "ncx")).toEqual([
      { label: "", href: "labelless.html", children: [] },
      { label: "No Src", href: "", children: [] }
    ]);
  });

  it("returns [] for missing, empty, malformed, truncated, and wrong-root sources without throwing", () => {
    expect(parseNavDocument("", "ncx")).toEqual([]);
    expect(parseNavDocument("garbage text {}{}", "ncx")).toEqual([]);
    expect(
      parseNavDocument(`<?xml version="1.0"?><ncx><navMap><navPoint></navMap>`, "ncx")
    ).toEqual([]);
    expect(parseNavDocument(`<?xml version="1.0"?><ncx><navMap>`, "ncx")).toEqual([]);
    expect(parseNavDocument(`<?xml version="1.0"?><foo><bar/></foo>`, "ncx")).toEqual([]);
  });
});

describe("selectNavResource", () => {
  it("selects the EPUB3 nav item (properties token) as xhtml-nav", () => {
    expect(
      selectNavResource([
        { href: "chap1.xhtml", mediaType: "application/xhtml+xml" },
        { href: "nav.xhtml", mediaType: "application/xhtml+xml", properties: "nav" }
      ])
    ).toEqual({ href: "nav.xhtml", kind: "xhtml-nav" });
  });

  it("matches a nav token among multiple whitespace-separated properties", () => {
    expect(
      selectNavResource([
        { href: "nav.xhtml", mediaType: "application/xhtml+xml", properties: "cover nav scripted" }
      ])
    ).toEqual({ href: "nav.xhtml", kind: "xhtml-nav" });
  });

  it("does not treat a substring like 'navigation' as the nav token", () => {
    expect(
      selectNavResource([
        { href: "misc.xhtml", mediaType: "application/xhtml+xml", properties: "navigation" }
      ])
    ).toBeUndefined();
  });

  it("selects the ncx item when no nav property exists", () => {
    expect(
      selectNavResource([
        { href: "chap1.xhtml", mediaType: "application/xhtml+xml" },
        { href: "toc.ncx", mediaType: "application/x-dtbncx+xml" }
      ])
    ).toEqual({ href: "toc.ncx", kind: "ncx" });
  });

  it("prefers the EPUB3 nav over the ncx when both exist", () => {
    expect(
      selectNavResource([
        { href: "toc.ncx", mediaType: "application/x-dtbncx+xml" },
        { href: "nav.xhtml", mediaType: "application/xhtml+xml", properties: "nav" }
      ])
    ).toEqual({ href: "nav.xhtml", kind: "xhtml-nav" });
  });

  it("returns undefined when neither a nav property nor an ncx media type is present", () => {
    expect(
      selectNavResource([{ href: "chap1.xhtml", mediaType: "application/xhtml+xml" }])
    ).toBeUndefined();
    expect(selectNavResource([])).toBeUndefined();
  });
});
