import { describe, expect, it } from "vitest";

import {
  backfillEmphasisInstructions,
  buildBackfillProposalPrompt,
  buildProposalPrompt,
  classifyProposalDuplicate,
  DEFAULT_PROPOSAL_CONFIDENCE_THRESHOLD,
  evaluateProposalGate,
  isFaithfulQuote,
  MAX_POLICY_EXAMPLES,
  normalizeForMatch,
  PROPOSAL_PROMPT_VERSION,
  proposalPromptInstructions,
  selectPolicyExamples,
  type ReviewedProposalExample
} from "./makeDurable.js";
import { reviewedProposalExampleFixtures } from "./makeDurablePolicyFixtures.js";

describe("buildProposalPrompt", () => {
  it("carries the invariant instructions and the capture text", () => {
    const prompt = buildProposalPrompt("I couldn't say 'the deploy is rolling back'");

    for (const line of proposalPromptInstructions) {
      expect(prompt).toContain(line);
    }
    expect(prompt).toContain("Capture:\nI couldn't say 'the deploy is rolling back'");
  });

  it("renders the retrieved 'Already remembered' items so the model compares before proposing", () => {
    const prompt = buildProposalPrompt("the deploy rolled back", [
      { target: "It's back up now", useContext: "reporting availability" },
      { target: "by and large", useContext: null }
    ]);

    expect(prompt).toContain("Already remembered:");
    expect(prompt).toContain("- It's back up now — reporting availability");
    expect(prompt).toContain("- by and large");
    expect(proposalPromptInstructions.join(" ").toLowerCase()).toContain("already remembered");
  });

  it("shows an explicit empty marker when nothing is remembered yet", () => {
    expect(buildProposalPrompt("first capture")).toContain("Already remembered:\n(none yet)");
  });

  it("constrains output to zero or one candidate of the allowed types", () => {
    const joined = proposalPromptInstructions.join(" ");
    expect(joined).toContain("ZERO or ONE");
    expect(joined).toContain("phrase_chunk");
    expect(joined).toContain("couldnt_say_gap");
    expect(joined).toContain("recurring_pattern");
    expect(joined.toLowerCase()).toContain("verbatim");
  });

  it("pins a stable prompt version", () => {
    expect(PROPOSAL_PROMPT_VERSION).toBe("proposal-v1");
  });
});

describe("buildBackfillProposalPrompt", () => {
  it("carries the shared invariant instructions, the retrieval context, and the capture", () => {
    const prompt = buildBackfillProposalPrompt("an old capture I never mined", [
      { target: "It's back up now", useContext: "reporting availability" }
    ]);

    for (const line of proposalPromptInstructions) {
      expect(prompt).toContain(line);
    }
    expect(prompt).toContain("Already remembered:");
    expect(prompt).toContain("- It's back up now — reporting availability");
    expect(prompt).toContain("Capture:\nan old capture I never mined");
  });

  it("adds the high-value backfill bias (prefer reusable value, skip one-off spelling/product names)", () => {
    const prompt = buildBackfillProposalPrompt("capture");

    for (const line of backfillEmphasisInstructions) {
      expect(prompt).toContain(line);
    }
    const joined = backfillEmphasisInstructions.join(" ").toLowerCase();
    expect(joined).toContain("reusable");
    expect(joined).toContain("spelling");
    expect(joined).toContain("product");
  });

  it("adds bias the live proposal prompt does not carry", () => {
    for (const line of backfillEmphasisInstructions) {
      expect(buildProposalPrompt("capture")).not.toContain(line);
    }
  });
});

describe("selectPolicyExamples (#457)", () => {
  function example(overrides: Partial<ReviewedProposalExample>): ReviewedProposalExample {
    return {
      outcome: "saved",
      type: "phrase_chunk",
      category: "work",
      target: "a target",
      useContext: "some context",
      tags: [],
      ...overrides
    };
  }

  it("collapses duplicate targets to the most-recent (case/space-insensitive)", () => {
    const selected = selectPolicyExamples([
      example({ target: "Roll back the deploy", useContext: "newest" }),
      example({ target: "roll   back the deploy", useContext: "older duplicate" })
    ]);

    expect(selected).toHaveLength(1);
    expect(selected[0]?.useContext).toBe("newest");
  });

  it("round-robins across proposal types so no single type floods the set", () => {
    const selected = selectPolicyExamples(
      [
        example({ type: "phrase_chunk", target: "p1" }),
        example({ type: "phrase_chunk", target: "p2" }),
        example({ type: "phrase_chunk", target: "p3" }),
        example({ type: "recurring_pattern", target: "r1" }),
        example({ type: "couldnt_say_gap", target: "g1" })
      ],
      3
    );

    expect(selected.map((item) => item.type)).toEqual([
      "phrase_chunk",
      "couldnt_say_gap",
      "recurring_pattern"
    ]);
  });

  it("caps the result and defaults to MAX_POLICY_EXAMPLES", () => {
    const many = Array.from({ length: 20 }, (_unused, index) =>
      example({ target: `t${index}`, type: "phrase_chunk" })
    );

    expect(selectPolicyExamples(many, 2)).toHaveLength(2);
    expect(selectPolicyExamples(many)).toHaveLength(MAX_POLICY_EXAMPLES);
  });

  it("returns everything (deduped) when fewer than the cap and nothing for a non-positive cap", () => {
    const two = [example({ target: "a" }), example({ target: "b" })];

    expect(selectPolicyExamples(two, 6)).toHaveLength(2);
    expect(selectPolicyExamples(two, 0)).toEqual([]);
  });

  it("selects a bounded, deduped set from the shared fixture corpus", () => {
    const selected = selectPolicyExamples(reviewedProposalExampleFixtures);

    // The fixtures include a case-variant duplicate of "roll back the deploy" that collapses.
    expect(selected.length).toBeLessThanOrEqual(MAX_POLICY_EXAMPLES);
    const targets = selected.map((item) => normalizeForMatch(item.target));
    expect(new Set(targets).size).toBe(targets.length);
  });
});

describe("reviewed-example policy in the proposal prompt (#457)", () => {
  const examples: ReadonlyArray<ReviewedProposalExample> = [
    {
      outcome: "saved",
      type: "phrase_chunk",
      category: "work",
      target: "roll back the deploy",
      useContext: "incident updates",
      tags: ["ops"]
    },
    {
      outcome: "wrong_hallucinated",
      type: "recurring_pattern",
      category: "language",
      target: "much informations",
      useContext: "quantity phrasing",
      tags: []
    }
  ];

  it("includes a policy block instructing the model to follow past review decisions", () => {
    const prompt = buildProposalPrompt("today's capture", [], examples);

    expect(prompt).toContain("Policy from your past reviews");
    expect(prompt).toContain('[saved] phrase_chunk (work): "roll back the deploy"');
    expect(prompt).toContain("used when incident updates [tags: ops]");
    expect(prompt).toContain('[wrong_hallucinated] recurring_pattern (language): "much informations"');
    expect(prompt).toContain("do NOT propose items like those marked not_useful_now or wrong_hallucinated");
    // The capture and retrieval framing are preserved around the policy block.
    expect(prompt).toContain("Already remembered:");
    expect(prompt).toContain("Capture:\ntoday's capture");
  });

  it("omits the policy block entirely when there are no reviewed examples (fallback path)", () => {
    const withExamples = buildProposalPrompt("cap", [], examples);
    const fallback = buildProposalPrompt("cap", []);

    expect(fallback).not.toContain("Policy from your past reviews");
    expect(fallback).toBe(buildProposalPrompt("cap", [], []));
    expect(withExamples).not.toBe(fallback);
  });

  it("carries the policy into the backfill prompt alongside the high-value bias", () => {
    const prompt = buildBackfillProposalPrompt("old capture", [], examples);

    expect(prompt).toContain("Policy from your past reviews");
    for (const line of backfillEmphasisInstructions) {
      expect(prompt).toContain(line);
    }
  });
});

describe("normalizeForMatch", () => {
  it("trims, lowercases, and collapses internal whitespace", () => {
    expect(normalizeForMatch("  The   Deploy\n Rolled  Back ")).toBe("the deploy rolled back");
  });
});

describe("isFaithfulQuote", () => {
  it("accepts a verbatim span ignoring case and spacing", () => {
    expect(isFaithfulQuote("Rolling   BACK", "the deploy is rolling back now")).toBe(true);
  });

  it("rejects a fabricated or paraphrased quote", () => {
    expect(isFaithfulQuote("reverting the release", "the deploy is rolling back now")).toBe(false);
  });

  it("rejects a blank quote", () => {
    expect(isFaithfulQuote("   ", "anything")).toBe(false);
  });
});

describe("evaluateProposalGate", () => {
  const rawText = "I wanted to say the service is back up now but I couldn't";

  it("passes a confident, faithfully-quoted candidate", () => {
    expect(
      evaluateProposalGate({
        confidence: 0.9,
        evidenceQuote: "the service is back up now",
        rawText
      })
    ).toEqual({ visible: true });
  });

  it("hides a low-confidence candidate below the threshold", () => {
    expect(
      evaluateProposalGate({
        confidence: DEFAULT_PROPOSAL_CONFIDENCE_THRESHOLD - 0.01,
        evidenceQuote: "the service is back up now",
        rawText
      })
    ).toEqual({ reason: "low_confidence", visible: false });
  });

  it("hides a candidate whose evidence is not in the capture", () => {
    expect(
      evaluateProposalGate({ confidence: 0.95, evidenceQuote: "totally invented", rawText })
    ).toEqual({ reason: "unfaithful_quote", visible: false });
  });

  it("honors a custom threshold", () => {
    expect(
      evaluateProposalGate({
        confidence: 0.7,
        evidenceQuote: "the service is back up now",
        rawText,
        threshold: 0.8
      })
    ).toEqual({ reason: "low_confidence", visible: false });
  });
});

describe("classifyProposalDuplicate", () => {
  const proposed = { target: "It's back up now", useContext: "reporting service availability" };

  it("is unique when no existing item shares the target", () => {
    expect(
      classifyProposalDuplicate(proposed, [
        { target: "spill the beans", useContext: "casual chat" }
      ])
    ).toBe("unique");
  });

  it("flags same target + same context as a duplicate (case/space-insensitive)", () => {
    expect(
      classifyProposalDuplicate(proposed, [
        { target: "it's   BACK up now", useContext: "Reporting Service Availability" }
      ])
    ).toBe("same_target_same_context");
  });

  it("flags same target in a new context", () => {
    expect(
      classifyProposalDuplicate(proposed, [
        { target: "it's back up now", useContext: "telling a friend the wifi returned" }
      ])
    ).toBe("same_target_new_context");
  });

  it("treats a null existing context as empty", () => {
    expect(
      classifyProposalDuplicate({ target: "hi", useContext: "" }, [
        { target: "hi", useContext: null }
      ])
    ).toBe("same_target_same_context");
  });
});
