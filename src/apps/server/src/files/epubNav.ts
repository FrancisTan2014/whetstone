import { JSDOM } from "jsdom";

// One authored table-of-contents entry: a display `label`, the raw `href` target exactly as written
// in the nav document (relative to that document, e.g. "ch01.html#sec-intro" — never resolved to a
// reading unit here), and its ordered nested `children`. Frozen and readonly so callers cannot mutate
// the parsed tree; this module only parses, it owns no state.
export type NavEntry = Readonly<{ label: string; href: string; children: readonly NavEntry[] }>;

// Which authored navigation document an EPUB uses: an EPUB3 `nav.xhtml` (`<nav epub:type="toc">`) or
// a legacy EPUB2 `toc.ncx`. Callers pass the matching source string to `parseNavDocument`.
type NavKind = "xhtml-nav" | "ncx";

// Collapse inner whitespace runs to a single space and trim. Labels are presented verbatim otherwise —
// never localized, re-cased, or rewritten (an authored TOC label is content, not something we own).
// `textContent` is typed `string | null` but is always a string for an element node, so callers pass
// it through directly.
function normalizeLabel(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// One element's normalized text. `textContent` is `string | null` on the DOM `Node` interface but is
// only ever null for document/doctype nodes, never an element, so the assertion is safe and avoids an
// unreachable null-coalescing branch.
function elementText(el: Element): string {
  return normalizeLabel(el.textContent as string);
}

// The direct element children of `parent` whose tag name (case-insensitively) equals `tag`. Used to
// walk one list/navPoint level at a time so a nested `<ol>`/`<navPoint>` never leaks its descendants
// into the wrong depth. Case-insensitive because HTML lowercases tag names while NCX authors camelCase.
function directChildren(parent: Element, tag: string): Element[] {
  const lower = tag.toLowerCase();
  return Array.from(parent.children).filter((el) => el.tagName.toLowerCase() === lower);
}

// --- EPUB3 nav.xhtml ---------------------------------------------------------------------------

// The structural roles that mark a nav entry as a DIVISION (a Part/Volume/Book that groups the
// chapters after it). These are the EPUB 3 `epub:type` / HTMLBook `data-type` vocabulary for exactly
// this distinction, so grouping is driven by the authored semantic role, never by guessing from label
// text (a chapter titled "Part of the Story" is never misread).
const DIVISION_ROLES: ReadonlySet<string> = new Set(["part", "division", "volume", "book"]);

// Whether a `<li>`'s authored role is a division. The role tokens come from `epub:type` OR `data-type`
// (either attribute — DDIA uses `data-type`, EPUB3 authors use `epub:type`), each a whitespace-separated
// token list; the entry is a division when any token is a division role.
function isDivisionListItem(li: Element): boolean {
  const tokens = `${li.getAttribute("epub:type") ?? ""} ${li.getAttribute("data-type") ?? ""}`
    .toLowerCase()
    .split(/\s+/);
  return tokens.some((token) => DIVISION_ROLES.has(token));
}

// One parsed `<li>` at a level, tagged with whether it is a division, so the sibling list can be
// normalized (below) before the role information is discarded.
type ParsedListItem = Readonly<{ entry: NavEntry; isDivision: boolean }>;

// Normalize an authored DIVISION-AS-SIBLING nav into DIVISION-AS-PARENT (#515). At one `<ol>` level, a
// division entry that authored NO children of its own absorbs the following sibling entries as its
// children, up to — but not including — the next division (any division ends the absorption). Entries
// before the first division stay in place; a division that already has children is kept as-is (no
// double-nesting) and still ends a previous division's absorption; a level with no division at all is
// returned verbatim. So a correctly-nested nav, a plain flat nav, and the NCX path are all no-ops, and
// an absorbing Part keeps its own label/href (it stays selectable) while gaining children.
function groupDivisions(items: ReadonlyArray<ParsedListItem>): NavEntry[] {
  const result: NavEntry[] = [];
  let openDivision: { label: string; href: string; children: NavEntry[] } | null = null;

  const flush = (): void => {
    if (openDivision !== null) {
      result.push(
        Object.freeze({
          label: openDivision.label,
          href: openDivision.href,
          children: Object.freeze(openDivision.children)
        })
      );
      openDivision = null;
    }
  };

  for (const item of items) {
    if (item.isDivision) {
      flush();
      if (item.entry.children.length === 0) {
        openDivision = { label: item.entry.label, href: item.entry.href, children: [] };
      } else {
        result.push(item.entry);
      }
      continue;
    }

    if (openDivision !== null) {
      openDivision.children.push(item.entry);
    } else {
      result.push(item.entry);
    }
  }

  flush();
  return result;
}

// Parse one `<ol>` into its ordered entries. Each `<li>` maps to its own `<a href>` entry plus the
// entries of its nested `<ol>` (recursing preserves depth and sibling order). A `<li>` that carries
// neither a label nor an href but does nest a list still contributes: its children are hoisted into
// this level in place, so a purely structural wrapper `<li>` never drops the sections beneath it while
// a truly empty `<li>` (no label, no href, no children) contributes nothing. After the siblings are
// built, an authored division-as-sibling (a Part flat beside its chapters) is normalized into a
// division-as-parent (#515) via `groupDivisions`.
function parseOrderedList(ol: Element): NavEntry[] {
  const items: ParsedListItem[] = [];

  for (const li of directChildren(ol, "li")) {
    const anchor = directChildren(li, "a")[0];
    const label = anchor ? elementText(anchor) : "";
    const href = anchor ? (anchor.getAttribute("href") ?? "").trim() : "";

    const nestedOl = directChildren(li, "ol")[0];
    const children = nestedOl ? parseOrderedList(nestedOl) : [];

    if (label === "" && href === "") {
      // A purely structural wrapper: hoist its (already-normalized) children into this level. They are
      // not divisions at this level, so they never trigger or terminate grouping here.
      for (const child of children) {
        items.push({ entry: child, isDivision: false });
      }
      continue;
    }

    items.push({
      entry: Object.freeze({ label, href, children: Object.freeze(children) }),
      isDivision: isDivisionListItem(li)
    });
  }

  return groupDivisions(items);
}

// Locate the toc nav among a document's `<nav>` elements. `epub:type` is an EPUB namespaced attribute;
// in an HTML-parsed document it is a literal attribute name, so `getAttribute("epub:type")` matches it
// robustly (a CSS `[epub\:type]` selector does not reliably match in jsdom). When no nav is explicitly
// typed `toc`, fall back to the first `<nav>` that actually contains an `<ol>` — the shape of a TOC.
function findTocNav(doc: Document): Element | undefined {
  const navs = Array.from(doc.getElementsByTagName("nav"));

  const typedToc = navs.find((nav) => (nav.getAttribute("epub:type") ?? "").trim() === "toc");
  if (typedToc) {
    return typedToc;
  }

  return navs.find((nav) => nav.getElementsByTagName("ol").length > 0);
}

function parseXhtmlNav(source: string): NavEntry[] {
  const doc = new JSDOM(source).window.document;

  const nav = findTocNav(doc);
  if (!nav) {
    return [];
  }

  const ol = directChildren(nav, "ol")[0];
  return ol ? parseOrderedList(ol) : [];
}

// --- EPUB2 toc.ncx -----------------------------------------------------------------------------

// The numeric `playOrder` of a navPoint, or undefined when absent or non-numeric. The NCX spec lets
// authors declare an explicit reading order that can differ from document order; we honor it only when
// it is a clean integer so a malformed attribute cannot reorder the tree.
function parsePlayOrder(navPoint: Element): number | undefined {
  const raw = navPoint.getAttribute("playOrder");
  if (raw === null || raw.trim() === "") {
    return undefined;
  }

  const value = Number(raw);
  return Number.isInteger(value) ? value : undefined;
}

// Order sibling navPoints by `playOrder` when every sibling declares a valid one (ties and the
// no-playOrder case both keep document order). Requiring all siblings to have it avoids interleaving an
// explicit order with implicit positions, which the spec leaves undefined.
function orderNavPoints(navPoints: Element[]): Element[] {
  const indexed = navPoints.map((navPoint, index) => ({
    navPoint,
    index,
    order: parsePlayOrder(navPoint)
  }));

  if (indexed.every((entry) => entry.order !== undefined)) {
    indexed.sort((a, b) => (a.order as number) - (b.order as number) || a.index - b.index);
  }

  return indexed.map((entry) => entry.navPoint);
}

// Parse the ordered navPoint children of `parent` (a navMap or a navPoint) into entries. Each navPoint
// contributes its `navLabel/text` (label) and `content/@src` (href) plus its nested navPoints. A
// navPoint with neither a label nor an href is dropped but still contributes its children, mirroring
// the nav.xhtml wrapper rule.
function parseNavPoints(parent: Element): NavEntry[] {
  const entries: NavEntry[] = [];

  for (const navPoint of orderNavPoints(directChildren(parent, "navPoint"))) {
    const navLabel = directChildren(navPoint, "navLabel")[0];
    const text = navLabel ? directChildren(navLabel, "text")[0] : undefined;
    const label = text ? elementText(text) : "";

    const content = directChildren(navPoint, "content")[0];
    const href = content ? (content.getAttribute("src") ?? "").trim() : "";

    const children = parseNavPoints(navPoint);

    if (label === "" && href === "") {
      entries.push(...children);
      continue;
    }

    entries.push(Object.freeze({ label, href, children: Object.freeze(children) }));
  }

  return entries;
}

function parseNcx(source: string): NavEntry[] {
  // jsdom throws on malformed XML (unclosed tags, no root, stray text). Wrapping the construction keeps
  // the fail-soft contract: any XML the parser rejects yields [] rather than a thrown error.
  let doc: Document;
  try {
    doc = new JSDOM(source, { contentType: "application/xml" }).window.document;
  } catch {
    return [];
  }

  const navMap = Array.from(doc.getElementsByTagName("*")).find(
    (el) => el.tagName.toLowerCase() === "navmap"
  );

  return navMap ? parseNavPoints(navMap) : [];
}

// --- Public surface ----------------------------------------------------------------------------

// Parse an EPUB's authored navigation document into a normalized hierarchical tree. `kind` selects the
// grammar: `"xhtml-nav"` for an EPUB3 `<nav epub:type="toc">` and `"ncx"` for an EPUB2 `toc.ncx`.
//
// Pure and total: no fs, network, logging, or UI, and it never throws on any input. Missing, empty,
// malformed, or non-matching source returns []. hrefs are the raw targets relative to the nav document;
// labels are whitespace-collapsed and trimmed; entries with an empty label and empty href are dropped
// (a purely structural node still contributes its children).
//
// The two branches are each internally total: HTML parsing yields an empty/non-matching document rather
// than throwing (so a non-matching nav.xhtml returns []), and the NCX branch wraps jsdom's XML parser —
// which does throw on malformed XML — to return [] instead.
export function parseNavDocument(source: string, kind: NavKind): readonly NavEntry[] {
  const entries = kind === "xhtml-nav" ? parseXhtmlNav(source) : parseNcx(source);
  return Object.freeze(entries);
}

// Identify which manifest resource is the authored navigation document, without reading it. Pure: it
// inspects only the manifest metadata the caller supplies.
//
// EPUB3 wins first — the item whose space-separated `properties` tokens include `nav` (a whitespace
// token match, so `properties="cover nav"` qualifies but a substring like `navigation` does not). Else
// EPUB2 — the item whose media type is `application/x-dtbncx+xml`. Else undefined. When both exist the
// EPUB3 nav wins. Returns the chosen item's raw `href` and its `kind`.
export function selectNavResource(
  manifest: ReadonlyArray<{ href: string; mediaType?: string; properties?: string }>
): { href: string; kind: NavKind } | undefined {
  const nav = manifest.find((item) => (item.properties ?? "").split(/\s+/).includes("nav"));
  if (nav) {
    return { href: nav.href, kind: "xhtml-nav" };
  }

  const ncx = manifest.find((item) => item.mediaType === "application/x-dtbncx+xml");
  if (ncx) {
    return { href: ncx.href, kind: "ncx" };
  }

  return undefined;
}
