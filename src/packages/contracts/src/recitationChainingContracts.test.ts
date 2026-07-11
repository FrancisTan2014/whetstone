import { describe, expect, it } from "vitest";

import {
  chainEligibilityDtoSchema,
  completeRecitationChainRequestSchema,
  parseCompleteRecitationChainRequest,
  parseRecitationChainingResponse,
  parseRecitationChainResponse,
  parseRecitationTodayResponse,
  parseReviewWholeWorkRequest,
  parseStartRecitationChainRequest,
  parseWholeWorkResponse,
  recitationChainingResponseSchema,
  recitationTodayResponseSchema,
  reviewWholeWorkRequestSchema,
  sessionRecallOutcomeSchema,
  startRecitationChainRequestSchema
} from "./recitationChainingContracts.js";

const chain = {
  chainId: "chain-1",
  endOrderIndex: 1,
  passages: [
    { orderIndex: 0, passageEntryId: "p1", sourceText: "Alpha" },
    { orderIndex: 1, passageEntryId: "p2", sourceText: "Beta" }
  ],
  planEntryId: "plan-1",
  status: "active" as const
};

const chaining = {
  activeChain: chain,
  chainEligibility: { maxEndIndex: 1, status: "eligible" as const },
  ownedPrefix: { ownedCount: 2, total: 3 },
  planEntryId: "plan-1",
  wholeWork: { due: false, dueAt: null, exists: false },
  wholeWorkOwned: false
};

describe("chainEligibilityDtoSchema", () => {
  it("accepts an eligible chain with a max end index", () => {
    expect(chainEligibilityDtoSchema.parse({ maxEndIndex: 2, status: "eligible" })).toEqual({
      maxEndIndex: 2,
      status: "eligible"
    });
  });

  it("accepts a not-eligible chain", () => {
    expect(chainEligibilityDtoSchema.parse({ status: "not_eligible" })).toEqual({
      status: "not_eligible"
    });
  });

  it("rejects an eligible chain missing its boundary", () => {
    expect(chainEligibilityDtoSchema.safeParse({ status: "eligible" }).success).toBe(false);
  });
});

describe("parseRecitationChainingResponse", () => {
  it("accepts full chaining progress", () => {
    expect(parseRecitationChainingResponse({ chaining })).toEqual({ chaining });
  });

  it("accepts progress with no active chain and started whole-work", () => {
    const value = {
      chaining: {
        ...chaining,
        activeChain: null,
        chainEligibility: { status: "not_eligible" as const },
        wholeWork: { due: true, dueAt: "2026-07-01T00:00:00.000Z", exists: true },
        wholeWorkOwned: true
      }
    };
    expect(parseRecitationChainingResponse(value)).toEqual(value);
  });

  it("rejects unknown keys", () => {
    expect(
      recitationChainingResponseSchema.safeParse({ chaining: { ...chaining, extra: 1 } }).success
    ).toBe(false);
  });
});

describe("parseStartRecitationChainRequest", () => {
  it("accepts a non-negative end index", () => {
    expect(parseStartRecitationChainRequest({ endOrderIndex: 1 })).toEqual({ endOrderIndex: 1 });
  });

  it("rejects a negative end index", () => {
    expect(startRecitationChainRequestSchema.safeParse({ endOrderIndex: -1 }).success).toBe(false);
  });
});

describe("parseRecitationChainResponse", () => {
  it("accepts an active chain", () => {
    expect(parseRecitationChainResponse({ chain })).toEqual({ chain });
  });

  it("accepts a completed chain", () => {
    const completed = { chain: { ...chain, status: "completed" as const } };
    expect(parseRecitationChainResponse(completed)).toEqual(completed);
  });
});

describe("sessionRecallOutcomeSchema", () => {
  it("accepts a held outcome", () => {
    expect(sessionRecallOutcomeSchema.parse({ status: "held" })).toEqual({ status: "held" });
  });

  it("accepts a broken outcome with the identified passage", () => {
    expect(sessionRecallOutcomeSchema.parse({ passageEntryId: "p2", status: "broke" })).toEqual({
      passageEntryId: "p2",
      status: "broke"
    });
  });

  it("rejects a broken outcome missing the passage id", () => {
    expect(sessionRecallOutcomeSchema.safeParse({ status: "broke" }).success).toBe(false);
  });
});

describe("parseCompleteRecitationChainRequest", () => {
  it("accepts a held completion", () => {
    expect(parseCompleteRecitationChainRequest({ outcome: { status: "held" } })).toEqual({
      outcome: { status: "held" }
    });
  });

  it("accepts a broken completion", () => {
    const value = { outcome: { passageEntryId: "p1", status: "broke" as const } };
    expect(parseCompleteRecitationChainRequest(value)).toEqual(value);
  });

  it("rejects unknown keys", () => {
    expect(
      completeRecitationChainRequestSchema.safeParse({ outcome: { status: "held" }, extra: 1 })
        .success
    ).toBe(false);
  });
});

describe("parseReviewWholeWorkRequest", () => {
  it("accepts an aggregate rating with a held outcome", () => {
    expect(parseReviewWholeWorkRequest({ outcome: { status: "held" }, rating: "good" })).toEqual({
      outcome: { status: "held" },
      rating: "good"
    });
  });

  it("accepts an aggregate rating with a targeted break", () => {
    const value = {
      outcome: { passageEntryId: "p3", status: "broke" as const },
      rating: "again" as const
    };
    expect(parseReviewWholeWorkRequest(value)).toEqual(value);
  });

  it("rejects an unknown rating", () => {
    expect(
      reviewWholeWorkRequestSchema.safeParse({ outcome: { status: "held" }, rating: "meh" }).success
    ).toBe(false);
  });
});

describe("parseWholeWorkResponse", () => {
  it("echoes the whole-work state", () => {
    const value = { wholeWork: { due: true, dueAt: "2026-07-01T00:00:00.000Z", exists: true } };
    expect(parseWholeWorkResponse(value)).toEqual(value);
  });
});

describe("parseRecitationTodayResponse", () => {
  it("accepts a due-passage action", () => {
    const value = {
      today: {
        action: "due_passage" as const,
        activeChain: null,
        planEntryId: "plan-1",
        workTitle: "Aesop"
      }
    };
    expect(parseRecitationTodayResponse(value)).toEqual(value);
  });

  it("accepts a chain action carrying the active chain", () => {
    const value = {
      today: { action: "chain" as const, activeChain: chain, planEntryId: "plan-1", workTitle: "W" }
    };
    expect(parseRecitationTodayResponse(value)).toEqual(value);
  });

  it("accepts a none action with null fields", () => {
    const value = {
      today: { action: "none" as const, activeChain: null, planEntryId: null, workTitle: null }
    };
    expect(parseRecitationTodayResponse(value)).toEqual(value);
  });

  it("rejects an unknown action", () => {
    expect(
      recitationTodayResponseSchema.safeParse({
        today: { action: "sing", activeChain: null, planEntryId: null, workTitle: null }
      }).success
    ).toBe(false);
  });
});
