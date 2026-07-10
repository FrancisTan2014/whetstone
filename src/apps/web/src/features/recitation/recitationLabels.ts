import type { RecitationPhaseDto } from "@whetstone/contracts";

// Learner-facing copy for recitation routines (#577), kept out of the domain (which stays free of UI
// wording). The phase label names the routine stage on the Library adopt picker and the Today card; the
// hint is the calm, non-moralized one-line description shown while picking an initial phase. Both are
// exercised by the recitation component tests that assert the rendered wording.
export const recitationPhaseLabels: Readonly<Record<RecitationPhaseDto, string>> = {
  familiarizing: "Familiarizing",
  learning: "Learning",
  maintenance: "Maintenance"
};

export const recitationPhaseHints: Readonly<Record<RecitationPhaseDto, string>> = {
  familiarizing: "Calm daily reading for rhythm and beauty — no pressure to memorize yet.",
  learning: "Actively reciting, on your own schedule.",
  maintenance: "Keeping a work you already recite fresh."
};
