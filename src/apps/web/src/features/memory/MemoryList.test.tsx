// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MemoryNoteSummaryDto } from "@whetstone/contracts";

import { MemoryList } from "./MemoryList";

function makeSummary(overrides: Partial<MemoryNoteSummaryDto> = {}): MemoryNoteSummaryDto {
  return {
    bodyText: "spill the beans",
    captureSource: "manual",
    draftCount: 0,
    dueCount: 0,
    nextDueAt: null,
    noteId: "note-1",
    promptCount: 1,
    scheduledCount: 1,
    ...overrides
  };
}

afterEach(() => {
  cleanup();
});

describe("MemoryList", () => {
  it("shows the caller's empty message and no list when there are no notes", () => {
    render(<MemoryList emptyMessage="No matches." notes={[]} onSelect={vi.fn()} />);

    expect(screen.getByText("No matches.")).toBeDefined();
    expect(screen.queryByRole("list", { name: "Your memory" })).toBeNull();
  });

  it("renders each fragment with its capture label, prompt count, and state chip", () => {
    render(
      <MemoryList
        emptyMessage="No matches."
        notes={[
          makeSummary({ captureSource: "manual", dueCount: 3, noteId: "note-1" }),
          makeSummary({
            bodyText: "from a book",
            captureSource: "reader",
            dueCount: 0,
            noteId: "note-2",
            promptCount: 0,
            scheduledCount: 0
          })
        ]}
        onSelect={vi.fn()}
      />
    );

    const first = screen.getByText("spill the beans").closest("button") as HTMLElement;
    expect(within(first).getByText("Added by you")).toBeDefined();
    expect(within(first).getByText("1 prompt")).toBeDefined();
    expect(within(first).getByText("3 due")).toBeDefined();

    const second = screen.getByText("from a book").closest("button") as HTMLElement;
    expect(within(second).getByText("From reading")).toBeDefined();
    expect(within(second).getByText("No prompts")).toBeDefined();
    expect(within(second).getByText("Draft")).toBeDefined();
  });

  it("calls onSelect with the note id when a row is activated", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<MemoryList emptyMessage="No matches." notes={[makeSummary()]} onSelect={onSelect} />);

    await user.click(screen.getByText("spill the beans"));

    expect(onSelect).toHaveBeenCalledWith("note-1");
  });

  it("reuses the empty message across identical parent rerenders (memo cache-hit)", () => {
    const onSelect = vi.fn();
    const empty: MemoryNoteSummaryDto[] = [];
    const view = render(
      <MemoryList emptyMessage="No matches." notes={empty} onSelect={onSelect} />
    );
    view.rerender(<MemoryList emptyMessage="No matches." notes={empty} onSelect={onSelect} />);
    view.rerender(<MemoryList emptyMessage="No matches." notes={empty} onSelect={onSelect} />);

    expect(screen.getByText("No matches.")).toBeDefined();
  });

  it("reuses the rendered list across identical parent rerenders (memo cache-hit)", () => {
    const onSelect = vi.fn();
    const notesA = [makeSummary()];
    const notesB = [makeSummary({ bodyText: "second fragment", noteId: "note-2" })];
    const view = render(
      <MemoryList emptyMessage="No matches." notes={notesA} onSelect={onSelect} />
    );
    // Same references: exercises the list/wrapper memo cache-hit.
    view.rerender(<MemoryList emptyMessage="No matches." notes={notesA} onSelect={onSelect} />);
    // New notes but the same onSelect: exercises the row-callback memo cache-hit.
    view.rerender(<MemoryList emptyMessage="No matches." notes={notesB} onSelect={onSelect} />);

    expect(screen.getByText("second fragment")).toBeDefined();
  });
});
