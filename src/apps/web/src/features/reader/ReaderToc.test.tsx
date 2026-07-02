// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReaderToc, type ReaderTocItem, type ReaderTocTreeItem } from "./ReaderToc";

const items: ReadonlyArray<ReaderTocItem> = [
  { entryId: "u-1", label: "Section 1" },
  { entryId: "u-2", label: "Chapter Two" }
];

afterEach(cleanup);

describe("ReaderToc list mode", () => {
  it("renders nothing while the drawer is closed", () => {
    render(
      <ReaderToc
        activeIndex={0}
        items={items}
        mode="list"
        onClose={vi.fn()}
        onSelect={vi.fn()}
        open={false}
      />
    );

    expect(screen.queryByRole("navigation", { name: "Table of Contents" })).toBeNull();
  });

  it("lists the units and marks the active one when open", () => {
    render(
      <ReaderToc
        activeIndex={1}
        items={items}
        mode="list"
        onClose={vi.fn()}
        onSelect={vi.fn()}
        open={true}
      />
    );

    const nav = screen.getByRole("navigation", { name: "Table of Contents" });
    expect(nav.id).toBe("reader-toc-list");
    const buttons = nav.querySelectorAll("button.readerTocItem");
    expect(Array.from(buttons).map((button) => button.textContent)).toEqual([
      "Section 1",
      "Chapter Two"
    ]);
    expect(screen.getByRole("button", { name: "Chapter Two" }).getAttribute("aria-current")).toBe(
      "true"
    );
    expect(
      screen.getByRole("button", { name: "Section 1" }).getAttribute("aria-current")
    ).toBeNull();
  });

  it("selects a unit then closes the drawer", async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <ReaderToc
        activeIndex={0}
        items={items}
        mode="list"
        onClose={onClose}
        onSelect={onSelect}
        open={true}
      />
    );

    await user.click(screen.getByRole("button", { name: "Chapter Two" }));

    expect(onSelect).toHaveBeenCalledWith(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes the drawer when the backdrop is tapped", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <ReaderToc
        activeIndex={0}
        items={items}
        mode="list"
        onClose={onClose}
        onSelect={vi.fn()}
        open={true}
      />
    );

    await user.click(screen.getByRole("button", { name: "Close table of contents" }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

type TreeSelectKey = "c1" | "c2" | "c3" | "part" | "part2" | "sec";
type VoidMock = ReturnType<typeof vi.fn<() => void>>;

// A two-part authored tree with a nested branch, so a test can exercise depth, an auto-expanded active
// path, and an unrelated collapsed branch:
//   Part One → { Chapter One (leaf), Chapter Two → Section 2.1 (leaf) }
//   Part Two → Chapter Three (leaf)
function buildTree(): {
  entries: ReadonlyArray<ReaderTocTreeItem>;
  selects: Record<TreeSelectKey, VoidMock>;
} {
  const selects: Record<TreeSelectKey, VoidMock> = {
    c1: vi.fn<() => void>(),
    c2: vi.fn<() => void>(),
    c3: vi.fn<() => void>(),
    part: vi.fn<() => void>(),
    part2: vi.fn<() => void>(),
    sec: vi.fn<() => void>()
  };
  const entries: ReadonlyArray<ReaderTocTreeItem> = [
    { depth: 0, entryId: "t-part", label: "Part One", onSelect: selects.part },
    {
      depth: 1,
      entryId: "t-c1",
      label: "Chapter One",
      onSelect: selects.c1,
      parentEntryId: "t-part"
    },
    {
      depth: 1,
      entryId: "t-c2",
      label: "Chapter Two",
      onSelect: selects.c2,
      parentEntryId: "t-part"
    },
    {
      depth: 2,
      entryId: "t-sec",
      label: "Section 2.1",
      onSelect: selects.sec,
      parentEntryId: "t-c2"
    },
    { depth: 0, entryId: "t-part2", label: "Part Two", onSelect: selects.part2 },
    {
      depth: 1,
      entryId: "t-c3",
      label: "Chapter Three",
      onSelect: selects.c3,
      parentEntryId: "t-part2"
    }
  ];

  return { entries, selects };
}

describe("ReaderToc tree mode", () => {
  it("auto-expands the active entry's ancestors and collapses unrelated branches", () => {
    const { entries } = buildTree();
    render(
      <ReaderToc
        activeEntryId="t-sec"
        entries={entries}
        mode="tree"
        onClose={vi.fn()}
        open={true}
      />
    );

    // The active entry (Section 2.1) sits under Part One → Chapter Two, so both open and it shows.
    expect(
      screen.getByRole("button", { name: "Collapse Part One" }).getAttribute("aria-expanded")
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: "Collapse Chapter Two" }).getAttribute("aria-expanded")
    ).toBe("true");
    expect(screen.getByRole("button", { name: "Section 2.1" }).getAttribute("aria-current")).toBe(
      "true"
    );

    // The unrelated Part Two branch stays collapsed, so its child is not in the tree.
    expect(
      screen.getByRole("button", { name: "Expand Part Two" }).getAttribute("aria-expanded")
    ).toBe("false");
    expect(screen.queryByRole("button", { name: "Chapter Three" })).toBeNull();
  });

  it("indents each node by its authored depth via the token data attribute and custom property", () => {
    const { entries } = buildTree();
    render(
      <ReaderToc
        activeEntryId="t-sec"
        entries={entries}
        mode="tree"
        onClose={vi.fn()}
        open={true}
      />
    );

    const nav = screen.getByRole("navigation", { name: "Table of Contents" });
    const nodes = Array.from(nav.querySelectorAll("li.readerTocNode"));
    expect(nodes.map((node) => node.querySelector(".readerTocEntry")?.textContent)).toEqual([
      "Part One",
      "Chapter One",
      "Chapter Two",
      "Section 2.1",
      "Part Two"
    ]);
    expect(nodes.map((node) => node.getAttribute("data-depth"))).toEqual(["0", "1", "1", "2", "0"]);
    expect(
      nodes.map((node) => (node as HTMLElement).style.getPropertyValue("--toc-depth"))
    ).toEqual(["0", "1", "1", "2", "0"]);
  });

  it("does not mark any entry current when no active entry is given, opening every branch collapsed", () => {
    const { entries } = buildTree();
    render(<ReaderToc entries={entries} mode="tree" onClose={vi.fn()} open={true} />);

    expect(
      screen.getByRole("button", { name: "Expand Part One" }).getAttribute("aria-expanded")
    ).toBe("false");
    expect(screen.queryByRole("button", { name: "Chapter One" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Part One" }).getAttribute("aria-current")
    ).toBeNull();
  });

  it("toggles a branch open and closed from its disclosure control", async () => {
    const { entries } = buildTree();
    const user = userEvent.setup();
    render(<ReaderToc entries={entries} mode="tree" onClose={vi.fn()} open={true} />);

    // Collapsed by default (no active path): the children are absent.
    expect(screen.queryByRole("button", { name: "Chapter One" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Expand Part One" }));

    // Expanding reveals the children and flips aria-expanded on the (relabelled) disclosure.
    expect(screen.getByRole("button", { name: "Chapter One" })).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Collapse Part One" }).getAttribute("aria-expanded")
    ).toBe("true");

    await user.click(screen.getByRole("button", { name: "Collapse Part One" }));

    // Collapsing removes the descendants from the tree again.
    expect(screen.queryByRole("button", { name: "Chapter One" })).toBeNull();
  });

  it("toggles a branch with the keyboard (Enter and Space) on the disclosure", async () => {
    const { entries } = buildTree();
    const user = userEvent.setup();
    render(<ReaderToc entries={entries} mode="tree" onClose={vi.fn()} open={true} />);

    screen.getByRole("button", { name: "Expand Part One" }).focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: "Chapter One" })).toBeDefined();

    await user.keyboard(" ");
    expect(screen.queryByRole("button", { name: "Chapter One" })).toBeNull();
  });

  it("selects a leaf entry then closes the drawer without toggling", async () => {
    const { entries, selects } = buildTree();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <ReaderToc activeEntryId="t-c1" entries={entries} mode="tree" onClose={onClose} open={true} />
    );

    // Part One auto-expands (Chapter One is active), so the leaf is reachable.
    await user.click(screen.getByRole("button", { name: "Chapter One" }));

    expect(selects.c1).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("navigates from a parent entry's label without toggling its branch", async () => {
    const { entries, selects } = buildTree();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <ReaderToc activeEntryId="t-c1" entries={entries} mode="tree" onClose={onClose} open={true} />
    );

    // Part One is expanded (active path). Clicking its label navigates; the branch stays open.
    await user.click(screen.getByRole("button", { name: "Part One" }));

    expect(selects.part).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "Collapse Part One" }).getAttribute("aria-expanded")
    ).toBe("true");
    expect(screen.getByRole("button", { name: "Chapter One" })).toBeDefined();
  });

  it("toggling the disclosure never fires the entry's navigation", async () => {
    const { entries, selects } = buildTree();
    const user = userEvent.setup();
    render(<ReaderToc entries={entries} mode="tree" onClose={vi.fn()} open={true} />);

    await user.click(screen.getByRole("button", { name: "Expand Part One" }));

    expect(selects.part).not.toHaveBeenCalled();
  });

  it("re-seeds the expanded path when the active entry moves to another branch", () => {
    const { entries } = buildTree();
    const { rerender } = render(
      <ReaderToc activeEntryId="t-c1" entries={entries} mode="tree" onClose={vi.fn()} open={true} />
    );

    // Part One open (holds the active Chapter One); Part Two collapsed.
    expect(screen.queryByRole("button", { name: "Chapter Three" })).toBeNull();

    rerender(
      <ReaderToc activeEntryId="t-c3" entries={entries} mode="tree" onClose={vi.fn()} open={true} />
    );

    // The active entry moved into Part Two, so that branch opens and reveals its child.
    expect(screen.getByRole("button", { name: "Chapter Three" })).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Collapse Part Two" }).getAttribute("aria-expanded")
    ).toBe("true");
  });
});
