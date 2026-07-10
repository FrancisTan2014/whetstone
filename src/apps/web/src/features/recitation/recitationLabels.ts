import type {
  RecitationCueStrengthDto,
  RecitationPhaseDto,
  RecitationSupportLevelDto
} from "@whetstone/contracts";

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

// The learner-facing name of each restrained cue a due passage can open from (#578): the previous
// passage's final line, or the target's first few characters. Asserted by the review-card tests.
export const recitationCueStrengthLabels: Readonly<Record<RecitationCueStrengthDto, string>> = {
  opening: "Opening",
  preceding_line: "Preceding line"
};

// The learner-facing name of each progressive-fading support level a due passage can open at (#579),
// ordered most-support to least. `full` shows the whole passage; `reduced` shows the first half of each
// clause; `first` shows each clause's first character or word; `hidden` shows none of the target and
// falls back to the external cue. Asserted by the review-card tests.
export const recitationSupportLevelLabels: Readonly<Record<RecitationSupportLevelDto, string>> = {
  first: "First characters",
  full: "Full text",
  hidden: "Hidden",
  reduced: "Reduced"
};
