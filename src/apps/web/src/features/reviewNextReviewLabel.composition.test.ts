// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// #676: every surface that tells the learner when a card is next due renders the ONE shared next-review
// projection (`formatNextReviewLabel` in @whetstone/domain), resolved in the learner's persisted zone via
// `useLearnerTimeZone`. This structural guard locks that in place: no surface may reintroduce a
// feature-local date-only formatter or a `dueAt.slice(0, 10)` truncation that hides a same-day short-term
// interval behind a repeated calendar date — the exact defect this issue fixes.

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

// Strip comments so the scan asserts on real code, not on prose that names the very anti-pattern it forbids
// (the doc comments above each surface mention "date-only" and "slice").
function code(relative: string): string {
  return read(relative)
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/\/\/[^\n]*/gu, "");
}

// Surfaces that render a next-review calendar phrase. Each must route through the shared util (directly, or
// via the notes summary helper) and carry the learner-zone hook, never a private formatter.
const labelSurfaces = [
  "./notesReview/NotesReviewPage.tsx",
  "./recitation/RecitationReviewPage.tsx",
  "./recitation/RecitePage.tsx",
  "./notes/NoteReviewSettings.tsx",
  "./notes/OwnedNoteReviewSection.tsx",
  "./notes/NoteReviewSection.tsx",
  "./today/TodayPage.tsx"
] as const;

// The notes list renders its per-note summary through this pure helper, which is the one that must call the
// shared util on the list's behalf.
const summaryHelper = "./notes/noteReviewSummaryLabel.ts";

describe("one shared next-review label across every review surface (#676)", () => {
  for (const surface of labelSurfaces) {
    it(`${surface} renders the shared util, not a private date formatter`, () => {
      const source = code(surface);
      expect(source).toContain("formatNextReviewLabel");
      expect(source).toMatch(/from "@whetstone\/domain"/u);
      expect(source).toContain("useLearnerTimeZone");
    });
  }

  it("the notes summary helper is the single indirection that calls the shared util", () => {
    const source = code(summaryHelper);
    expect(source).toContain("formatNextReviewLabel");
    expect(source).toMatch(/from "@whetstone\/domain"/u);
  });

  it("the short-term prefix is owned by the domain util, not restated on any surface", () => {
    for (const surface of labelSurfaces) {
      // Surfaces pass a `shortTerm` flag; the literal "Short-term review" text lives only in the util.
      expect(code(surface)).not.toContain("Short-term review");
    }
  });
});

describe("no surface reintroduces a date-only formatter or truncation (#676)", () => {
  const guardedSurfaces = [...labelSurfaces, summaryHelper] as const;

  for (const surface of guardedSurfaces) {
    it(`${surface} never truncates the instant with slice(0, 10)`, () => {
      expect(code(surface)).not.toMatch(/slice\(\s*0\s*,\s*10\s*\)/u);
    });

    it(`${surface} never formats a date locally`, () => {
      const source = code(surface);
      expect(source).not.toContain("toLocaleDateString");
      // A private helper by any of the removed names would be a second formatter; `formatNextReviewLabel`
      // is explicitly allowed (negative lookahead on the shared name).
      expect(source).not.toMatch(/formatNextReview(?!Label)/u);
      expect(source).not.toContain("formatReviewDate");
      expect(source).not.toContain("formatDueDate");
    });
  }
});
