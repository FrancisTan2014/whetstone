import type { WorkDuplicateMatchTierDto } from "@whetstone/contracts";
import type { WorkOrigin } from "@whetstone/domain";

// Human-readable labels for the duplicate-review panel (#747). Kept out of the component (like
// libraryMenu.tokens) so the panel's test asserts review semantics — which evidence and actions are
// shown, and what each action does — rather than restating these constant strings. Excluded from
// coverage. Every label is FACTUAL context (why a candidate surfaced, where it came from), never a
// "duplicate" verdict; the learner decides.
export const workDuplicateMatchTierLabels: Readonly<Record<WorkDuplicateMatchTierDto, string>> = {
  cross_author_fuzzy: "Similar title, different author",
  exact: "Exact title match",
  same_author_fuzzy: "Similar title, same author"
};

// A candidate Work's origin, shown as plain provenance context alongside its identity.
export const workOriginLabels: Readonly<Record<WorkOrigin, string>> = {
  authored: "Written by you",
  imported: "Imported",
  manual: "Manual"
};
