// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// #676: every surface that tells the learner when a card is next due renders the ONE shared next-review
// projection (`formatNextReviewLabel` in @whetstone/domain), resolved in the learner's persisted zone via
// `useLearnerTimeZone`. This structural guard locks that in place: no surface may reintroduce a
// feature-local date-only formatter or a `dueAt.slice(0, 10)` truncation that hides a same-day short-term
// interval behind a repeated calendar date — the exact defect this issue fixes.
//
// #700 consolidated the notes review surfaces (the old NoteReviewSettings / OwnedNoteReviewSection /
// NoteReviewSection) into the shared Note/Cards workspace: the next-due phrase now renders through the
// pure `cardState.ts` projection (a second indirection alongside the notes-list summary helper), and the
// learner zone is resolved by CardsView and handed down to CardDetail as a prop.

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

// The pure projections that own the shared next-review util call directly. They are plain modules (not
// components), so they carry no zone hook — the caller resolves the learner zone and passes it in.
const labelHelpers = ["./notes/noteReviewSummaryLabel.ts", "./notes/cardState.ts"] as const;

// Components that render a next-review calendar phrase in the learner's persisted zone. Each resolves the
// zone through `useLearnerTimeZone` and routes the projection through a shared owner — the domain util
// directly, or one of the pure helpers (the notes-list summary, or the card-state label).
const zoneAwareSurfaces = [
  "./notesReview/NotesReviewPage.tsx",
  "./recitation/RecitationReviewPage.tsx",
  "./recitation/RecitePage.tsx",
  "./today/TodayPage.tsx",
  "./notes/CardsView.tsx"
] as const;

// CardDetail also renders the card-state phrase, but receives the learner zone from CardsView as a prop
// rather than resolving it itself, so it is guarded against private formatters without the hook assertion.
const propZoneSurface = "./notes/CardDetail.tsx";

describe("one shared next-review label across every review surface (#676)", () => {
  for (const surface of zoneAwareSurfaces) {
    it(`${surface} renders the shared util, not a private date formatter`, () => {
      const source = code(surface);
      // Routes through a shared owner: the domain util directly, or a pure projection helper.
      expect(source).toMatch(/formatNextReviewLabel|cardStateLabel|noteReviewSummaryLabel/u);
      expect(source).toContain("useLearnerTimeZone");
    });
  }

  for (const helper of labelHelpers) {
    it(`${helper} is a pure indirection that calls the shared util`, () => {
      const source = code(helper);
      expect(source).toContain("formatNextReviewLabel");
      expect(source).toMatch(/from "@whetstone\/domain"/u);
    });
  }

  it("the short-term prefix is owned by the domain util, not restated on any surface", () => {
    for (const surface of [...zoneAwareSurfaces, ...labelHelpers, propZoneSurface]) {
      // Surfaces pass a `shortTerm` flag; the literal "Short-term review" text lives only in the util.
      expect(code(surface)).not.toContain("Short-term review");
    }
  });
});

describe("no surface reintroduces a date-only formatter or truncation (#676)", () => {
  const guardedSurfaces = [...zoneAwareSurfaces, ...labelHelpers, propZoneSurface] as const;

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
