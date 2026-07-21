// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ManualWorkSectionDto } from "@whetstone/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deriveWorkOutline, WorkOutline } from "./WorkOutline";

function mockMatchMedia(matches: boolean): void {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    addEventListener: vi.fn(),
    addListener: vi.fn(),
    dispatchEvent: vi.fn(),
    matches,
    media: query,
    onchange: null,
    removeEventListener: vi.fn(),
    removeListener: vi.fn()
  })) as unknown as typeof window.matchMedia;
}

// A leading pre-heading section (unit-a → a root "Start" entry) and a Heading 1 section (unit-b).
const multiSections: readonly ManualWorkSectionDto[] = [
  { orderIndex: 0, unitEntryId: "unit-a" },
  { headingLevel: 1, orderIndex: 1, title: "Chapter One", unitEntryId: "unit-b" }
];

function renderOutline(overrides: Partial<React.ComponentProps<typeof WorkOutline>> = {}): {
  onAddSection: ReturnType<typeof vi.fn>;
  onSelect: ReturnType<typeof vi.fn>;
} {
  const onAddSection = vi.fn();
  const onSelect = vi.fn();
  render(
    <WorkOutline
      activeUnitEntryId="unit-a"
      addPending={false}
      entries={deriveWorkOutline(multiSections)}
      onAddSection={onAddSection}
      onSelect={onSelect}
      {...overrides}
    />
  );
  return { onAddSection, onSelect };
}

beforeEach(() => {
  mockMatchMedia(false);
});

afterEach(() => {
  cleanup();
});

describe("deriveWorkOutline", () => {
  it("returns an empty outline for a single-section work", () => {
    expect(deriveWorkOutline([{ orderIndex: 0, unitEntryId: "only" }])).toEqual([]);
  });

  it("projects ordered sections into the shared hierarchical outline", () => {
    const entries = deriveWorkOutline(multiSections);

    expect(entries.map((entry) => entry.label)).toEqual(["Start", "Chapter One"]);
    expect(entries.map((entry) => entry.targetUnitEntryId)).toEqual(["unit-a", "unit-b"]);
  });

  it("labels an empty heading as an untitled section", () => {
    const entries = deriveWorkOutline([
      { orderIndex: 0, unitEntryId: "unit-a" },
      { headingLevel: 1, orderIndex: 1, unitEntryId: "unit-b" }
    ]);

    expect(entries.map((entry) => entry.label)).toEqual(["Start", "Untitled section"]);
  });
});

describe("WorkOutline (drawer, < 48rem)", () => {
  it("marks the active section with aria-current and leaves the others unset", () => {
    renderOutline();

    expect(screen.getByRole("button", { name: "Start" }).getAttribute("aria-current")).toBe("true");
    expect(
      screen.getByRole("button", { name: "Chapter One" }).getAttribute("aria-current")
    ).toBeNull();
  });

  it("opens the drawer from the toggle and dismisses it via the backdrop, restoring focus", async () => {
    const user = userEvent.setup();
    renderOutline();

    const toggle = screen.getByRole("button", { name: "Outline" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "Close outline" })).toBeNull();

    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    await user.click(screen.getByRole("button", { name: "Close outline" }));
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle);
  });

  it("closes the drawer on Escape and restores focus to the toggle", async () => {
    const user = userEvent.setup();
    renderOutline();

    const toggle = screen.getByRole("button", { name: "Outline" });
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle);
  });

  it("ignores non-Escape keys while the drawer is open", async () => {
    const user = userEvent.setup();
    renderOutline();

    const toggle = screen.getByRole("button", { name: "Outline" });
    await user.click(toggle);
    fireEvent.keyDown(document, { key: "ArrowDown" });

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("selects an entry and closes the drawer", async () => {
    const user = userEvent.setup();
    const { onSelect } = renderOutline();

    const toggle = screen.getByRole("button", { name: "Outline" });
    await user.click(toggle);
    await user.click(screen.getByRole("button", { name: "Chapter One" }));

    expect(onSelect).toHaveBeenCalledWith("unit-b");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("shows the empty hint and no list when there are no outline entries", () => {
    renderOutline({ entries: [] });

    expect(screen.getByText("Add a section to build your outline.")).toBeDefined();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("invokes the add-section callback and reflects the pending label", () => {
    const { onAddSection } = renderOutline();

    fireEvent.click(screen.getByRole("button", { name: "Add section" }));
    expect(onAddSection).toHaveBeenCalledTimes(1);
  });

  it("disables the add control while an add is pending", () => {
    renderOutline({ addPending: true });

    const add = screen.getByRole("button", { name: "Adding…" });
    expect((add as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("WorkOutline (sidebar, >= 48rem)", () => {
  beforeEach(() => {
    mockMatchMedia(true);
  });

  it("selects an entry without any drawer dismissal", async () => {
    const user = userEvent.setup();
    const { onSelect } = renderOutline();

    // No backdrop is ever rendered as a sidebar, even after the (CSS-hidden) toggle is activated.
    await user.click(screen.getByRole("button", { name: "Chapter One" }));
    expect(onSelect).toHaveBeenCalledWith("unit-b");
    expect(screen.queryByRole("button", { name: "Close outline" })).toBeNull();
  });
});
