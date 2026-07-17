/* v8 ignore file — pure token maps (routine kind → learner-facing copy and deep link), exercised via TodayPage behavior. */
import type { TodayRoutineKind } from "@whetstone/contracts";

// The calm human name for each deterministic routine Today groups into one Due-now row (#610). The
// note-review routine reads due note prompts (#662): its learner-facing name is "Note review".
export const todayRoutineTitles: Readonly<Record<TodayRoutineKind, string>> = {
  memory: "Note review",
  recitation: "Recitation"
};

// The single action verb on each Due-now row. Recitation resumes the hub session; note review opens the
// Notes-owned Review session.
export const todayRoutineActionLabels: Readonly<Record<TodayRoutineKind, string>> = {
  memory: "Review",
  recitation: "Start"
};

// The owning feature each Due-now row deep-links into (#609 hub inline; the Notes-owned Review session for
// note review, #662).
export const todayRoutinePaths: Readonly<Record<TodayRoutineKind, string>> = {
  memory: "/notes/review",
  recitation: "/recitation"
};
