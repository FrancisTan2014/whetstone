import { type DocumentNodeJSON, isValidDocument } from "@whetstone/document";
import { z } from "zod";

// The wire contracts for "Find related material" during New-card creation (#716). Related material is an
// explicit INSPECTION AID over the offline lexical service (#715): given an eligible single-word Answer, the
// learner opens the disclosure, chooses a sense, and inspects the owner's typed related saved Notes. It is
// NEVER a duplicate/identity decision — no relation or sense is persisted (v1), no card is preselected, and
// the save is untouched. All schemas mirror the pure lexical vocabulary from `@whetstone/domain` so a client
// renders the typed reason and direction without re-deriving them.

// A ProseMirror/Tiptap Answer document on the wire, validated against the shared document schema so a
// malformed body never crosses the boundary. The surface/eligibility is projected server-side (the same rule
// the lexical service applies), never trusted from the client.
const relatedMaterialDocumentSchema = z.custom<DocumentNodeJSON>(isValidDocument, {
  message: "must be a valid document."
});

// The four open English parts of speech the lexical service distinguishes (mirrors `LexicalPartOfSpeech`).
export const lexicalPartOfSpeechSchema = z.enum(["noun", "verb", "adjective", "adverb"]);

export type LexicalPartOfSpeechDto = z.infer<typeof lexicalPartOfSpeechSchema>;

// The typed one-hop relation reasons the service reports (mirrors `LexicalRelationType`). The disclosure maps
// each to a plain reason label ("same verb lemma", "synonym", "antonym", "derived form", "broader term",
// "narrower term"); `inflection` is labelled with the selected sense's part of speech.
export const lexicalRelationTypeSchema = z.enum([
  "inflection",
  "synonym",
  "antonym",
  "derivation",
  "hypernym",
  "hyponym"
]);

export type LexicalRelationTypeDto = z.infer<typeof lexicalRelationTypeSchema>;

// The asymmetry of a relation (mirrors `LexicalRelationDirection`): a hypernym is broader, a hyponym is
// narrower, everything else is lateral.
export const lexicalRelationDirectionSchema = z.enum(["lateral", "broader", "narrower"]);

export type LexicalRelationDirectionDto = z.infer<typeof lexicalRelationDirectionSchema>;

// One WordNet sense offered for EXPLICIT selection (#715 never auto-picks): its stable identity (offset +
// part of speech), gloss, examples, and single-word synonym keys. No related row appears before the learner
// selects one of these.
export const relatedMaterialSenseDtoSchema = z
  .object({
    offset: z.string(),
    partOfSpeech: lexicalPartOfSpeechSchema,
    definition: z.string(),
    examples: z.array(z.string()),
    lemmas: z.array(z.string())
  })
  .strict();

export type RelatedMaterialSenseDto = z.infer<typeof relatedMaterialSenseDtoSchema>;

// The selected sense a relations request relates FROM: its synset offset and the part of speech under which
// it was chosen. Echoed back so the disclosure can label an inflection with the correct part of speech.
export const relatedMaterialSenseRefSchema = z
  .object({ offset: z.string(), partOfSpeech: lexicalPartOfSpeechSchema })
  .strict();

export type RelatedMaterialSenseRef = z.infer<typeof relatedMaterialSenseRefSchema>;

// Request the senses of the drafted Answer (step 1). Only the Answer document is sent; its surface and
// eligibility are projected server-side by the same rule the save/lexical service applies.
export const relatedMaterialSensesRequestSchema = z
  .object({ answerDoc: relatedMaterialDocumentSchema })
  .strict();

export type RelatedMaterialSensesRequest = z.infer<typeof relatedMaterialSensesRequestSchema>;

// The four distinct sense outcomes so a corrupt/missing WordNet database never masquerades as "no relation"
// (mirrors the service `LexicalOutcome`): `found` carries the normalized surface and every sense; `not_found`
// is an eligible surface with no sense (an out-of-vocabulary word); `unsupported` is not one ASCII English
// word (a phrase, number, symbol, or non-ASCII script); `unavailable` is a genuine database read failure,
// never silence — the disclosure offers Retry and never blocks the save.
export const relatedMaterialSensesResponseSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("found"),
      surface: z.string(),
      senses: z.array(relatedMaterialSenseDtoSchema)
    })
    .strict(),
  z.object({ status: z.literal("not_found") }).strict(),
  z.object({ status: z.literal("unsupported") }).strict(),
  z.object({ status: z.literal("unavailable") }).strict()
]);

export type RelatedMaterialSensesResponse = z.infer<typeof relatedMaterialSensesResponseSchema>;

// Request the related saved Notes for a drafted Answer under one selected sense (step 2). The surface is
// re-projected from `answerDoc` server-side; the `sense` names which synset to relate from.
export const relatedMaterialRelationsRequestSchema = z
  .object({ answerDoc: relatedMaterialDocumentSchema, sense: relatedMaterialSenseRefSchema })
  .strict();

export type RelatedMaterialRelationsRequest = z.infer<typeof relatedMaterialRelationsRequestSchema>;

// One related saved Note: the owned note's id, the single-word surface that connected it (its saved word),
// and its capture context (the anchor's selected text) when it is anchored to a Work, else null. It offers
// Open note only — never Use existing material, a preselected card, or any save/schedule change.
export const relatedMaterialNoteDtoSchema = z
  .object({ noteId: z.string(), word: z.string(), context: z.string().nullable() })
  .strict();

export type RelatedMaterialNoteDto = z.infer<typeof relatedMaterialNoteDtoSchema>;

// One non-empty typed relation group: the relation, its direction, and up to five owned notes in stable id
// order (the service caps and orders them). The learner inspects; nothing is decided.
export const relatedMaterialGroupDtoSchema = z
  .object({
    relation: lexicalRelationTypeSchema,
    direction: lexicalRelationDirectionSchema,
    notes: z.array(relatedMaterialNoteDtoSchema)
  })
  .strict();

export type RelatedMaterialGroupDto = z.infer<typeof relatedMaterialGroupDtoSchema>;

// The relations outcome (mirrors the service `LexicalOutcome`). `found` carries the normalized surface, the
// selected synset lemma, and the selected part of speech (so the disclosure can render "born → bear · verb"
// and label an inflection), plus the typed groups (possibly empty — a silent no-result). The other statuses
// match the senses response: `not_found`/`unsupported` are silent, `unavailable` offers Retry, neither blocks
// the save.
export const relatedMaterialRelationsResponseSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("found"),
      surface: z.string(),
      selectedLemma: z.string(),
      partOfSpeech: lexicalPartOfSpeechSchema,
      groups: z.array(relatedMaterialGroupDtoSchema)
    })
    .strict(),
  z.object({ status: z.literal("not_found") }).strict(),
  z.object({ status: z.literal("unsupported") }).strict(),
  z.object({ status: z.literal("unavailable") }).strict()
]);

export type RelatedMaterialRelationsResponse = z.infer<
  typeof relatedMaterialRelationsResponseSchema
>;

export function parseRelatedMaterialSensesRequest(value: unknown): RelatedMaterialSensesRequest {
  return relatedMaterialSensesRequestSchema.parse(value);
}

export function parseRelatedMaterialSensesResponse(value: unknown): RelatedMaterialSensesResponse {
  return relatedMaterialSensesResponseSchema.parse(value);
}

export function parseRelatedMaterialRelationsRequest(
  value: unknown
): RelatedMaterialRelationsRequest {
  return relatedMaterialRelationsRequestSchema.parse(value);
}

export function parseRelatedMaterialRelationsResponse(
  value: unknown
): RelatedMaterialRelationsResponse {
  return relatedMaterialRelationsResponseSchema.parse(value);
}
