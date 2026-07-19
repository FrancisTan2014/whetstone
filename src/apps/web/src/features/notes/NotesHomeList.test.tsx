// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { NoteOverviewDto, NoteReviewSummaryDto } from "@whetstone/contracts";
import { createTextDocument } from "@whetstone/document";
import { toEntryId } from "@whetstone/domain";

import { NotesHomeList } from "./NotesHomeList";

function anchoredNote(overrides: Partial<NoteOverviewDto> = {}): NoteOverviewDto {
  return {
    anchor: {
      blockEntryId: toEntryId("block-1"),
      contextSnapshot: "context",
      endBlockEntryId: toEntryId("block-1"),
      selectedTextSnapshot: "the quick brown fox"
    },
    authorName: "Aesop",
    blockEntryId: toEntryId("block-1"),
    bodyDoc: createTextDocument("a body"),
    bodyText: "a body",
    captureSource: "reader",
    createdAt: "2024-01-01T00:00:00.000Z",
    entryId: toEntryId("note-1"),
    kind: "note",
    occurredAt: "2024-01-01T00:00:00.000Z",
    review: { status: "not_enrolled" },
    updatedAt: "2024-01-01T00:00:00.000Z",
    workEntryId: toEntryId("work-a"),
    workTitle: "Aesop Fables",
    ...overrides
  };
}

function standaloneNote(overrides: Partial<NoteOverviewDto> = {}): NoteOverviewDto {
  return {
    anchor: null,
    authorName: null,
    blockEntryId: null,
    bodyDoc: createTextDocument("a standalone thought"),
    bodyText: "a standalone thought",
    captureSource: "manual",
    createdAt: "2024-01-01T00:00:00.000Z",
    entryId: toEntryId("note-2"),
    kind: "note",
    occurredAt: "2024-01-01T00:00:00.000Z",
    review: { status: "not_enrolled" },
    updatedAt: "2024-01-01T00:00:00.000Z",
    workEntryId: null,
    workTitle: null,
    ...overrides
  };
}

function markNote(): NoteOverviewDto {
  return anchoredNote({
    bodyDoc: null,
    bodyText: null,
    entryId: toEntryId("mark-1"),
    kind: "mark",
    review: { status: "not_enrolled" }
  });
}

afterEach(() => {
  cleanup();
});

describe("NotesHomeList (#659)", () => {
  it("renders an anchored note with its source, work, review label, open and reader targets", () => {
    render(
      <NotesHomeList
        notes={[anchoredNote({ review: { dueCount: 2, status: "due" } })]}
        onOpen={vi.fn()}
        timeZone="UTC"
      />
    );

    expect(screen.getByText("“the quick brown fox”")).toBeDefined();
    expect(screen.getByText("Aesop Fables")).toBeDefined();
    expect(screen.getByText("Review due (2)")).toBeDefined();
    expect(screen.getByRole("button", { name: "Open note: the quick brown fox" })).toBeDefined();
    const reader = screen.getByRole("link", { name: "Open in Reader" });
    expect(reader.getAttribute("href")).toBe("#/reader?work=work-a&block=block-1");
  });

  it("renders a standalone note with body only and no reader link", () => {
    render(<NotesHomeList notes={[standaloneNote()]} onOpen={vi.fn()} timeZone="UTC" />);

    expect(screen.getByText("a standalone thought")).toBeDefined();
    expect(screen.queryByRole("link", { name: "Open in Reader" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open note: a standalone thought" })).toBeDefined();
  });

  it("renders a Mark with its quote and label but no body, review, or open control", () => {
    render(<NotesHomeList notes={[markNote()]} onOpen={vi.fn()} timeZone="UTC" />);

    expect(screen.getByText("Mark")).toBeDefined();
    expect(screen.getByText("“the quick brown fox”")).toBeDefined();
    expect(screen.queryByRole("button", { name: /Open note/ })).toBeNull();
    expect(screen.queryByText("Add to review")).toBeNull();
    // A Mark is still anchored, so it keeps its Open-in-Reader deep link.
    expect(screen.getByRole("link", { name: "Open in Reader" })).toBeDefined();
  });

  it.each<[string, NoteReviewSummaryDto, string]>([
    ["single due", { dueCount: 1, status: "due" }, "Review due"],
    ["scheduled", { nextReviewAt: "2026-03-03T00:00:00.000Z", status: "scheduled" }, "Next review"],
    ["paused", { status: "paused" }, "Paused"],
    ["not enrolled", { status: "not_enrolled" }, "Add to review"]
  ])("projects the %s review state onto the row", (_label, review, expected) => {
    render(<NotesHomeList notes={[standaloneNote({ review })]} onOpen={vi.fn()} timeZone="UTC" />);

    expect(screen.getByText(new RegExp(expected))).toBeDefined();
  });

  it("clamps a very long body into a single-line preview", () => {
    const long = `${"word ".repeat(60)}end`;
    render(
      <NotesHomeList notes={[standaloneNote({ bodyText: long })]} onOpen={vi.fn()} timeZone="UTC" />
    );

    const preview = screen.getByText(/word word/);
    expect(preview.textContent?.endsWith("…")).toBe(true);
    expect(preview.textContent?.length).toBeLessThanOrEqual(140);
  });

  it("previews an empty body as a blank string", () => {
    render(
      <NotesHomeList notes={[standaloneNote({ bodyText: null })]} onOpen={vi.fn()} timeZone="UTC" />
    );

    expect(screen.getByRole("button", { name: "Open note:" })).toBeDefined();
  });

  it("calls onOpen with the note when its Open control is pressed", async () => {
    const onOpen = vi.fn();
    const note = standaloneNote();
    render(<NotesHomeList notes={[note]} onOpen={onOpen} timeZone="UTC" />);

    await userEvent.click(screen.getByRole("button", { name: /Open note/ }));

    expect(onOpen).toHaveBeenCalledWith(note);
  });

  it("attaches the open ref only to the targeted row for focus restoration", () => {
    const ref = createRef<HTMLButtonElement>();
    render(
      <NotesHomeList
        notes={[standaloneNote(), standaloneNote({ entryId: toEntryId("note-3") })]}
        onOpen={vi.fn()}
        timeZone="UTC"
        openRef={ref}
        openTargetEntryId="note-3"
      />
    );

    expect(ref.current).not.toBeNull();
    expect(ref.current?.getAttribute("aria-label")).toBe("Open note: a standalone thought");
  });

  it("attaches no ref when the target row is not present", () => {
    const ref = createRef<HTMLButtonElement>();
    render(
      <NotesHomeList
        notes={[standaloneNote()]}
        onOpen={vi.fn()}
        timeZone="UTC"
        openRef={ref}
        openTargetEntryId={undefined}
      />
    );

    expect(ref.current).toBeNull();
  });

  it("uses 44px hit targets for the open and reader controls", () => {
    render(<NotesHomeList notes={[anchoredNote()]} onOpen={vi.fn()} timeZone="UTC" />);

    expect(screen.getByRole("button", { name: /Open note/ }).className).toContain("min-h-11");
    expect(screen.getByRole("link", { name: "Open in Reader" }).className).toContain("min-h-11");
  });
});
