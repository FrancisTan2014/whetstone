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
    // Memory must go through the single note writer/cascade…
    expect(memoryCommands).toContain("insertNoteInTx");
    expect(memoryCommands).toContain("deleteNoteInTx");
    // …and must NOT duplicate a note's ownership/anchor inserts (that is the boundary's job). A second
    // writer here would be a parallel note facet. (Memory still inserts its own `memory_prompt` Entries.)
    expect(memoryCommands).not.toMatch(/insert\(personalEntries/u);
    expect(memoryCommands).not.toMatch(/insert\(noteAnchors/u);
  });

  it("the Note boundary is the single note-row inserter", () => {
    // Exactly one module inserts a `notes` row on capture: the Notes boundary. Memory and Reader both
    // compose `insertNoteInTx`; neither writes a `notes` INSERT of its own.
    const noteCommands = code("./noteCommands.ts");
    expect(noteCommands).toContain("insertNoteInTx");
    expect(noteCommands).toContain("tx.insert(notes)");
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
