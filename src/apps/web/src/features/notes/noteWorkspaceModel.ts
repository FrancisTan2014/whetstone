import type { DocumentNodeJSON } from "@whetstone/document";

// The immutable source a saved note was captured from: the exact selected text plus, when the owning work
// and anchored block are both known, a Reader deep-link. A standalone note has no source (`null`). Kept
// origin-agnostic so Reader and Notes build one disclosure from the same shape.
export type NoteWorkspaceSource = Readonly<{
  snapshot: string;
  blockEntryId: string | null;
  workEntryId: string | null;
}>;

// A persisted note the workspace drives: its stable entry id, its canonical body, and the source it was
// captured from (`null` for a standalone note). The source's presence is the single signal for source
// disclosure and whether Cards enrollment reuses the source. The Cards hierarchy needs only `entryId`
// (owner-scoped, prompt-id based) so this one handle serves an anchored Reader note and a standalone
// Notes-home note identically.
export type NoteWorkspaceHandle = Readonly<{
  bodyDoc: DocumentNodeJSON;
  entryId: string;
  source: NoteWorkspaceSource | null;
}>;

// What the workspace opens on: a brand-new capture (Note only until first save) carrying just its source
// context, or an existing persisted note (Note + Cards). Notes-home only ever edits; Reader capture is the
// sole `create` producer.
export type NoteWorkspaceTarget =
  | Readonly<{ kind: "create"; source: NoteWorkspaceSource | null }>
  | Readonly<{ kind: "edit"; note: NoteWorkspaceHandle }>;

// The origin-specific persistence the workspace calls, so Reader (work-scoped note commands over an
// `AnchoredNoteDto`) and Notes-home (owner-scoped commands over a standalone note) share ONE editor
// without forking. `save` persists the current body — creating on the first call, updating thereafter —
// and returns the persisted handle; `remove` runs the origin's atomic delete cascade. Neither closes the
// Sheet: the workspace owns the create→edit transition and the origin only refreshes its own view through
// the `onSaved`/`onDeleted` notifications.
export type NoteWorkspaceOps = Readonly<{
  remove: (entryId: string) => Promise<void>;
  save: (
    bodyDoc: DocumentNodeJSON,
    current: NoteWorkspaceHandle | null
  ) => Promise<NoteWorkspaceHandle>;
}>;

// The Reader deep-link for a source, or `null` when the work or block is unknown (a standalone note, or a
// capture not yet persisted to a block). Built here so the disclosure never assembles a broken link.
export function readerLinkFor(source: NoteWorkspaceSource | null): string | null {
  if (source === null || source.workEntryId === null || source.blockEntryId === null) {
    return null;
  }
  return `#/reader?work=${encodeURIComponent(source.workEntryId)}&block=${encodeURIComponent(
    source.blockEntryId
  )}`;
}
