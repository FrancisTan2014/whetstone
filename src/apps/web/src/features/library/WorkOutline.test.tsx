// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ManualWorkSectionDto } from "@whetstone/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deriveWorkOutline, projectDraftOutline, WorkOutline } from "./WorkOutline";
import type { DocumentNodeJSON } from "@whetstone/document";

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
  const onAddSection = vi.fn(async () => true);
  const onSelect = vi.fn();
  render(
    <WorkOutline
      activeUnitEntryId="unit-a"
      addPending={null}
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

describe("projectDraftOutline", () => {
  function docOf(...nodes: ReadonlyArray<DocumentNodeJSON>): DocumentNodeJSON {
    return { content: [...nodes], type: "doc" };
  }
  function heading(level: number, text: string): DocumentNodeJSON {
    return { attrs: { level }, content: [{ text, type: "text" }], type: "heading" };
  }
  function para(text: string): DocumentNodeJSON {
    return { content: [{ text, type: "text" }], type: "paragraph" };
  }

  it("reflects the active section's draft heading rename immediately", () => {
    const entries = projectDraftOutline(multiSections, "unit-b", docOf(heading(1, "Renamed")));

    expect(entries.map((entry) => entry.label)).toEqual(["Start", "Renamed"]);
    expect(entries.map((entry) => entry.targetUnitEntryId)).toEqual(["unit-a", "unit-b"]);
  });

  it("previews a heading typed inside the active section as a nested, non-navigating entry", () => {
    // A hard break in the sub-heading's inline content exercises non-text children in the label read.
    const subHeading: DocumentNodeJSON = {
      attrs: { level: 2 },
      content: [{ text: "A Subsection", type: "text" }, { type: "hardBreak" }],
      type: "heading"
    };
    const entries = projectDraftOutline(
      multiSections,
      "unit-b",
      docOf(heading(1, "Chapter One"), para("body"), subHeading)
    );

    expect(entries.map((entry) => entry.label)).toEqual(["Start", "Chapter One", "A Subsection"]);
    expect(entries.map((entry) => entry.depth)).toEqual([0, 0, 1]);
    // The preview sub-entry has its own key but targets the active unit, so a click keeps it open.
    const preview = entries[2]!;
    expect(preview.entryId).not.toBe("unit-b");
    expect(preview.targetUnitEntryId).toBe("unit-b");
  });

  it("keeps the active section headless when its draft opens without a heading", () => {
    const entries = projectDraftOutline(multiSections, "unit-a", docOf(para("A lead line")));

    expect(entries.map((entry) => entry.label)).toEqual(["Start", "Chapter One"]);
    expect(entries.map((entry) => entry.targetUnitEntryId)).toEqual(["unit-a", "unit-b"]);
  });

  it("labels an empty draft heading (no inline content) as an untitled section", () => {
    const emptyHeading: DocumentNodeJSON = { attrs: { level: 1 }, type: "heading" };
    const entries = projectDraftOutline(multiSections, "unit-b", docOf(emptyHeading));

    expect(entries.map((entry) => entry.label)).toEqual(["Start", "Untitled section"]);
  });

  it("treats a draft heading with no level as headless (defensive)", () => {
    const noLevel: DocumentNodeJSON = {
      content: [{ text: "No level", type: "text" }],
      type: "heading"
    };
    const entries = projectDraftOutline(multiSections, "unit-a", docOf(noLevel));

    // unit-a's malformed heading carries no level, so it stays the leading "Start".
    expect(entries.map((entry) => entry.label)).toEqual(["Start", "Chapter One"]);
  });

  it("yields no draft units when the active section's draft has no content (defensive)", () => {
    // A malformed draft with no `content` array collapses the active section to zero units, leaving a lone
    // remaining section — which produces an empty outline rather than throwing.
    const entries = projectDraftOutline(multiSections, "unit-a", { type: "doc" });

    expect(entries).toEqual([]);
  });
});

describe("WorkOutline (drawer, < 80rem)", () => {
  it("marks the active section with aria-current and leaves the others unset", () => {
    renderOutline();

    expect(screen.getByRole("button", { name: "Start" }).getAttribute("aria-current")).toBe("true");
    expect(
      screen.getByRole("button", { name: "Chapter One" }).getAttribute("aria-current")
    ).toBeNull();
  });

  it("highlights the active path through the ancestors of a nested active section", () => {
    // Part One (H1) > Chapter One (H2) > Section One (H3), with a sibling Chapter Two off the path.
    const nested: readonly ManualWorkSectionDto[] = [
      { headingLevel: 1, orderIndex: 0, title: "Part One", unitEntryId: "unit-p" },
      { headingLevel: 2, orderIndex: 1, title: "Chapter One", unitEntryId: "unit-c1" },
      { headingLevel: 3, orderIndex: 2, title: "Section One", unitEntryId: "unit-s" },
      { headingLevel: 2, orderIndex: 3, title: "Chapter Two", unitEntryId: "unit-c2" }
    ];
    renderOutline({ activeUnitEntryId: "unit-s", entries: deriveWorkOutline(nested) });

    const section = screen.getByRole("button", { name: "Section One" });
    const chapterOne = screen.getByRole("button", { name: "Chapter One" });
    const partOne = screen.getByRole("button", { name: "Part One" });
    const chapterTwo = screen.getByRole("button", { name: "Chapter Two" });

    // Only the exact active section carries aria-current.
    expect(section.getAttribute("aria-current")).toBe("true");
    expect(chapterOne.getAttribute("aria-current")).toBeNull();
    expect(partOne.getAttribute("aria-current")).toBeNull();

    // The active section AND every ancestor up the derived chain are on the active path.
    expect(section.getAttribute("data-active-path")).toBe("true");
    expect(chapterOne.getAttribute("data-active-path")).toBe("true");
    expect(partOne.getAttribute("data-active-path")).toBe("true");

    // A sibling that is not an ancestor of the active section stays off the path.
    expect(chapterTwo.getAttribute("data-active-path")).toBeNull();
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

  it("renders nothing when there are no outline entries", () => {
    renderOutline({ entries: [] });

    expect(screen.queryByRole("navigation", { name: "Outline" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Outline" })).toBeNull();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("offers a targeted next action after Start", async () => {
    const { onAddSection } = renderOutline();

    fireEvent.click(screen.getByRole("button", { name: "Add next section after Start" }));
    expect(onAddSection).toHaveBeenCalledWith("next");
  });

  it("shows Adding only on the invoked action and disables the action group", () => {
    renderOutline({
      activeHeadingLevel: 1,
      activeUnitEntryId: "unit-b",
      addPending: "child"
    });

    const next = screen.getByRole("button", { name: "Add next section after Chapter One" });
    const child = screen.getByRole("button", { name: "Add subsection under Chapter One" });
    expect((next as HTMLButtonElement).disabled).toBe(true);
    expect((child as HTMLButtonElement).disabled).toBe(true);
    expect(next.textContent).toContain("Add next section");
    expect(child.textContent).toContain("Adding…");
  });

  it("places actions after the active descendant branch in next-then-child order", () => {
    const nested: readonly ManualWorkSectionDto[] = [
      { headingLevel: 1, orderIndex: 0, title: "Part One", unitEntryId: "unit-p" },
      { headingLevel: 2, orderIndex: 1, title: "Chapter One", unitEntryId: "unit-c1" },
      { headingLevel: 3, orderIndex: 2, title: "Section One", unitEntryId: "unit-s" },
      { headingLevel: 2, orderIndex: 3, title: "Chapter Two", unitEntryId: "unit-c2" }
    ];
    renderOutline({
      activeHeadingLevel: 2,
      activeUnitEntryId: "unit-c1",
      entries: deriveWorkOutline(nested)
    });

    const children = document.querySelectorAll(".workOutlineList > li");
    expect(children[2]?.textContent).toContain("Section One");
    expect(children[3]?.classList.contains("workOutlineActionsNode")).toBe(true);
    expect(children[4]?.textContent).toContain("Chapter Two");
    const actions = screen.getByRole("group", { name: "Section actions for Chapter One" });
    const buttons = actions.querySelectorAll("button");
    expect(buttons[0]?.textContent).toContain("Add next section");
    expect(buttons[1]?.textContent).toContain("Add subsection");
  });

  it("offers only next at H3 and no creation actions below H3", () => {
    const nested: readonly ManualWorkSectionDto[] = [
      { headingLevel: 1, orderIndex: 0, title: "Part", unitEntryId: "unit-p" },
      { headingLevel: 3, orderIndex: 1, title: "Section", unitEntryId: "unit-s" }
    ];
    const { unmount } = render(
      <WorkOutline
        activeHeadingLevel={3}
        activeUnitEntryId="unit-s"
        addPending={null}
        entries={deriveWorkOutline(nested)}
        onAddSection={async () => true}
        onSelect={() => {}}
      />
    );
    expect(screen.getByRole("button", { name: "Add next section after Section" })).toBeDefined();
    expect(screen.queryByRole("button", { name: /Add subsection/ })).toBeNull();

    unmount();
    renderOutline({
      activeHeadingLevel: 4,
      activeUnitEntryId: "unit-s",
      entries: deriveWorkOutline(nested)
    });
    expect(screen.queryByRole("group", { name: /Section actions/ })).toBeNull();
  });

  it("closes the drawer after a successful insertion but keeps it open after a refusal", async () => {
    const user = userEvent.setup();
    renderOutline();
    const toggle = screen.getByRole("button", { name: "Outline" });
    await user.click(toggle);
    await user.click(screen.getByRole("button", { name: "Add next section after Start" }));
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    cleanup();
    mockMatchMedia(false);
    renderOutline({ onAddSection: vi.fn(async () => false) });
    const refusedToggle = screen.getByRole("button", { name: "Outline" });
    await user.click(refusedToggle);
    await user.click(screen.getByRole("button", { name: "Add next section after Start" }));
    expect(refusedToggle.getAttribute("aria-expanded")).toBe("true");
  });
});

describe("WorkOutline (sidebar, >= 80rem)", () => {
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
