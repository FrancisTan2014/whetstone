import { documentReadableText, type DocumentNodeJSON } from "@whetstone/document";
import {
  LEXICAL_RELATION_PRIORITY,
  lexicalRelationFacet,
  MAX_NOTES_PER_RELATION,
  normalizeLexicalSurface,
  toEntryId,
  type EntryId,
  type LexicalRelationDirection,
  type LexicalRelationSource,
  type LexicalRelationType
} from "@whetstone/domain";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { notes, personalEntries } from "../../db/schema.js";
import type { LexicalLemmatizer } from "./lexicalLemmatizer.js";
import { classifyContextRelation, type SenseRelationContext } from "./wordnetLexicalProvider.js";

// The owner-scoped, read-only query that turns a resolved sense into the owner's related single-word notes
// (#715). It surfaces candidates only; it writes no edge, sense, note, prompt, card, link, or event.

// One related note: its entry id and the single-word surface that connected it. The score/definition of the
// relation lives on the enclosing group, not here.
export type RelatedLexicalNote = Readonly<{ noteEntryId: EntryId; surface: string }>;

// A non-empty relation group: the typed relation, its direction and evidence source, and up to five owned
// notes in stable id order.
export type LexicalRelationGroup = Readonly<{
  relation: LexicalRelationType;
  direction: LexicalRelationDirection;
  source: LexicalRelationSource;
  notes: readonly RelatedLexicalNote[];
}>;

// The reader needs only the `select` builder, which both the top-level `DbClient` and an open transaction
// satisfy.
export type LexicalNoteReader = Pick<DbClient, "select">;

// An eligible single-word surface is at most this many code points once folded; the body-text length is a
// coarse SQL accelerator that keeps the reprojected pool to short notes (a passage can never be one word).
const MAX_SURFACE_BODY_LENGTH = 64;

// Project a stored note body to its eligible single-word surface key, or null when the note is not exactly
// one ASCII English word (a phrase, mixed script, or structured body).
function projectLexicalSurface(bodyDoc: unknown): string | null {
  return normalizeLexicalSurface(documentReadableText(bodyDoc as DocumentNodeJSON));
}

// Every owned single-word note connected to the selected sense by a typed one-hop relation, grouped by
// relation in priority order and capped at five per relation in stable id order.
//
// Ownership is scoped through the shared `personal_entries` facet; marks (bodyless) are excluded by `kind`;
// deleted notes are hard-deleted so absent; the queried surface itself (exact material) is dropped by the
// classifier. The `material_fingerprint`/length predicates only NARROW the candidate pool to body-bearing
// short notes — each candidate's surface is reprojected and typed in code, so the relation decision is never
// left to SQL. The query writes nothing.
export async function findRelatedLexicalNotes(
  db: LexicalNoteReader,
  context: SenseRelationContext,
  lemmatize: LexicalLemmatizer,
  params: Readonly<{ userId: string }>
): Promise<LexicalRelationGroup[]> {
  const rows = await db
    .select({ bodyDoc: notes.bodyDoc, entryId: notes.entryId })
    .from(notes)
    .innerJoin(personalEntries, eq(personalEntries.entryId, notes.entryId))
    .where(
      and(
        eq(notes.kind, "note"),
        eq(personalEntries.userId, params.userId),
        isNotNull(notes.materialFingerprint),
        sql`length(${notes.bodyText}) <= ${MAX_SURFACE_BODY_LENGTH}`
      )
    )
    .orderBy(asc(notes.entryId));

  const byRelation = new Map<LexicalRelationType, RelatedLexicalNote[]>();
  for (const row of rows) {
    const surface = projectLexicalSurface(row.bodyDoc);
    if (surface === null) {
      continue;
    }
    const relation = classifyContextRelation(context, surface, lemmatize);
    if (relation === null) {
      continue;
    }
    let bucket = byRelation.get(relation);
    if (bucket === undefined) {
      bucket = [];
      byRelation.set(relation, bucket);
    }
    if (bucket.length < MAX_NOTES_PER_RELATION) {
      bucket.push({ noteEntryId: toEntryId(row.entryId), surface });
    }
  }

  const groups: LexicalRelationGroup[] = [];
  for (const relation of LEXICAL_RELATION_PRIORITY) {
    const bucket = byRelation.get(relation);
    if (bucket !== undefined && bucket.length > 0) {
      const facet = lexicalRelationFacet(relation);
      groups.push({
        relation,
        direction: facet.direction,
        source: facet.source,
        notes: bucket
      });
    }
  }
  return groups;
}
