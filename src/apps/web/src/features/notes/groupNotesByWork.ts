import type { NoteOverviewDto } from "@whetstone/contracts";

// A group of a user's notes. An anchored group carries the work it belongs to (title/author/id); the
// unanchored group (manual or Memory notes with no source, keyed by a `null` work) has all three
// `null` and renders body-only, without a work header or reader deep-link.
export type WorkNotes = Readonly<{
  authorName: string | null;
  notes: ReadonlyArray<NoteOverviewDto>;
  workEntryId: string | null;
  workTitle: string | null;
}>;

// Group the flat cross-work notes list by work for the Notes mode, preserving the order in which
// each work first appears (the server orders anchored notes by work title then note id, with
// unanchored notes last) and the note order within each group. Unanchored notes (no `workEntryId`)
// collect into a single `null`-keyed group.
export function groupNotesByWork(notes: ReadonlyArray<NoteOverviewDto>): ReadonlyArray<WorkNotes> {
  const order: Array<string | null> = [];
  const groups = new Map<
    string | null,
    {
      authorName: string | null;
      notes: NoteOverviewDto[];
      workEntryId: string | null;
      workTitle: string | null;
    }
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
      authorName: string | null;
      notes: NoteOverviewDto[];
      workEntryId: string | null;
      workTitle: string | null;
    };

    return {
      authorName: group.authorName,
      notes: group.notes,
      workEntryId: group.workEntryId,
      workTitle: group.workTitle
    };
  });
}
