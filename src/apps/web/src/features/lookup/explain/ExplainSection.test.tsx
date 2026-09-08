// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
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
  endOffset: 4,
  selectedText: "bank",
  startOffset: 0,
  workEntryId: toEntryId("w1")
};

// Two genuinely unrelated sense families — a real homograph with two separate etymologies, never a
// single fabricated universal root (#925 correction: the prior "spring" fixture's season/coil senses
// in fact share one origin, which is the opposite of what a homograph fixture must prove). The current
// marker sits on the SECOND family's SECOND branch, so this one fixture proves both a non-first-family
// marker and a non-first-branch marker together — a hardcoded "always the first" bug would fail both.
const bankResult: ExplainResult = {
  currentBranchId: "deposit",
  currentFamilyId: "financial",
  etymology:
    "The riverbank sense traces to Old Norse \u201cbakki\u201d (ridge, slope); the financial sense " +
    "traces separately to Italian \u201cbanca\u201d (a moneychanger's bench) \u2014 two unrelated " +
    "origins for one modern spelling.",
  families: [
    {
      branches: [
        {
          connection: "the sloping ground itself, at the water's edge",
          example: "They sat on the bank and watched the current.",
          id: "riverside",
          label: "a riverbank or lakeshore"
        },
        {
          connection: "a slope suggests something leaning or tilting sideways",
          example: "The plane banked sharply to the left.",
          id: "tilt",
          label: "to tilt or lean sideways"
        }
      ],
      coreImage: "a sloping earthen edge, as beside a river",
      id: "river"
    },
    {
      branches: [
        {
          connection: "the institution itself, holding money in trust",
          example: "She opened an account at the bank.",
          id: "institution",
          label: "a financial institution"
        },
        {
          connection:
            "trusting an institution to hold something safely extends to relying on anything",
          example: "You can bank on him to arrive early.",
          id: "deposit",
          label: "to rely on"
        }
      ],
      coreImage: "an institution that holds and manages money",
      id: "financial"
    }
  ],
  headword: "bank",
  language: "en",
  nuance: "Neutral in every sense.",
  pronunciation: [{ label: "IPA", value: "/b\u00e6\u014bk/" }],
  culturalNote: "Banks are a fixture of everyday financial life.",
  usageNote: "Common in both everyday and financial contexts."
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
  culturalNote: "A supporting detail with an explicitly empty pronunciation list.",
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

  it("shows the surrounding-passage consent text and action button once capability resolves enabled, and never requests before the click", async () => {
    renderReady();

    expect(await screen.findByRole("button", { name: "Explain meanings" })).toBeDefined();
    expect(
      screen.getByText(
        /sends the selected word or phrase, and a short surrounding passage, to Copilot, an external AI provider/
      )
    ).toBeDefined();
    expect(mockedRequestExplanation).not.toHaveBeenCalled();
  });

  // #925 correction: a failed capability probe must not be bypassable straight into an undisclosed
  // POST. Its ONLY retry re-fetches capability — never generation — so a rejected probe followed by a
  // successful retry must show exactly one capability call pair and zero explanation requests until the
  // learner explicitly clicks the (now-disclosed) "Explain meanings" action itself.
  it("retries a failed capability probe by re-fetching capability only, never invoking generation", async () => {
    mockedFetchCapability.mockRejectedValueOnce(new Error("network down"));
    mockedFetchCapability.mockResolvedValueOnce({ enabled: true });
    render(<ExplainSection target={target} />);

    expect(
      await screen.findByText("Could not check whether Explain meanings is available.")
    ).toBeDefined();
    expect(mockedFetchCapability).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("button", { name: "Explain meanings" })).toBeDefined();
    expect(mockedFetchCapability).toHaveBeenCalledTimes(2);
    expect(mockedRequestExplanation).not.toHaveBeenCalled();
    // The disclosed consent copy is shown again once capability resolves enabled — never skipped.
    expect(
      screen.getByText(/sends the selected word or phrase, and a short surrounding passage/)
    ).toBeDefined();
  });

  it("retries a failed capability probe back into a disabled state with the real remedy, if that is what capability now reports", async () => {
    mockedFetchCapability.mockRejectedValueOnce(new Error("network down"));
    mockedFetchCapability.mockResolvedValueOnce({
      enabled: false,
      reason: "feature_disabled",
      remedy: "Set AGENT_COPILOT_EXPLAIN_ENABLED=1."
    });
    render(<ExplainSection target={target} />);

    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));

    expect(await screen.findByText(/Set AGENT_COPILOT_EXPLAIN_ENABLED=1\./)).toBeDefined();
    expect(screen.queryByRole("button")).toBeNull();
    expect(mockedRequestExplanation).not.toHaveBeenCalled();
  });

  it("retries a failed capability probe back into another capability_error if the retry probe itself rejects", async () => {
    mockedFetchCapability.mockRejectedValue(new Error("still down"));
    render(<ExplainSection target={target} />);

    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));

    await waitFor(() => expect(mockedFetchCapability).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByText("Could not check whether Explain meanings is available.")
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "Try again" })).toBeDefined();
  });

  // A real bug caught only by a real E2E browser run (jsdom's default `render` never reproduces this):
  // React StrictMode's dev-only mount -> cleanup -> remount simulation runs this component's "mounted"
  // effect's cleanup once, immediately after the very first mount. A guard that only ever sets its ref
  // `false` in that cleanup — and relies on the initial `useRef(true)` value to mean "mounted" — is left
  // permanently `false` for the rest of the component's real lifetime once that simulation completes,
  // silently dropping every later `retryCapability`/disabled-race state update even though the component
  // stays genuinely mounted. Reproduced here by wrapping in `StrictMode` directly (fail-before: the prior
  // `useRef(true)` + cleanup-only-sets-false version left the retry permanently stuck in
  // "capability_error"; pass-after: the mount effect now also sets the ref `true` on every real mount).
  it("recovers via retryCapability even after React StrictMode's dev-only double-invoke simulation", async () => {
    // A phase gate, not queued once-values: StrictMode double-invokes the MOUNT effect itself too, so
    // "reject once, then resolve once" would be fully consumed by mount alone, before the retry click
    // ever fires. Every probe fails until the test explicitly flips this after the retry click.
    let capabilityFailing = true;
    mockedFetchCapability.mockImplementation(() =>
      capabilityFailing
        ? Promise.reject(new Error("network down"))
        : Promise.resolve({ enabled: true })
    );
    render(
      <StrictMode>
        <ExplainSection target={target} />
      </StrictMode>
    );

    expect(
      await screen.findByText("Could not check whether Explain meanings is available.")
    ).toBeDefined();
    capabilityFailing = false;

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("button", { name: "Explain meanings" })).toBeDefined();
    expect(mockedRequestExplanation).not.toHaveBeenCalled();
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
        result: bankResult,
        status: "ok"
      });
    });

    expect(screen.getByText("a sloping earthen edge, as beside a river")).toBeDefined();
    expect(screen.getByText("an institution that holds and manages money")).toBeDefined();
    // The current marker is on the SECOND family's SECOND branch — proves neither is hardcoded first.
    expect(screen.getByText("to rely on").closest("li")?.textContent).toContain("Used here");
    expect(screen.getByText("a financial institution").closest("li")?.textContent).not.toContain(
      "Used here"
    );
    expect(screen.getByText("a riverbank or lakeshore").closest("li")?.textContent).not.toContain(
      "Used here"
    );
    expect(screen.getByText("to tilt or lean sideways").closest("li")?.textContent).not.toContain(
      "Used here"
    );
    expect(screen.getByText("/b\u00e6\u014bk/")).toBeDefined();
    expect(screen.getByText("Neutral in every sense.")).toBeDefined();
    expect(screen.getByText(/two unrelated origins/)).toBeDefined();
    expect(screen.getByText("Common in both everyday and financial contexts.")).toBeDefined();
    expect(screen.getByText("Banks are a fixture of everyday financial life.")).toBeDefined();
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
      await screen.findByText("A supporting detail with an explicitly empty pronunciation list.")
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

  // #925 correction: `not_found`/`stale_selection` each already name their own actionable guidance
  // (select the text again); resending the identical unusable snapshot could not succeed, so these two
  // must NOT offer a "Try again" button, unlike genuinely retryable outcomes.
  it.each([
    ["not_found", "This passage could not be found. It may have been removed."],
    [
      "stale_selection",
      "The passage changed since you selected it. Select the text again to explain it."
    ]
  ] as const)(
    "truthfully renders the '%s' outcome with no pointless retry button",
    async (status, message) => {
      mockedRequestExplanation.mockResolvedValue({ status } as ExplainResponse);
      renderReady();

      fireEvent.click(await screen.findByRole("button", { name: "Explain meanings" }));
      expect(await screen.findByRole("alert")).toHaveProperty("textContent", message);
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    }
  );

  it.each([
    ["timeout", "The explanation is taking too long. Try again in a moment."],
    ["invalid_response", "Copilot returned an answer that could not be understood."]
  ] as const)(
    "truthfully renders the retryable '%s' outcome with a Try again button",
    async (status, message) => {
      mockedRequestExplanation.mockResolvedValue({ status } as ExplainResponse);
      renderReady();

      fireEvent.click(await screen.findByRole("button", { name: "Explain meanings" }));
      expect(await screen.findByRole("alert")).toHaveProperty("textContent", message);
      expect(screen.getByRole("button", { name: "Try again" })).toBeDefined();
    }
  );

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

  // #925 correction: the capability was toggled off between the mount-time check and this click (a
  // rare race). The prior behavior turned this into a generic `request_failed` message with no
  // remedy and no re-probe; now it must re-fetch the REAL current capability (never a second POST)
  // and show its actual remedy.
  it("recovers a disabled-mid-flight race by re-fetching the real current capability remedy, without a second POST", async () => {
    mockedRequestExplanation.mockResolvedValue({ status: "disabled" });
    mockedFetchCapability.mockResolvedValueOnce({ enabled: true });
    mockedFetchCapability.mockResolvedValueOnce({
      enabled: false,
      reason: "feature_disabled",
      remedy: "Set AGENT_COPILOT_EXPLAIN_ENABLED=1."
    });
    render(<ExplainSection target={target} />);

    fireEvent.click(await screen.findByRole("button", { name: "Explain meanings" }));

    expect(await screen.findByText(/Set AGENT_COPILOT_EXPLAIN_ENABLED=1\./)).toBeDefined();
    expect(mockedRequestExplanation).toHaveBeenCalledTimes(1);
    expect(mockedFetchCapability).toHaveBeenCalledTimes(2);
  });

  it("falls back to capability_error if the disabled-race recovery's own capability re-fetch rejects", async () => {
    mockedRequestExplanation.mockResolvedValue({ status: "disabled" });
    mockedFetchCapability.mockResolvedValueOnce({ enabled: true });
    mockedFetchCapability.mockRejectedValueOnce(new Error("still down"));
    render(<ExplainSection target={target} />);

    fireEvent.click(await screen.findByRole("button", { name: "Explain meanings" }));

    expect(
      await screen.findByText("Could not check whether Explain meanings is available.")
    ).toBeDefined();
  });

  // #925 correction: HTTP 400 (a malformed/rejected REQUEST) must never be shown as if the model
  // itself produced unusable output — those are different failures with different guidance, and only
  // `invalid_response` (the model-output case) offers a retry.
  it("maps an ExplainRequestError (HTTP 400, an invalid REQUEST) to its own distinct message, with no retry button", async () => {
    mockedRequestExplanation.mockRejectedValue(new ExplainRequestError("bad"));
    renderReady();

    fireEvent.click(await screen.findByRole("button", { name: "Explain meanings" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "This selection can't be explained as chosen. Select a shorter or different phrase and try again."
    );
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
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

  it("ignores a capability_error retry's re-fetch that resolves after the component has already unmounted", async () => {
    mockedFetchCapability.mockRejectedValueOnce(new Error("network down"));
    let resolveRetry: (capability: { enabled: true }) => void = () => undefined;
    mockedFetchCapability.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRetry = resolve;
      })
    );
    const { unmount } = render(<ExplainSection target={target} />);

    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    unmount();

    expect(() => {
      act(() => {
        resolveRetry({ enabled: true });
      });
    }).not.toThrow();
  });

  it("ignores a capability_error retry's re-fetch that rejects after the component has already unmounted", async () => {
    mockedFetchCapability.mockRejectedValueOnce(new Error("network down"));
    let rejectRetry: (error: Error) => void = () => undefined;
    mockedFetchCapability.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectRetry = reject;
      })
    );
    const { unmount } = render(<ExplainSection target={target} />);

    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    unmount();

    expect(() => {
      act(() => {
        rejectRetry(new Error("still down"));
      });
    }).not.toThrow();
  });

  it("ignores a disabled-race recovery's own capability re-fetch that rejects after the component has already unmounted", async () => {
    mockedFetchCapability.mockResolvedValueOnce({ enabled: true });
    mockedRequestExplanation.mockResolvedValue({ status: "disabled" });
    let rejectRecovery: (error: Error) => void = () => undefined;
    mockedFetchCapability.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectRecovery = reject;
      })
    );
    const { unmount } = render(<ExplainSection target={target} />);

    fireEvent.click(await screen.findByRole("button", { name: "Explain meanings" }));
    await waitFor(() => expect(mockedFetchCapability).toHaveBeenCalledTimes(2));
    unmount();

    expect(() => {
      act(() => {
        rejectRecovery(new Error("still down"));
      });
    }).not.toThrow();
  });

  it("ignores a disabled-race recovery's own capability re-fetch that resolves after the component has already unmounted", async () => {
    mockedFetchCapability.mockResolvedValueOnce({ enabled: true });
    mockedRequestExplanation.mockResolvedValue({ status: "disabled" });
    let resolveRecovery: (capability: { enabled: true }) => void = () => undefined;
    mockedFetchCapability.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRecovery = resolve;
      })
    );
    const { unmount } = render(<ExplainSection target={target} />);

    fireEvent.click(await screen.findByRole("button", { name: "Explain meanings" }));
    await waitFor(() => expect(mockedFetchCapability).toHaveBeenCalledTimes(2));
    unmount();

    expect(() => {
      act(() => {
        resolveRecovery({ enabled: true });
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
