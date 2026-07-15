import { describe, expect, it } from "vitest";

import type { NoteOverviewDto } from "@whetstone/contracts";
import { createTextDocument } from "@whetstone/document";
import { toEntryId } from "@whetstone/domain";

import { groupNotesByWork } from "./groupNotesByWork";

function note(
  entryId: string,
  workEntryId: string,
  workTitle: string,
  authorName: string
): NoteOverviewDto {
  return {
    anchor: {
      blockEntryId: toEntryId(`${entryId}-block`),
      contextSnapshot: "c",
      endBlockEntryId: toEntryId(`${entryId}-block`),
      selectedTextSnapshot: "s"
    },
    authorName,
    blockEntryId: toEntryId(`${entryId}-block`),
    bodyDoc: createTextDocument(`body ${entryId}`),
    bodyText: `body ${entryId}`,
    captureSource: "reader",
    createdAt: "2024-01-01T00:00:00.000Z",
    entryId: toEntryId(entryId),
    kind: "note",
    occurredAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    workEntryId: toEntryId(workEntryId),
    workTitle
  };
}

// An unanchored manual or Memory note: no source anchor, so no work context (all three work fields null).
function unanchoredNote(entryId: string): NoteOverviewDto {
  return {
    anchor: null,
    authorName: null,
    blockEntryId: null,
    bodyDoc: createTextDocument(`body ${entryId}`),
    bodyText: `body ${entryId}`,
    captureSource: "manual",
    createdAt: "2024-01-01T00:00:00.000Z",
    entryId: toEntryId(entryId),
    kind: "note",
    occurredAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    workEntryId: null,
    workTitle: null
  };
}

describe("groupNotesByWork", () => {
  it("returns no groups for an empty list", () => {
    expect(groupNotesByWork([])).toEqual([]);
  });

  it("groups notes by work, preserving work and within-work order", () => {
    const groups = groupNotesByWork([
      note("note-1", "work-a", "Aesop Fables", "Aesop"),
      note("note-2", "work-a", "Aesop Fables", "Aesop"),
      note("note-3", "work-b", "Zen Mind", "Shunryū")
    ]);

    expect(groups.map((group) => group.workEntryId)).toEqual(["work-a", "work-b"]);
    expect(groups[0]).toEqual({
      authorName: "Aesop",
      notes: [
        note("note-1", "work-a", "Aesop Fables", "Aesop"),
        note("note-2", "work-a", "Aesop Fables", "Aesop")
      ],
      workEntryId: "work-a",
      workTitle: "Aesop Fables"
    });
    expect(groups[1]?.notes.map((item) => item.entryId)).toEqual(["note-3"]);
  });

  it("collects unanchored notes into a single null-keyed group", () => {
    const groups = groupNotesByWork([
      note("note-1", "work-a", "Aesop Fables", "Aesop"),
      unanchoredNote("note-2"),
      unanchoredNote("note-3")
    ]);

    expect(groups.map((group) => group.workEntryId)).toEqual(["work-a", null]);
    expect(groups[1]).toEqual({
      authorName: null,
      notes: [unanchoredNote("note-2"), unanchoredNote("note-3")],
      workEntryId: null,
      workTitle: null
    });
  });
});
