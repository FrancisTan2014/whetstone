/* v8 ignore file — pure token map (enum → learner-facing copy), exercised via RecitationHubPage behavior. */
import type { RecitationRoutineStageDto, RecitationTodayActionDto } from "@whetstone/contracts";

// The calm, human name for each routine stage shown in the hub (#608) — "where am I in this Work".
export const recitationStageLabels: Readonly<Record<RecitationRoutineStageDto, string>> = {
  chain: "Chaining passages",
  familiarize: "Familiarizing",
  learn_passage: "Learning passages",
  whole_work_maintenance: "Whole-work maintenance"
};

// The label for the single due-first primary action. `none` has no button, so it is excluded here.
export const recitationPrimaryActionLabels: Readonly<
  Record<Exclude<RecitationTodayActionDto, "none">, string>
> = {
  chain: "Continue chain",
  due_passage: "Start review",
  whole_work: "Whole-work review"
};
