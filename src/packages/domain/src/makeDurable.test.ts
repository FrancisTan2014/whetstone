import { describe, expect, it } from "vitest";

import {
  backfillEmphasisInstructions,
  buildBackfillProposalPrompt,
  buildProposalPrompt,
  classifyProposalDuplicate,
  DEFAULT_PROPOSAL_CONFIDENCE_THRESHOLD,
  evaluateProposalGate,
  isFaithfulQuote,
  normalizeForMatch,
  PROPOSAL_PROMPT_VERSION,
  proposalPromptInstructions
} from "./makeDurable.js";

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
