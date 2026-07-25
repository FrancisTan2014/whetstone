import type {
  RelatedMaterialGroupDto,
  RelatedMaterialNoteDto
} from "@whetstone/contracts";
import { inArray } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { noteAnchors } from "../../db/schema.js";
import type { LexicalRelationGroup } from "../lexical/lexicalNoteQuery.js";

// Turn the lexical service's typed relation groups (#715) into the wire DTOs the New-card disclosure inspects
// (#716). Related material is an INSPECTION AID: each row carries only the saved word (the single-word surface
// that connected the note) and its capture context (the anchor's selected text) plus Open note — never a card
// count, a preselected card, a reuse action, or any save/schedule change. This layer writes nothing.

// A reader satisfied by both the top-level client and an open transaction.
type Reader = Pick<DbClient, "select">;

// Load each related note's capture context (its anchor selected-text snapshot) in ONE batched owner-safe
// query, so enrichment is O(1) round trips regardless of how many notes matched. A note with no anchor (a
// manually captured word) simply has no context. The note ids are already owner-scoped by the lexical query.
async function loadNoteContexts(
  reader: Reader,
  noteIds: ReadonlyArray<string>
): Promise<Map<string, string>> {
  if (noteIds.length === 0) {
    return new Map();
  }
  const rows = await reader
    .select({ noteEntryId: noteAnchors.noteEntryId, selectedText: noteAnchors.selectedText })
    .from(noteAnchors)
    .where(inArray(noteAnchors.noteEntryId, noteIds));
  return new Map(rows.map((row) => [row.noteEntryId, row.selectedText]));
}

// Map the service's owner-scoped relation groups to the response DTOs, enriched with each note's capture
// context. Group order and the per-relation cap are preserved exactly as the lexical query produced them
// (priority order, five per relation, stable id order) — never reordered here. The typed relation and its
// direction pass straight through; the `source` facet is internal evidence the UI does not need.
export async function enrichRelatedMaterialGroups(
  reader: Reader,
  groups: ReadonlyArray<LexicalRelationGroup>
): Promise<RelatedMaterialGroupDto[]> {
  const noteIds = groups.flatMap((group) => group.notes.map((note) => note.noteEntryId));
  const contexts = await loadNoteContexts(reader, noteIds);
  return groups.map((group) => ({
    relation: group.relation,
    direction: group.direction,
    notes: group.notes.map(
      (note): RelatedMaterialNoteDto => ({
        noteId: note.noteEntryId,
        word: note.surface,
        context: contexts.get(note.noteEntryId) ?? null
      })
    )
  }));
}
