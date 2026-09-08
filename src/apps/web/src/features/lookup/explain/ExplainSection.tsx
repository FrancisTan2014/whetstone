import { useCallback, useEffect, useRef, useState } from "react";

import type {
  ExplainBranch,
  ExplainFamily,
  ExplainProviderAttribution,
  ExplainRequest,
  ExplainResult,
  ExplainUnavailableReason
} from "@whetstone/contracts";

import { ExplainRequestError, fetchExplainCapability, requestExplanation } from "./explainApi";

// The Explain feature's own view state (#924/#925) — distinct from the dictionary `LookupState`
// (`LookupPanel.tsx`): every named API outcome renders truthfully, plus one client-only
// `request_failed` for an HTTP-layer/network failure the shared contract does not itself name, and
// one client-only `capability_error` for a failed capability probe. `checking`/`disabled` never touch
// a model; only an explicit "Explain meanings" click (from `ready`) or "Try again" (from any failure)
// ever does.
type ExplainViewState =
  | Readonly<{ status: "checking" }>
  | Readonly<{ status: "capability_error" }>
  | Readonly<{ remedy: string; status: "disabled" }>
  | Readonly<{ status: "ready" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{ provider: ExplainProviderAttribution; result: ExplainResult; status: "result" }>
  | Readonly<{ status: "not_found" }>
  | Readonly<{ status: "stale_selection" }>
  | Readonly<{ status: "timeout" }>
  | Readonly<{ status: "invalid_response" }>
  | Readonly<{ reason: ExplainUnavailableReason; status: "unavailable" }>
  | Readonly<{ status: "request_failed" }>;

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

// One branch row: its label, its connection to the family's organizing core, a short natural
// example, and — only on the branch the passage actually uses — a clear "Used here" marker. The
// example is rendered as plain text (React escapes it), never markup, matching the model string
// safety rule the whole component follows.
function ExplainBranchRow({
  branch,
  isCurrent
}: {
  branch: ExplainBranch;
  isCurrent: boolean;
}): React.JSX.Element {
  return (
    <li className={isCurrent ? "explainBranch explainBranchCurrent" : "explainBranch"}>
      <div className="explainBranchHeader">
        <span className="explainBranchLabel">{branch.label}</span>
        {isCurrent ? <span className="explainCurrentMarker">Used here</span> : null}
      </div>
      <p className="explainBranchConnection">{branch.connection}</p>
      <p className="explainBranchExample">“{branch.example}”</p>
    </li>
  );
}

// One sense family: its organizing core image/schema, then its principal branches. The family that
// contains the current passage's branch is itself marked, so the map reads core-first, never a bare
// list of branches with no organizing anchor.
function ExplainFamilySection({
  currentBranchId,
  currentFamilyId,
  family
}: {
  currentBranchId: string;
  currentFamilyId: string;
  family: ExplainFamily;
}): React.JSX.Element {
  const isCurrentFamily = family.id === currentFamilyId;
  return (
    <section className={isCurrentFamily ? "explainFamily explainFamilyCurrent" : "explainFamily"}>
      <p className="explainCoreImage">{family.coreImage}</p>
      <ul className="explainBranches">
        {family.branches.map((branch) => (
          <ExplainBranchRow
            branch={branch}
            isCurrent={isCurrentFamily && branch.id === currentBranchId}
            key={branch.id}
          />
        ))}
      </ul>
    </section>
  );
}

// The supporting-details row list: pronunciation, nuance, everyday usage, etymology, and cultural
// context each render ONLY when the model actually supplied them (#925) — never six mandatory
// sections. Returns null (not an empty list) when none are present.
function ExplainSupportingDetails({ result }: { result: ExplainResult }): React.JSX.Element | null {
  const hasPronunciation = result.pronunciation !== undefined && result.pronunciation.length > 0;
  const hasAny =
    hasPronunciation ||
    result.nuance !== undefined ||
    result.usageNote !== undefined ||
    result.etymology !== undefined ||
    result.culturalNote !== undefined;

  if (!hasAny) {
    return null;
  }

  return (
    <dl className="explainDetails">
      {result.pronunciation !== undefined && result.pronunciation.length > 0
        ? result.pronunciation.map((entry, index) => (
            <div className="explainDetailRow" key={index}>
              <dt>{entry.label}</dt>
              <dd>{entry.value}</dd>
            </div>
          ))
        : null}
      {result.nuance === undefined ? null : (
        <div className="explainDetailRow">
          <dt>Nuance</dt>
          <dd>{result.nuance}</dd>
        </div>
      )}
      {result.usageNote === undefined ? null : (
        <div className="explainDetailRow">
          <dt>Usage</dt>
          <dd>{result.usageNote}</dd>
        </div>
      )}
      {result.etymology === undefined ? null : (
        <div className="explainDetailRow">
          <dt>Origin</dt>
          <dd>{result.etymology}</dd>
        </div>
      )}
      {result.culturalNote === undefined ? null : (
        <div className="explainDetailRow">
          <dt>Culture</dt>
          <dd>{result.culturalNote}</dd>
        </div>
      )}
    </dl>
  );
}

// The real, provider-reported attribution — shown ONLY when the runtime actually reported it, never
// fabricated from the requested model/effort configuration (#925). Rendered as plain text.
function ExplainProviderFooter({
  provider
}: {
  provider: ExplainProviderAttribution;
}): React.JSX.Element | null {
  const parts = [provider.model, provider.reasoningEffort].filter(
    (value): value is string => value !== undefined
  );

  if (parts.length === 0) {
    return null;
  }

  return <footer className="explainProvider">{parts.join(" · ")}</footer>;
}

function explainUnavailableMessage(reason: ExplainUnavailableReason): string {
  switch (reason) {
    case "startup_failed":
      return "Copilot could not start. Check the setup and try again.";
    case "unsupported_model":
      return "The configured Copilot model is not supported for this request.";
    case "transport_failed":
      return "Could not reach Copilot. Check your connection and try again.";
  }
}

function explainFailureMessage(view: ExplainViewState): string | undefined {
  switch (view.status) {
    case "capability_error":
      return "Could not check whether Explain meanings is available.";
    case "not_found":
      return "This passage could not be found. It may have been removed.";
    case "stale_selection":
      return "The passage changed since you selected it. Select the text again to explain it.";
    case "timeout":
      return "The explanation is taking too long. Try again in a moment.";
    case "invalid_response":
      return "Copilot returned an answer that could not be understood.";
    case "unavailable":
      return explainUnavailableMessage(view.reason);
    case "request_failed":
      return "Something went wrong requesting the explanation.";
    default:
      return undefined;
  }
}

const retryableStatuses = new Set<ExplainViewState["status"]>([
  "capability_error",
  "not_found",
  "stale_selection",
  "timeout",
  "invalid_response",
  "unavailable",
  "request_failed"
]);

export type ExplainSectionProps = Readonly<{ target: ExplainRequest }>;

// The Reader's explicit semantic-explanation entry point (#924/#925): a lazily-loaded, independently
// budgeted (own Vite chunk) sibling of the dictionary tabs, never a replacement for them. Mounts a
// fresh capability check per distinct selection (the caller keys this component by selection identity,
// so a new selection or a close/reopen always starts a fresh instance — no stale answer can paint under
// a new term). Only the explicit action button (or "Try again") ever sends a POST; opening, checking
// capability, and closing never do.
export function ExplainSection({ target }: ExplainSectionProps): React.JSX.Element {
  const [view, setView] = useState<ExplainViewState>({ status: "checking" });
  const abortControllerRef = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;

    void fetchExplainCapability()
      .then((capability) => {
        if (cancelled) {
          return;
        }
        setView(
          capability.enabled
            ? { status: "ready" }
            : { remedy: capability.remedy, status: "disabled" }
        );
      })
      .catch(() => {
        if (!cancelled) {
          setView({ status: "capability_error" });
        }
      });

    return () => {
      cancelled = true;
      abortControllerRef.current?.abort();
    };
  }, [target]);

  const invoke = useCallback(() => {
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setView({ status: "loading" });

    void requestExplanation(target, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) {
          return;
        }
        switch (response.status) {
          case "ok":
            setView({ provider: response.provider, result: response.result, status: "result" });
            return;
          case "not_found":
            setView({ status: "not_found" });
            return;
          case "stale_selection":
            setView({ status: "stale_selection" });
            return;
          case "timeout":
            setView({ status: "timeout" });
            return;
          case "invalid_response":
            setView({ status: "invalid_response" });
            return;
          case "unavailable":
            setView({ reason: response.reason, status: "unavailable" });
            return;
          case "disabled":
            // The capability was toggled off between the mount-time check and this click (a rare
            // race, not a normal outcome): fall back to the generic HTTP-layer failure copy rather
            // than fabricating a `remedy` this response never carries.
            setView({ status: "request_failed" });
            return;
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) {
          return;
        }
        if (error instanceof ExplainRequestError) {
          setView({ status: "invalid_response" });
          return;
        }
        setView({ status: "request_failed" });
      });
  }, [target]);

  if (view.status === "checking") {
    return (
      <p className="explainChecking" role="status">
        Checking Explain meanings…
      </p>
    );
  }

  if (view.status === "disabled") {
    return (
      <section className="explainSection" data-status="disabled">
        <p className="explainDisabled">Explain meanings is turned off. {view.remedy}</p>
      </section>
    );
  }

  const failureMessage = explainFailureMessage(view);

  return (
    <section className="explainSection" data-status={view.status}>
      <p
        aria-label="AI-generated explanation, may be imperfect"
        className="lookupAiBadge"
        role="note"
      >
        AI-generated — may be imperfect
      </p>

      {view.status === "ready" || retryableStatuses.has(view.status) ? (
        <div className="explainActionRow">
          {view.status === "ready" ? (
            <p className="explainConsent">
              Explain meanings sends this selected text to Copilot, an external AI provider.
            </p>
          ) : null}
          <button className="explainActionButton" onClick={invoke} type="button">
            {view.status === "ready" ? "Explain meanings" : "Try again"}
          </button>
        </div>
      ) : null}

      {view.status === "loading" ? (
        <p className="explainLoading" role="status">
          Asking Copilot for the semantic map…
        </p>
      ) : null}

      {failureMessage === undefined ? null : (
        <p className="explainError" role="alert">
          {failureMessage}
        </p>
      )}

      {view.status === "result" ? (
        <div className="explainMap">
          {view.result.families.map((family) => (
            <ExplainFamilySection
              currentBranchId={view.result.currentBranchId}
              currentFamilyId={view.result.currentFamilyId}
              family={family}
              key={family.id}
            />
          ))}
          <ExplainSupportingDetails result={view.result} />
          <ExplainProviderFooter provider={view.provider} />
        </div>
      ) : null}
    </section>
  );
}
