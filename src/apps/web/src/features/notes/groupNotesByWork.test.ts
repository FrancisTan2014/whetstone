import { describe, expect, it } from "vitest";

import type { NoteOverviewDto } from "@whetstone/contracts";
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
    answers: {},
    authorName,
    blockEntryId: toEntryId(`${entryId}-block`),
    entryId: toEntryId(entryId),
    markdown: `body ${entryId}`,
    templateId: "thought",
    workEntryId: toEntryId(workEntryId),
    workTitle
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
});
