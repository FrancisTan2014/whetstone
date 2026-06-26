// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReadingHeader, type ReadingHeaderProps } from "./ReadingHeader";

function renderHeader(overrides: Partial<ReadingHeaderProps> = {}): ReadingHeaderProps {
  const props: ReadingHeaderProps = {
    hasToc: true,
    hidden: false,
    notesCount: 0,
    notesOpen: false,
    onSizeChange: vi.fn(),
    onToggleNotes: vi.fn(),
    onToggleToc: vi.fn(),
    progress: 0.5,
    size: "md",
    title: "Politics and the English Language",
    tocOpen: false,
    ...overrides
  };

  render(<ReadingHeader {...props} />);

  return props;
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.classList.remove("dark");
});

afterEach(cleanup);

describe("ReadingHeader", () => {
  it("shows the title and a progress bar reflecting the reading progress", () => {
    renderHeader({ progress: 0.42, title: "A Tale of Two Cities" });

    expect(screen.getByText("A Tale of Two Cities")).toBeDefined();
    const progress = screen.getByRole("progressbar", { name: "Reading progress" });
    expect(progress.getAttribute("aria-valuenow")).toBe("42");
  });

  it("changes the reading text size from the size tools", async () => {
    const user = userEvent.setup();
    const props = renderHeader({ size: "md" });

    await user.click(screen.getByRole("button", { name: "Increase reading text size" }));
    expect(props.onSizeChange).toHaveBeenCalledWith("lg");

    await user.click(screen.getByRole("button", { name: "Decrease reading text size" }));
    expect(props.onSizeChange).toHaveBeenCalledWith("sm");
  });

  it("includes the Day/Night theme toggle in the tool strip", () => {
    renderHeader();

    expect(screen.getByRole("button", { name: "Switch to Night" })).toBeDefined();
  });

  it("renders the 目录 toggle when the work has a table of contents", async () => {
    const user = userEvent.setup();
    const props = renderHeader({ hasToc: true, tocOpen: false });

    const toc = screen.getByRole("button", { name: "Table of contents" });
    expect(toc.getAttribute("aria-expanded")).toBe("false");
    expect(toc.getAttribute("aria-controls")).toBe("reader-toc-list");

    await user.click(toc);
    expect(props.onToggleToc).toHaveBeenCalledTimes(1);
  });

  it("reflects the open 目录 drawer through aria-expanded", () => {
    renderHeader({ hasToc: true, tocOpen: true });

    expect(
      screen.getByRole("button", { name: "Table of contents" }).getAttribute("aria-expanded")
    ).toBe("true");
  });

  it("hides the 目录 toggle for a single-unit work without a table of contents", () => {
    renderHeader({ hasToc: false });

    expect(screen.queryByRole("button", { name: "Table of contents" })).toBeNull();
  });

  it("toggles the notes panel and reflects its open state", async () => {
    const user = userEvent.setup();
    const props = renderHeader({ notesOpen: false });

    const notes = screen.getByRole("button", { name: "Your notes" });
    expect(notes.getAttribute("aria-expanded")).toBe("false");

    await user.click(notes);
    expect(props.onToggleNotes).toHaveBeenCalledTimes(1);
  });

  it("shows a count badge only when there are notes", () => {
    renderHeader({ notesCount: 3 });

    const notes = screen.getByRole("button", { name: "Your notes" });
    expect(notes.getAttribute("aria-expanded")).toBe("false");
    expect(notes.textContent).toContain("3");
  });

  it("shows no count on the notes tool when there are no notes", () => {
    renderHeader({ notesCount: 0 });

    const notes = screen.getByRole("button", { name: "Your notes" });
    // The count badge only appears when there are notes, so the control shows no number at zero.
    expect(notes.textContent).not.toMatch(/\d/);
  });

  it("marks the open notes panel through aria-expanded", () => {
    renderHeader({ notesOpen: true });

    expect(screen.getByRole("button", { name: "Your notes" }).getAttribute("aria-expanded")).toBe(
      "true"
    );
  });

  it("keeps its tools reachable when the chrome recedes", () => {
    renderHeader({ hidden: true, title: "Hidden" });

    // The receded chrome stays in the DOM (it returns on hover / scroll-up), so its tools and
    // title remain reachable rather than being removed from the accessibility tree.
    expect(screen.getByText("Hidden")).toBeDefined();
    expect(screen.getByRole("button", { name: "Your notes" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Increase reading text size" })).toBeDefined();
  });
});
