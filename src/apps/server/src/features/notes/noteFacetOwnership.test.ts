import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// #620: Reader notes and Memory notes are ONE durable object type behind ONE Notes-owned boundary. A Note
// is a pure content + ownership facet; scheduler mechanics (prompts, cards, events) live in Memory and the
// shared review substrate, never on the Note. These structural guards lock that separation in place so a
// future change cannot silently reintroduce a second note store, a parallel body writer, or a Note DTO
// that smuggles scheduler state.

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

// Strip line and block comments so a structural scan asserts on real code, not on prose that documents
// the very boundary being enforced (e.g. a comment explaining that scheduler fields never appear here).
function code(relative: string): string {
  return read(relative)
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/\/\/[^\n]*/gu, "");
}

describe("one unified note facet (#620)", () => {
  it("the schema declares no separate memory-note store", () => {
    const schema = read("../../db/schema.ts");
    // The dropped `memory_notes` table must not come back as a Drizzle export; every memory note now
    // lives in the single `notes` facet.
    expect(schema).not.toMatch(/export const memoryNotes\b/u);
    expect(schema).not.toContain('"memory_notes"');
  });

  it("the entry-type vocabulary no longer includes a memory-note type", () => {
    // A memory note IS a `note` Entry; a distinct `memory_note` entry type would mean two note types.
    // `memory_prompt` stays — a prompt is its own reviewable Entry.
    const schema = read("../../db/schema.ts");
    expect(schema).not.toContain('"memory_note"');
  });

  it("Memory composes the Notes boundary instead of writing note facets itself", () => {
    const memoryCommands = code("../memory/memoryCommands.ts");
    // Memory must go through the single note writer/cascade/body-updater…
    expect(memoryCommands).toContain("insertNoteInTx");
    expect(memoryCommands).toContain("deleteNoteInTx");
    expect(memoryCommands).toContain("updateNoteBodyInTx");
    // …and must NOT duplicate a note's ownership/anchor inserts, write its body columns directly, or
    // re-derive its readable projection (that is the boundary's job). Any of these would be a parallel
    // note-body writer/facet — the regression the reviewer flagged on the edit path. (Memory still inserts
    // its own `memory_prompt` Entries and bumps the note's chronology when it adds a prompt.)
    expect(memoryCommands).not.toMatch(/insert\(personalEntries/u);
    expect(memoryCommands).not.toMatch(/insert\(noteAnchors/u);
    expect(memoryCommands).not.toMatch(/update\(notes/u);
    expect(memoryCommands).not.toContain("documentReadableText");
  });

  it("the Note boundary is the single note-row inserter", () => {
    // Exactly one module inserts a `notes` row on capture: the Notes boundary. Memory and Reader both
    // compose `insertNoteInTx`; neither writes a `notes` INSERT of its own.
    const noteCommands = code("./noteCommands.ts");
    expect(noteCommands).toContain("insertNoteInTx");
    expect(noteCommands).toContain("tx.insert(notes)");
  });

  it("the Note boundary is the single note-body updater", () => {
    // Exactly one module updates a `notes` body: the Notes boundary's `updateNoteBodyInTx`. Reader edits
    // and Memory edits both compose it, so note-body derivation + persistence live in one place.
    const noteCommands = code("./noteCommands.ts");
    expect(noteCommands).toContain("updateNoteBodyInTx");
    expect(noteCommands).toMatch(/update\(notes/u);
  });
});

describe("owner-scoped Notes-home commands compose the single boundary (#659)", () => {
  it("standalone create, owner edit, and owner delete route through the shared in-tx primitives", () => {
    const noteCommands = code("./noteCommands.ts");
    // Each owner-scoped Notes-home command composes the one boundary primitive rather than writing note
    // facets itself — the same writer/cascade/body-updater Reader and Memory use — so a standalone note is
    // never a second note store or a parallel body path.
    expect(noteCommands).toMatch(/createStandaloneNote[\s\S]*?insertNoteInTx/u);
    expect(noteCommands).toMatch(/updateNoteForOwner[\s\S]*?updateNoteBodyInTx/u);
    expect(noteCommands).toMatch(/deleteNoteForOwner[\s\S]*?deleteNoteInTx/u);
  });

  it("the Notes-home Review summary derives only from prompt/card rows, never a persisted note column", () => {
    const noteQueries = code("./noteQueries.ts");
    // The rolled-up summary is computed from the note's `memory_prompts` + `review_cards`, never selected
    // from a column on the `notes` row — Review is behavior applied to a note, not part of it.
    expect(noteQueries).toContain("summarizeNoteReview");
    expect(noteQueries).toMatch(/memoryPrompts/u);
    expect(noteQueries).toMatch(/reviewCards/u);
    expect(noteQueries).not.toMatch(/notes\.review\b/u);
  });
});

describe("a Note DTO carries no scheduler state (#620)", () => {
  const scheduler = [
    "promptCount",
    "dueAt",
    "stability",
    "difficulty",
    "lifecycle",
    "reviewCard",
    "reps",
    "lapses",
    "fsrs"
  ] as const;

  for (const symbol of scheduler) {
    it(`the canonical note contract does not mention ${symbol}`, () => {
      const noteContracts = code("../../../../../packages/contracts/src/noteContracts.ts");
      expect(noteContracts).not.toContain(symbol);
    });
  }
});
