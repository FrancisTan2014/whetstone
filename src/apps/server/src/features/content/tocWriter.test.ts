import { toEntryId } from "@whetstone/domain";
import { describe, expect, it } from "vitest";

import type { NavEntry } from "../../files/epubNav.js";
import { parseNavDocument } from "../../files/epubNav.js";
import { flattenNavTree, writeTocEntries, type TocEntryRow } from "./tocWriter.js";

// A deterministic id source: entries are created in pre-order, so ids read e-0, e-1, … in walk order.
function sequentialIds(): () => string {
  let next = 0;

  return () => `e-${next++}`;
}

// A multi-level authored nav (Part › Chapter › Section) whose hrefs exercise every target shape:
// a label-only structural node (empty href), a `../` relative whole-file entry, a same-file
// `#fragment`, a bare `#fragment` (no path), and an empty `file#` fragment.
const navEntries: ReadonlyArray<NavEntry> = [
  {
    children: [
      {
        children: [{ children: [], href: "../ch01.xhtml#sec-1", label: "Section 1.1" }],
        href: "../ch01.xhtml",
        label: "Chapter One"
      },
      { children: [], href: "#backmatter", label: "Endnotes" }
    ],
    href: "",
    label: "Part One"
  },
  { children: [], href: "../ch02.xhtml#", label: "Chapter Two" }
];

const navPath = "OEBPS/text/nav.xhtml";

describe("flattenNavTree", () => {
  const rows = flattenNavTree(navEntries, navPath, sequentialIds());
  const byLabel = new Map(rows.map((row) => [row.label, row]));

  function row(label: string): TocEntryRow {
    const found = byLabel.get(label);

    if (found === undefined) {
      throw new Error(`no flattened row for ${label}`);
    }

    return found;
  }

  it("walks the tree in pre-order assigning a work-global orderIndex", () => {
    expect(rows.map((entry) => entry.label)).toEqual([
      "Part One",
      "Chapter One",
      "Section 1.1",
      "Endnotes",
      "Chapter Two"
    ]);
    expect(rows.map((entry) => entry.orderIndex)).toEqual([0, 1, 2, 3, 4]);
  });

  it("records the authored depth and parent of each entry", () => {
    expect(rows.map((entry) => entry.depth)).toEqual([0, 1, 2, 1, 0]);
    expect(row("Part One").parentEntryId).toBeNull();
    expect(row("Chapter One").parentEntryId).toBe(row("Part One").entryId);
    expect(row("Section 1.1").parentEntryId).toBe(row("Chapter One").entryId);
    expect(row("Endnotes").parentEntryId).toBe(row("Part One").entryId);
    expect(row("Chapter Two").parentEntryId).toBeNull();
  });

  it("resolves a whole-file entry's href relative to the nav document with no anchor", () => {
    expect(row("Chapter One").targetSourceFile).toBe("OEBPS/ch01.xhtml");
    expect(row("Chapter One").targetAnchor).toBeNull();
  });

  it("splits a same-file #fragment into its source file and anchor", () => {
    expect(row("Section 1.1").targetSourceFile).toBe("OEBPS/ch01.xhtml");
    expect(row("Section 1.1").targetAnchor).toBe("sec-1");
  });

  it("leaves a label-only structural entry (empty href) unresolved", () => {
    expect(row("Part One").targetSourceFile).toBeNull();
    expect(row("Part One").targetAnchor).toBeNull();
  });

  it("keeps a bare #fragment as an anchor with no source file", () => {
    expect(row("Endnotes").targetSourceFile).toBeNull();
    expect(row("Endnotes").targetAnchor).toBe("backmatter");
  });

  it("treats an empty file# fragment as a whole-file target", () => {
    expect(row("Chapter Two").targetSourceFile).toBe("OEBPS/ch02.xhtml");
    expect(row("Chapter Two").targetAnchor).toBeNull();
  });
});

// After the division-as-sibling normalization (#515), a DDIA-shaped flat nav flattens to the promised
// depth ladder (Part 0 › Chapter 1 › Section 2 › Subsection 3), with each chapter parented to its Part
// and the absorbing Part still selectable.
describe("flattenNavTree over a division-normalized DDIA nav (#515)", () => {
  const ddiaNav = `<html xmlns:epub="http://www.idpf.org/2007/ops"><body>
    <nav epub:type="toc"><ol>
      <li data-type="preface"><a href="preface01.html#preface">Preface</a></li>
      <li data-type="part"><a href="part01.html#foundations">Part I</a></li>
      <li data-type="chapter"><a href="ch01.html#intro">Chapter 1</a>
        <ol><li><a href="ch01.html#reliability">Reliability</a>
          <ol><li><a href="ch01.html#faults">Faults</a></li></ol>
        </li></ol>
      </li>
      <li data-type="chapter"><a href="ch02.html#models">Chapter 2</a></li>
      <li data-type="part"><a href="part02.html#dist">Part II</a></li>
      <li data-type="chapter"><a href="ch05.html#repl">Chapter 5</a></li>
    </ol></nav>
  </body></html>`;

  const rows = flattenNavTree(
    parseNavDocument(ddiaNav, "xhtml-nav"),
    "OEBPS/nav.xhtml",
    sequentialIds()
  );
  const byLabel = new Map(rows.map((entry) => [entry.label, entry]));

  function row(label: string): TocEntryRow {
    const found = byLabel.get(label);
    if (found === undefined) {
      throw new Error(`no flattened row for ${label}`);
    }
    return found;
  }

  it("assigns Part 0 › Chapter 1 › Section 2 › Subsection 3 with the Preface left top-level", () => {
    expect(rows.map((entry) => [entry.label, entry.depth])).toEqual([
      ["Preface", 0],
      ["Part I", 0],
      ["Chapter 1", 1],
      ["Reliability", 2],
      ["Faults", 3],
      ["Chapter 2", 1],
      ["Part II", 0],
      ["Chapter 5", 1]
    ]);
    expect(row("Chapter 1").parentEntryId).toBe(row("Part I").entryId);
    expect(row("Chapter 2").parentEntryId).toBe(row("Part I").entryId);
    expect(row("Chapter 5").parentEntryId).toBe(row("Part II").entryId);
    expect(row("Preface").parentEntryId).toBeNull();
  });

  it("keeps the absorbed Part selectable (retains its resolved target)", () => {
    expect(row("Part I").targetSourceFile).toBe("OEBPS/part01.html");
    expect(row("Part I").targetAnchor).toBe("foundations");
  });
});

// A minimal transaction stub capturing what each table receives; writeTocEntries only ever calls
// `tx.insert(table).values(batch)`, so this is enough to observe the persisted rows without a DB.
function fakeTransaction(): {
  inserts: Array<{ rows: ReadonlyArray<Record<string, unknown>>; table: unknown }>;
  tx: Parameters<typeof writeTocEntries>[0];
} {
  const inserts: Array<{ rows: ReadonlyArray<Record<string, unknown>>; table: unknown }> = [];
  const tx = {
    insert: (table: unknown) => ({
      values: (rows: ReadonlyArray<Record<string, unknown>>) => {
        inserts.push({ rows, table });
        return Promise.resolve();
      }
    })
  };

  return { inserts, tx: tx as unknown as Parameters<typeof writeTocEntries>[0] };
}

describe("writeTocEntries", () => {
  it("persists nothing when the nav has no entries", async () => {
    const { inserts, tx } = fakeTransaction();

    await writeTocEntries(tx, {
      createEntryId: sequentialIds(),
      navEntries: [],
      navPath,
      workEntryId: toEntryId("work-1")
    });

    expect(inserts).toHaveLength(0);
  });

  it("registers each entry as an entries row and a toc_entries row", async () => {
    const { inserts, tx } = fakeTransaction();

    await writeTocEntries(tx, {
      createEntryId: sequentialIds(),
      navEntries,
      navPath,
      workEntryId: toEntryId("work-1")
    });

    // Two inserts: the entries rows first (so the toc_entries FKs resolve), then the toc_entries rows.
    expect(inserts).toHaveLength(2);
    const entryRows = inserts[0]?.rows ?? [];
    const tocRows = inserts[1]?.rows ?? [];

    expect(entryRows).toHaveLength(5);
    expect(entryRows.every((entry) => entry.type === "toc_entry")).toBe(true);

    expect(tocRows).toHaveLength(5);
    expect(tocRows.every((entry) => entry.workEntryId === "work-1")).toBe(true);
    expect(tocRows.map((entry) => entry.label)).toEqual([
      "Part One",
      "Chapter One",
      "Section 1.1",
      "Endnotes",
      "Chapter Two"
    ]);
    expect(tocRows[2]).toMatchObject({
      depth: 2,
      label: "Section 1.1",
      orderIndex: 2,
      targetAnchor: "sec-1",
      targetSourceFile: "OEBPS/ch01.xhtml"
    });
  });
});
