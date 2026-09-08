// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExplainRequest, ExplainResponse, ExplainResult } from "@whetstone/contracts";
import { toEntryId } from "@whetstone/domain";

vi.mock("./explainApi", () => ({
  ExplainRequestError: class ExplainRequestError extends Error {},
  fetchExplainCapability: vi.fn(),
  requestExplanation: vi.fn()
}));

import { ExplainRequestError, fetchExplainCapability, requestExplanation } from "./explainApi";
import { ExplainSection } from "./ExplainSection";

const mockedFetchCapability = vi.mocked(fetchExplainCapability);
const mockedRequestExplanation = vi.mocked(requestExplanation);

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const target: ExplainRequest = {
  blockEntryId: toEntryId("b1"),
  endOffset: 6,
  selectedText: "spring",
  startOffset: 0,
  workEntryId: toEntryId("w1")
};

// Two truly unrelated sense families (a homograph) with the second family's second branch marked as
// the current one — proves multi-family rendering, multi-branch rendering, and the "Used here" marker
// together. Carries every optional field so a separate test can prove they render, and a second,
// minimal fixture (below) proves they are absent when the response omits them.
const springResult: ExplainResult = {
  currentBranchId: "device-leap",
  currentFamilyId: "device",
  etymology: "From Old English springan.",
  families: [
    {
      branches: [
        {
          connection: "the calendar season itself",
          example: "Spring arrived early.",
          id: "season-arrival",
          label: "the season"
        }
      ],
      coreImage: "the season of renewal",
      id: "season"
    },
    {
      branches: [
        {
          connection: "a coiled part that pushes back",
          example: "The spring in the clock broke.",
          id: "device-coil",
          label: "mechanical coil"
        },
        {
          connection: "to move suddenly like a released coil",
          example: "The cat sprang from the shelf.",
          id: "device-leap",
          label: "leap suddenly"
        }
      ],
      coreImage: "a coiled mechanism",
      id: "device"
    }
  ],
  headword: "spring",
  language: "en",
  nuance: "Neutral in every sense.",
  pronunciation: [{ label: "IPA", value: "/spr\u026a\u014b/" }],
  culturalNote: "Associated with renewal festivals.",
  usageNote: "Common in everyday weather talk."
};

// A response with only `etymology` supplied among the optional fields — combined with the fixture
// above (which supplies `culturalNote` but not `etymology`), together these prove each field's
// presence AND absence render correctly, independent of any other field.
const minimalResult: ExplainResult = {
  currentBranchId: "only",
  currentFamilyId: "core",
  families: [
    {
      branches: [{ connection: "c", example: "e", id: "only", label: "l" }],
      coreImage: "core image",
      id: "core"
    }
  ],
  headword: "x",
  language: "en"
};

const originOnlyResult: ExplainResult = {
  ...minimalResult,
  etymology: "From an unrelated, separately attested root."
};

// A response that supplies an explicitly empty pronunciation array (a legitimate, distinct-from-absent
// contract value, per `explainContracts.ts`) alongside one other supporting field (and no nuance or
// usage note) — proves the empty array renders no pronunciation row, that an absent nuance/usage
// render no such rows, while the rest of the details section still renders.
const emptyPronunciationResult: ExplainResult = {
  ...minimalResult,
  culturalNote: "Associated with renewal festivals in some regions.",
  pronunciation: []
};

function renderReady(): void {
  mockedFetchCapability.mockResolvedValue({ enabled: true });
  render(<ExplainSection target={target} />);
}

describe("ExplainSection", () => {
  it("shows a checking state, never sending a request before capability resolves", () => {
    mockedFetchCapability.mockReturnValue(new Promise(() => {}));
    render(<ExplainSection target={target} />);

    expect(screen.getByRole("status").textContent).toContain("Checking");
    expect(mockedRequestExplanation).not.toHaveBeenCalled();
  });

  it("shows the exact remedy and no action button when the capability is disabled", async () => {
    mockedFetchCapability.mockResolvedValue({
      enabled: false,
      reason: "feature_disabled",
      remedy: "Set AGENT_COPILOT_EXPLAIN_ENABLED=1."
    });
    render(<ExplainSection target={target} />);

    expect(await screen.findByText(/Set AGENT_COPILOT_EXPLAIN_ENABLED=1\./)).toBeDefined();
    expect(screen.queryByRole("button")).toBeNull();
    expect(mockedRequestExplanation).not.toHaveBeenCalled();
  });

  it("shows the consent text and action button once capability resolves enabled, and never requests before the click", async () => {
    renderReady();

    expect(await screen.findByRole("button", { name: "Explain meanings" })).toBeDefined();
    expect(
      screen.getByText(/sends this selected text to Copilot, an external AI provider/)
    ).toBeDefined();
    expect(mockedRequestExplanation).not.toHaveBeenCalled();
  });

  it("shows a capability_error message with a retry when the capability probe rejects", async () => {
    mockedFetchCapability.mockRejectedValue(new Error("network down"));
    mockedRequestExplanation.mockResolvedValue({
      status: "ok",
      provider: {},
      result: minimalResult
    });
    render(<ExplainSection target={target} />);

    expect(
      await screen.findByText("Could not check whether Explain meanings is available.")
    ).toBeDefined();
    const retry = screen.getByRole("button", { name: "Try again" });

    fireEvent.click(retry);
    await waitFor(() =>
      expect(mockedRequestExplanation).toHaveBeenCalledWith(target, expect.anything())
    );
  });

  it("shows loading, then the organizing map with the current family/branch marked and optional fields rendered", async () => {
    let resolveRequest: (response: ExplainResponse) => void = () => undefined;
    mockedRequestExplanation.mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve;
      })
    );
    renderReady();

    fireEvent.click(await screen.findByRole("button", { name: "Explain meanings" }));
    expect(screen.getByRole("status").textContent).toContain("Asking Copilot");
    // The button disappears while a request is pending, so a repeated click cannot start a duplicate.
    expect(screen.queryByRole("button")).toBeNull();

    await act(async () => {
      resolveRequest({
        provider: { model: "fixture-model", reasoningEffort: "high" },
        result: springResult,
        status: "ok"
      });
    });

    expect(screen.getByText("the season of renewal")).toBeDefined();
    expect(screen.getByText("a coiled mechanism")).toBeDefined();
    expect(screen.getByText("leap suddenly").closest("li")?.textContent).toContain("Used here");
    expect(screen.getByText("mechanical coil").closest("li")?.textContent).not.toContain(
      "Used here"
    );
    expect(screen.getByText("the season").closest("li")?.textContent).not.toContain("Used here");
    expect(screen.getByText("/spr\u026a\u014b/")).toBeDefined();
    expect(screen.getByText("Neutral in every sense.")).toBeDefined();
    expect(screen.getByText("From Old English springan.")).toBeDefined();
    expect(screen.getByText("Common in everyday weather talk.")).toBeDefined();
    expect(screen.getByText("Associated with renewal festivals.")).toBeDefined();
    expect(screen.getByText("fixture-model · high")).toBeDefined();
  });

  it("renders no optional-detail rows and no provider footer when the response omits them", async () => {
    mockedRequestExplanation.mockResolvedValue({
      provider: {},
      result: minimalResult,
      status: "ok"
    });
    renderReady();

    fireEvent.click(await screen.findByRole("button", { name: "Explain meanings" }));
    await screen.findByText("core image");

    expect(screen.queryByText("Nuance")).toBeNull();
    expect(screen.queryByText("Usage")).toBeNull();
    expect(screen.queryByText("Origin")).toBeNull();
    expect(screen.queryByText("Culture")).toBeNull();
    expect(document.querySelector(".explainProvider")).toBeNull();
  });

  it("renders no pronunciation row for an explicitly empty pronunciation array, and no Nuance/Usage rows when absent, while still rendering other supplied details", async () => {
    mockedRequestExplanation.mockResolvedValue({
      provider: {},
      result: emptyPronunciationResult,
      status: "ok"
    });
    renderReady();

    fireEvent.click(await screen.findByRole("button", { name: "Explain meanings" }));

    expect(
      await screen.findByText("Associated with renewal festivals in some regions.")
    ).toBeDefined();
    expect(screen.queryByText("IPA")).toBeNull();
    expect(screen.queryByText("Nuance")).toBeNull();
    expect(screen.queryByText("Usage")).toBeNull();
  });

  it("renders the Origin row alone when only etymology is supplied, with no Culture row", async () => {
    mockedRequestExplanation.mockResolvedValue({
      provider: {},
      result: originOnlyResult,
      status: "ok"
    });
    renderReady();

    fireEvent.click(await screen.findByRole("button", { name: "Explain meanings" }));

    expect(await screen.findByText("From an unrelated, separately attested root.")).toBeDefined();
    expect(screen.queryByText("Culture")).toBeNull();
    expect(screen.queryByText("Nuance")).toBeNull();
    expect(screen.queryByText("Usage")).toBeNull();
  });

  it.each([
    ["not_found", "This passage could not be found. It may have been removed."],
    [
      "stale_selection",
      "The passage changed since you selected it. Select the text again to explain it."
    ],
    ["timeout", "The explanation is taking too long. Try again in a moment."],
    ["invalid_response", "Copilot returned an answer that could not be understood."]
  ] as const)("truthfully renders the '%s' outcome", async (status, message) => {
    mockedRequestExplanation.mockResolvedValue({ status } as ExplainResponse);
    renderReady();

    fireEvent.click(await screen.findByRole("button", { name: "Explain meanings" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", message);
    expect(screen.getByRole("button", { name: "Try again" })).toBeDefined();
  });

  it.each([
    ["startup_failed", "Copilot could not start. Check the setup and try again."],
    ["unsupported_model", "The configured Copilot model is not supported for this request."],
    ["transport_failed", "Could not reach Copilot. Check your connection and try again."]
  ] as const)("truthfully renders the unavailable/%s reason", async (reason, message) => {
    mockedRequestExplanation.mockResolvedValue({ reason, status: "unavailable" });
    renderReady();

    fireEvent.click(await screen.findByRole("button", { name: "Explain meanings" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", message);
  });

  it("treats a race where capability flips to disabled mid-flight as a generic request failure", async () => {
    mockedRequestExplanation.mockResolvedValue({ status: "disabled" });
    renderReady();

    fireEvent.click(await screen.findByRole("button", { name: "Explain meanings" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Something went wrong requesting the explanation."
    );
  });

  it("maps an ExplainRequestError (a malformed request) to the invalid_response message", async () => {
    mockedRequestExplanation.mockRejectedValue(new ExplainRequestError("bad"));
    renderReady();

    fireEvent.click(await screen.findByRole("button", { name: "Explain meanings" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Copilot returned an answer that could not be understood."
    );
  });

  it("maps a generic network/HTTP failure to the request_failed message", async () => {
    mockedRequestExplanation.mockRejectedValue(new Error("network error"));
    renderReady();

    fireEvent.click(await screen.findByRole("button", { name: "Explain meanings" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Something went wrong requesting the explanation."
    );
  });

  it("aborts an in-flight request when unmounted, so a later resolution cannot paint a stale answer", async () => {
    let capturedSignal: AbortSignal | undefined;
    mockedFetchCapability.mockResolvedValue({ enabled: true });
    mockedRequestExplanation.mockImplementation((_request, signal) => {
      capturedSignal = signal;
      return new Promise(() => {});
    });
    const { unmount } = render(<ExplainSection target={target} />);

    fireEvent.click(await screen.findByRole("button", { name: "Explain meanings" }));
    expect(capturedSignal?.aborted).toBe(false);

    unmount();
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("ignores a capability check that resolves after the component has already unmounted", async () => {
    let resolveCapability: (capability: { enabled: true }) => void = () => undefined;
    mockedFetchCapability.mockReturnValue(
      new Promise((resolve) => {
        resolveCapability = resolve;
      })
    );
    const { unmount } = render(<ExplainSection target={target} />);

    unmount();

    // Resolving after unmount must not throw or update any (now-gone) state.
    expect(() => {
      act(() => {
        resolveCapability({ enabled: true });
      });
    }).not.toThrow();
  });

  it("ignores a capability check that rejects after the component has already unmounted", async () => {
    let rejectCapability: (error: unknown) => void = () => undefined;
    mockedFetchCapability.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectCapability = reject;
      })
    );
    const { unmount } = render(<ExplainSection target={target} />);

    unmount();

    expect(() => {
      act(() => {
        rejectCapability(new Error("network down"));
      });
    }).not.toThrow();
  });

  it("ignores a request response that resolves after the request was already aborted (selection changed)", async () => {
    let resolveRequest: (response: ExplainResponse) => void = () => undefined;
    mockedFetchCapability.mockResolvedValue({ enabled: true });
    mockedRequestExplanation.mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve;
      })
    );
    const { unmount } = render(<ExplainSection target={target} />);

    fireEvent.click(await screen.findByRole("button", { name: "Explain meanings" }));
    unmount();

    // The abort flag is checked before acting on the response; a late resolution must be a no-op.
    expect(() => {
      act(() => {
        resolveRequest({ provider: {}, result: minimalResult, status: "ok" });
      });
    }).not.toThrow();
  });

  it("silently ignores an AbortError from a genuinely aborted request instead of showing a failure", async () => {
    let rejectRequest: (error: unknown) => void = () => undefined;
    mockedRequestExplanation.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectRequest = reject;
        })
    );
    renderReady();

    fireEvent.click(await screen.findByRole("button", { name: "Explain meanings" }));
    await act(async () => {
      rejectRequest(new DOMException("The operation was aborted.", "AbortError"));
    });

    // A genuinely aborted request must never surface as a visible failure state.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Asking Copilot");
  });
});
