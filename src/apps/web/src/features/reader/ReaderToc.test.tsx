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

function treeEntries(overrides?: Partial<ReaderTocTreeItem>): ReadonlyArray<ReaderTocTreeItem> {
  return [
    { depth: 0, entryId: "t-part", label: "Part One", onSelect: vi.fn() },
    { depth: 1, entryId: "t-chap", label: "Chapter Two", onSelect: vi.fn() },
    { depth: 2, entryId: "t-sec", label: "Section 2.1", onSelect: vi.fn(), ...overrides }
  ];
}

describe("ReaderToc tree mode", () => {
  it("renders the authored labels indented by depth with the active entry marked", () => {
    render(
      <ReaderToc
        activeEntryId="t-chap"
        entries={treeEntries()}
        mode="tree"
        onClose={vi.fn()}
        open={true}
      />
    );

    const nav = screen.getByRole("navigation", { name: "Table of Contents" });
    const buttons = Array.from(nav.querySelectorAll("button.readerTocEntry"));
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Part One",
      "Chapter Two",
      "Section 2.1"
    ]);
    expect(buttons.map((button) => button.getAttribute("data-depth"))).toEqual(["0", "1", "2"]);
    expect(
      buttons.map((button) => (button as HTMLElement).style.getPropertyValue("--toc-depth"))
    ).toEqual(["0", "1", "2"]);

    expect(screen.getByRole("button", { name: "Chapter Two" }).getAttribute("aria-current")).toBe(
      "true"
    );
    expect(screen.getByRole("button", { name: "Part One" }).getAttribute("aria-current")).toBeNull();
  });

  it("does not mark any entry current when no active entry is given", () => {
    render(<ReaderToc entries={treeEntries()} mode="tree" onClose={vi.fn()} open={true} />);

    expect(
      screen.getByRole("button", { name: "Chapter Two" }).getAttribute("aria-current")
    ).toBeNull();
  });

  it("invokes the entry's own navigation thunk then closes the drawer", async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <ReaderToc entries={treeEntries({ onSelect })} mode="tree" onClose={onClose} open={true} />
    );

    await user.click(screen.getByRole("button", { name: "Section 2.1" }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
