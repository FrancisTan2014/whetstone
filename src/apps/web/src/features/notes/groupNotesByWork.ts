import type { NoteOverviewDto } from "@whetstone/contracts";

export type WorkNotes = Readonly<{
  authorName: string;
  notes: ReadonlyArray<NoteOverviewDto>;
  workEntryId: string;
  workTitle: string;
}>;

// Group the flat cross-work notes list by work for the Notes mode, preserving the order in which
// each work first appears (the server orders by work title then note id) and the note order within
// each work.
export function groupNotesByWork(notes: ReadonlyArray<NoteOverviewDto>): ReadonlyArray<WorkNotes> {
  const order: string[] = [];
  const groups = new Map<
    string,
    { authorName: string; notes: NoteOverviewDto[]; workEntryId: string; workTitle: string }
  >();

  for (const note of notes) {
    const existing = groups.get(note.workEntryId);

    if (existing === undefined) {
      order.push(note.workEntryId);
      groups.set(note.workEntryId, {
        authorName: note.authorName,
        notes: [note],
        workEntryId: note.workEntryId,
        workTitle: note.workTitle
      });
    } else {
      existing.notes.push(note);
    }
  }

  return order.map((id) => {
    const group = groups.get(id) as {
      authorName: string;
      notes: NoteOverviewDto[];
      workEntryId: string;
      workTitle: string;
    };

    return {
      authorName: group.authorName,
      notes: group.notes,
      workEntryId: group.workEntryId,
      workTitle: group.workTitle
    };
  });
}
