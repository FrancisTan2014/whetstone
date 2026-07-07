import type { ReviewedProposalExample } from "./makeDurable.js";

// A small, deterministic reviewed-example fixture set (#457) for evaluating Make Durable proposal
// policy/prompt changes without a real local model. It spans the review outcomes (saved / edited_saved /
// not_useful_now / wrong_hallucinated), all three proposal types, and several categories, ordered
// most-recent-first (as the retrieval query returns them). The final entry repeats an earlier target
// (different casing) so duplicate collapsing is exercised.
export const reviewedProposalExampleFixtures: ReadonlyArray<ReviewedProposalExample> = [
  {
    outcome: "saved",
    type: "phrase_chunk",
    category: "work",
    target: "roll back the deploy",
    useContext: "posting incident updates",
    tags: ["ops"]
  },
  {
    outcome: "wrong_hallucinated",
    type: "recurring_pattern",
    category: "language",
    target: "much informations",
    useContext: "talking about quantity",
    tags: []
  },
  {
    outcome: "edited_saved",
    type: "couldnt_say_gap",
    category: "daily_life",
    target: "it's back up now",
    useContext: "telling a friend the wifi works again",
    tags: []
  },
  {
    outcome: "not_useful_now",
    type: "phrase_chunk",
    category: "reading",
    target: "by and large",
    useContext: "summarizing a chapter",
    tags: ["formal"]
  },
  {
    outcome: "saved",
    type: "recurring_pattern",
    category: "language",
    target: "it depends on",
    useContext: "expressing a dependency",
    tags: []
  },
  {
    outcome: "saved",
    type: "phrase_chunk",
    category: "work",
    target: "Roll Back The Deploy",
    useContext: "an older duplicate with different casing",
    tags: []
  }
];
