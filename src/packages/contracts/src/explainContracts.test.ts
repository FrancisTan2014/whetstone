import { describe, expect, it } from "vitest";

import {
  EXPLAIN_PROMPT_VERSION,
  explainCapabilitySchema,
  explainRequestSchema,
  explainResponseSchema,
  explainResultSchema,
  parseExplainCapability,
  parseExplainRequest,
  parseExplainResponse,
  parseExplainResult,
  type ExplainRequest,
  type ExplainResult
} from "./explainContracts.js";

function validRequest(overrides: Partial<ExplainRequest> = {}): Record<string, unknown> {
  return {
    blockEntryId: "11111111-1111-4111-8111-111111111111",
    endOffset: 7,
    selectedText: "hello",
    startOffset: 2,
    workEntryId: "22222222-2222-4222-8222-222222222222",
    ...overrides
  };
}

function validResult(overrides: Partial<ExplainResult> = {}): Record<string, unknown> {
  return {
    currentBranchId: "branch-1",
    currentFamilyId: "family-1",
    families: [
      {
        branches: [
          {
            connection: "extends the core image",
            example: "an example sentence",
            id: "branch-1",
            label: "one"
          }
        ],
        coreImage: "a shared core image",
        id: "family-1"
      }
    ],
    headword: "hello",
    language: "en",
    ...overrides
  };
}

describe("EXPLAIN_PROMPT_VERSION", () => {
  it("is a non-empty, stable identifier", () => {
    expect(EXPLAIN_PROMPT_VERSION.length).toBeGreaterThan(0);
  });
});

describe("explainRequestSchema", () => {
  it("accepts a well-formed request", () => {
    expect(() => parseExplainRequest(validRequest())).not.toThrow();
  });

  it("rejects endOffset not greater than startOffset", () => {
    expect(() => parseExplainRequest(validRequest({ endOffset: 2, startOffset: 2 }))).toThrow();
    expect(() => parseExplainRequest(validRequest({ endOffset: 1, startOffset: 2 }))).toThrow();
  });

  it("rejects a whitespace-only selectedText", () => {
    expect(() => parseExplainRequest(validRequest({ selectedText: "   " }))).toThrow();
  });

  it("rejects an empty selectedText", () => {
    expect(() => parseExplainRequest(validRequest({ selectedText: "" }))).toThrow();
  });

  it("rejects a selectedText longer than the bounded maximum", () => {
    expect(() => parseExplainRequest(validRequest({ selectedText: "a".repeat(301) }))).toThrow();
  });

  it("rejects a negative offset", () => {
    expect(() => parseExplainRequest(validRequest({ startOffset: -1 }))).toThrow();
  });

  it("rejects an unknown extra field", () => {
    expect(() => explainRequestSchema.parse({ ...validRequest(), extra: "nope" })).toThrow();
  });
});

describe("explainResultSchema", () => {
  it("accepts a well-formed single-family result", () => {
    expect(() => parseExplainResult(validResult())).not.toThrow();
  });

  it("accepts optional supporting fields when present", () => {
    expect(() =>
      parseExplainResult(
        validResult({
          culturalNote: "a real cultural connection",
          etymology: "a real historical connection",
          nuance: "formal register",
          pronunciation: [{ label: "IPA", value: "/heˈloʊ/" }],
          usageNote: "used as a greeting"
        })
      )
    ).not.toThrow();
  });

  it("rejects a duplicate family id", () => {
    const result = validResult() as Record<string, unknown>;
    const families = result.families as Array<Record<string, unknown>>;
    result.families = [families[0], { ...families[0] }];
    expect(() => parseExplainResult(result)).toThrow();
  });

  it("rejects a duplicate branch id across families", () => {
    const result = validResult() as Record<string, unknown>;
    const family = (result.families as Array<Record<string, unknown>>)[0]!;
    const branch = (family.branches as Array<Record<string, unknown>>)[0]!;
    result.families = [family, { ...family, id: "family-2", branches: [{ ...branch }] }];
    expect(() => parseExplainResult(result)).toThrow();
  });

  it("rejects a currentFamilyId that names no family", () => {
    expect(() => parseExplainResult(validResult({ currentFamilyId: "missing" }))).toThrow();
  });

  it("rejects a currentBranchId that names no branch", () => {
    expect(() => parseExplainResult(validResult({ currentBranchId: "missing" }))).toThrow();
  });

  it("rejects a pronunciation familyId that names no family", () => {
    expect(() =>
      parseExplainResult(
        validResult({ pronunciation: [{ familyId: "missing", label: "IPA", value: "/x/" }] })
      )
    ).toThrow();
  });

  it("rejects more than 4 families", () => {
    const family = (validResult() as Record<string, unknown>).families as Array<
      Record<string, unknown>
    >;
    const families = Array.from({ length: 5 }, (_, index) => ({
      ...family[0],
      id: `family-${index}`
    }));
    expect(() =>
      parseExplainResult({ ...validResult(), currentFamilyId: "family-0", families })
    ).toThrow();
  });

  it("rejects an unknown extra field (never silently salvaged)", () => {
    expect(() => explainResultSchema.parse({ ...validResult(), extra: "nope" })).toThrow();
  });
});

describe("explainResponseSchema", () => {
  it("round-trips every named status", () => {
    const okResponse = { provider: {}, result: validResult(), status: "ok" as const };
    expect(() => parseExplainResponse(okResponse)).not.toThrow();

    for (const status of [
      "disabled",
      "not_found",
      "stale_selection",
      "timeout",
      "invalid_response"
    ]) {
      expect(() => parseExplainResponse({ status })).not.toThrow();
    }

    for (const reason of ["startup_failed", "unsupported_model", "transport_failed"]) {
      expect(() => parseExplainResponse({ reason, status: "unavailable" })).not.toThrow();
    }
  });

  it("rejects an ok response whose result fails cross-reference validation", () => {
    expect(() =>
      explainResponseSchema.parse({
        provider: {},
        result: validResult({ currentFamilyId: "missing" }),
        status: "ok"
      })
    ).toThrow();
  });

  it("rejects an unknown status", () => {
    expect(() => parseExplainResponse({ status: "weird" })).toThrow();
  });

  it("carries observed provider attribution only when present", () => {
    const response = parseExplainResponse({
      provider: { model: "gpt-5.6-luna", reasoningEffort: "high" },
      result: validResult(),
      status: "ok"
    });
    expect(response).toMatchObject({
      provider: { model: "gpt-5.6-luna", reasoningEffort: "high" }
    });
  });
});

describe("explainCapabilitySchema", () => {
  it("accepts the enabled variant with no extra fields", () => {
    expect(() => parseExplainCapability({ enabled: true })).not.toThrow();
    expect(() => explainCapabilitySchema.parse({ enabled: true, reason: "nope" })).toThrow();
  });

  it("accepts the disabled variant with its reason and remedy", () => {
    expect(() =>
      parseExplainCapability({
        enabled: false,
        reason: "feature_disabled",
        remedy: "set the env var"
      })
    ).not.toThrow();
  });

  it("rejects a disabled variant missing its remedy", () => {
    expect(() =>
      explainCapabilitySchema.parse({ enabled: false, reason: "feature_disabled" })
    ).toThrow();
  });
});
