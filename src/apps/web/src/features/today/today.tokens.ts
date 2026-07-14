/* v8 ignore file — pure token maps (routine kind → learner-facing copy and deep link), exercised via TodayPage behavior. */
import type { TodayRoutineKind } from "@whetstone/contracts";

// The calm human name for each deterministic routine Today groups into one Due-now row (#610).
export const todayRoutineTitles: Readonly<Record<TodayRoutineKind, string>> = {
  memory: "Memory review",
  recitation: "Recitation"
};

// The single action verb on each Due-now row. Recitation resumes the hub session; memory opens recall.
export const todayRoutineActionLabels: Readonly<Record<TodayRoutineKind, string>> = {
  memory: "Review",
  recitation: "Start"
};

// The owning feature each Due-now row deep-links into (#609 hub inline; recall for memory review).
export const todayRoutinePaths: Readonly<Record<TodayRoutineKind, string>> = {
  memory: "/recall",
  recitation: "/recitation"
};
