import type { LexicalRelationGroup, LexicalNoteReader } from "./lexicalNoteQuery.js";
import { findRelatedLexicalNotes } from "./lexicalNoteQuery.js";
import type { LexicalLemmatizer } from "./lexicalLemmatizer.js";
import {
  collectLexicalSenses,
  resolveSenseRelations,
  type LexicalSense,
  type LexicalSenseRef,
  type LexicalWordNet
} from "./wordnetLexicalProvider.js";

import { normalizeLexicalSurface } from "@whetstone/domain";

// The deterministic offline lexical-relationship service (#715). It sits between the injected WordNet seam,
// the morphology lemmatizer, and the owner-scoped note reader, and exposes two read-only operations: list a
// surface's senses for explicit selection, and — given one selected sense — return the owner's related
// single-word notes typed by one-hop morphology/WordNet relations. It never chooses a sense, and writes no
// lexical edge, sense, note, prompt, card, link, or event.

// Four distinct outcomes so a corrupt or missing WordNet database never masquerades as "no relation":
// - `unsupported` — the surface is not exactly one ASCII English word (a phrase, number, symbol, emoji, or
//   non-ASCII script), so lexical matching does not apply;
// - `not_found`   — an eligible surface with no WordNet sense (an out-of-vocabulary identifier), or a
//   selected sense the surface does not belong to;
// - `unavailable` — the WordNet database could not be read (a genuine file failure), never silence;
// - `found`       — senses or typed relations resolved.
export type LexicalOutcome<T> =
  | { readonly kind: "found"; readonly value: T }
  | { readonly kind: "not_found" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "unavailable" };

export type SenseResolution = Readonly<{ surface: string; senses: readonly LexicalSense[] }>;

export type LexicalNoteRelations = Readonly<{
  surface: string;
  selectedLemma: string;
  groups: readonly LexicalRelationGroup[];
}>;

export interface LexicalRelationService {
  resolveSenses(surface: string): Promise<LexicalOutcome<SenseResolution>>;
  relateNotes(
    db: LexicalNoteReader,
    surface: string,
    senseRef: LexicalSenseRef,
    params: Readonly<{ userId: string }>
  ): Promise<LexicalOutcome<LexicalNoteRelations>>;
}

export type LexicalRelationServiceDeps = Readonly<{
  wordnet: LexicalWordNet;
  lemmatize: LexicalLemmatizer;
}>;

export function createLexicalRelationService(
  deps: LexicalRelationServiceDeps
): LexicalRelationService {
  const { wordnet, lemmatize } = deps;

  async function resolveSenses(surface: string): Promise<LexicalOutcome<SenseResolution>> {
    const surfaceKey = normalizeLexicalSurface(surface);
    if (surfaceKey === null) {
      return { kind: "unsupported" };
    }
    let senses: LexicalSense[];
    try {
      senses = await collectLexicalSenses(wordnet, surfaceKey, lemmatize);
    } catch {
      return { kind: "unavailable" };
    }
    if (senses.length === 0) {
      return { kind: "not_found" };
    }
    return { kind: "found", value: { surface: surfaceKey, senses } };
  }

  async function relateNotes(
    db: LexicalNoteReader,
    surface: string,
    senseRef: LexicalSenseRef,
    params: Readonly<{ userId: string }>
  ): Promise<LexicalOutcome<LexicalNoteRelations>> {
    const surfaceKey = normalizeLexicalSurface(surface);
    if (surfaceKey === null) {
      return { kind: "unsupported" };
    }
    let context;
    try {
      context = await resolveSenseRelations(wordnet, surfaceKey, senseRef, lemmatize);
    } catch {
      return { kind: "unavailable" };
    }
    if (context === null) {
      return { kind: "not_found" };
    }
    const groups = await findRelatedLexicalNotes(db, context, lemmatize, params);
    return {
      kind: "found",
      value: { surface: surfaceKey, selectedLemma: context.selectedLemma, groups }
    };
  }

  return Object.freeze({ resolveSenses, relateNotes });
}
