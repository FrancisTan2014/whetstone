// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExplainRequest } from "@whetstone/contracts";
import { toEntryId } from "@whetstone/domain";

import { ExplainRequestError, fetchExplainCapability, requestExplanation } from "./explainApi";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const target: ExplainRequest = {
  blockEntryId: toEntryId("b1"),
  endOffset: 6,
  selectedText: "spring",
  startOffset: 0,
  workEntryId: toEntryId("w1")
};

describe("fetchExplainCapability", () => {
  it("requests the capability endpoint and validates the response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ enabled: true }),
      ok: true,
      status: 200
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await fetchExplainCapability()).toEqual({ enabled: true });
    expect(fetchMock).toHaveBeenCalledWith("/api/explain/capability");
  });

  it("parses a disabled capability with its remedy", async () => {
    const body = {
      enabled: false,
      reason: "feature_disabled",
      remedy: "Set AGENT_COPILOT_EXPLAIN_ENABLED=1."
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ json: () => Promise.resolve(body), ok: true, status: 200 })
    );

    expect(await fetchExplainCapability()).toEqual(body);
  });

  it("throws when the capability response is not ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ json: () => Promise.resolve({}), ok: false, status: 500 })
    );

    await expect(fetchExplainCapability()).rejects.toThrow("status 500");
  });
});

describe("requestExplanation", () => {
  it("posts the exact request body and validates an 'ok' response", async () => {
    const body = {
      provider: {},
      result: {
        currentBranchId: "only",
        currentFamilyId: "core",
        families: [
          {
            branches: [{ connection: "c", example: "e", id: "only", label: "l" }],
            coreImage: "core image",
            id: "core"
          }
        ],
        headword: "spring",
        language: "en"
      },
      status: "ok"
    };
    const fetchMock = vi.fn().mockResolvedValue({
      json: () => Promise.resolve(body),
      ok: true,
      status: 200
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await requestExplanation(target);

    expect(result).toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith("/api/explain", {
      body: JSON.stringify(target),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: undefined
    });
  });

  it("passes the given AbortSignal through to fetch", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ status: "disabled" }),
      ok: true,
      status: 200
    });
    vi.stubGlobal("fetch", fetchMock);

    await requestExplanation(target, controller.signal);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/explain",
      expect.objectContaining({ signal: controller.signal })
    );
  });

  it.each(["disabled", "not_found", "stale_selection", "timeout", "invalid_response"])(
    "parses the named '%s' outcome",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue({ json: () => Promise.resolve({ status }), ok: true, status: 200 })
      );

      expect(await requestExplanation(target)).toEqual({ status });
    }
  );

  it("parses the 'unavailable' outcome with its reason", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ reason: "transport_failed", status: "unavailable" }),
        ok: true,
        status: 200
      })
    );

    expect(await requestExplanation(target)).toEqual({
      reason: "transport_failed",
      status: "unavailable"
    });
  });

  it("throws ExplainRequestError for a 400 invalid_request, never as a typed status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ error: "invalid_request" }),
        ok: false,
        status: 400
      })
    );

    await expect(requestExplanation(target)).rejects.toThrow(ExplainRequestError);
  });

  it("throws a generic error for any other non-ok HTTP status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ json: () => Promise.resolve({}), ok: false, status: 503 })
    );

    await expect(requestExplanation(target)).rejects.toThrow("status 503");
  });
});
