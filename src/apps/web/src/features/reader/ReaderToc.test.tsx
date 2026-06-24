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
  it("lists the units and marks the active one", () => {
    render(<ReaderToc activeIndex={1} items={items} onSelect={vi.fn()} />);

    const nav = screen.getByRole("navigation", { name: "目录" });
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

  it("calls onSelect with the chosen unit index", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<ReaderToc activeIndex={0} items={items} onSelect={onSelect} />);

    await user.click(screen.getByRole("button", { name: "Chapter Two" }));

    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it("toggles the mobile drawer open and closes it after a selection", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<ReaderToc activeIndex={0} items={items} onSelect={onSelect} />);

    const toggle = screen.getByRole("button", { name: "目录" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("navigation", { name: "目录" }).className).toContain(
      "readerTocNav--open"
    );

    await user.click(screen.getByRole("button", { name: "Section 1" }));
    expect(onSelect).toHaveBeenCalledWith(0);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });
});
