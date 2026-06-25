// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReaderToc, type ReaderTocItem } from "./ReaderToc";

const items: ReadonlyArray<ReaderTocItem> = [
  { entryId: "u-1", label: "Section 1" },
  { entryId: "u-2", label: "Chapter Two" }
];

afterEach(cleanup);

describe("ReaderToc", () => {
  it("renders nothing while the drawer is closed", () => {
    render(
      <ReaderToc activeIndex={0} items={items} onClose={vi.fn()} onSelect={vi.fn()} open={false} />
    );

    expect(screen.queryByRole("navigation", { name: "目录" })).toBeNull();
  });

  it("lists the units and marks the active one when open", () => {
    render(
      <ReaderToc activeIndex={1} items={items} onClose={vi.fn()} onSelect={vi.fn()} open={true} />
    );

    const nav = screen.getByRole("navigation", { name: "目录" });
    expect(nav.id).toBe("reader-toc-list");
    const buttons = nav.querySelectorAll("button");
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
      <ReaderToc activeIndex={0} items={items} onClose={onClose} onSelect={onSelect} open={true} />
    );

    await user.click(screen.getByRole("button", { name: "Chapter Two" }));

    expect(onSelect).toHaveBeenCalledWith(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes the drawer when the backdrop is tapped", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <ReaderToc activeIndex={0} items={items} onClose={onClose} onSelect={vi.fn()} open={true} />
    );

    await user.click(screen.getByRole("button", { name: "Close table of contents" }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
