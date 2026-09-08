import {
  parseExplainCapability,
  parseExplainResponse,
  type ExplainCapability,
  type ExplainRequest,
  type ExplainResponse
} from "@whetstone/contracts";

import { apiUrl } from "../../../shared/runtime";

// The Explain feature keeps its own fetch helper, decoupled from the dictionary lookup feature
// (`lookupApi.ts`) and from the legacy `/api/lookup?source=llm` gloss: this is a wholly separate,
// explicitly-invoked capability (#924/#925) with its own capability probe and its own request shape.
const jsonHeaders = { "content-type": "application/json" } as const;

// A read-only capability probe — never a model invocation (`docs/AGENT.md`/`explainContracts.ts`):
// safe to call as soon as the lookup panel mounts, so the Reader can show the disabled remedy (or the
// live action) before the learner ever selects "Explain meanings".
export async function fetchExplainCapability(): Promise<ExplainCapability> {
  const response = await fetch(apiUrl("/explain/capability"));

  if (!response.ok) {
    throw new Error(`Explain capability request failed with status ${response.status}.`);
  }

  return parseExplainCapability(await response.json());
}

// Thrown for the one HTTP-level (not feature-level) failure the shared contract names:
// a 400 `{error:"invalid_request"}` means the client itself built a malformed request — a client bug,
// never a user-facing outcome the Reader should render as though it were a typed `ExplainResponse`.
export class ExplainRequestError extends Error {}

// Resolves a captured selection into its organizing semantic map (#924/#925). ONLY ever invoked by an
// explicit learner action — never on mount, tab focus, or scroll. Every named outcome (ok, disabled,
// not_found, stale_selection, timeout, invalid_response, unavailable) arrives as a normal HTTP 200 and
// is returned here typed; only a genuinely malformed request (400) throws. The optional `signal` lets
// the caller (`ExplainSection.tsx`) actually cancel an in-flight request when the selection changes or
// the panel closes, instead of merely discarding its eventual result.
export async function requestExplanation(
  request: ExplainRequest,
  signal?: AbortSignal
): Promise<ExplainResponse> {
  const response = await fetch(apiUrl("/explain"), {
    body: JSON.stringify(request),
    headers: jsonHeaders,
    method: "POST",
    ...(signal === undefined ? {} : { signal })
  });

  if (response.status === 400) {
    throw new ExplainRequestError("The explain request was rejected as invalid.");
  }

  if (!response.ok) {
    throw new Error(`Explain request failed with status ${response.status}.`);
  }

  return parseExplainResponse(await response.json());
}
