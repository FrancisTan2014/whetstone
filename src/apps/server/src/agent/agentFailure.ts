// The agent seam's typed failure categorization (#904). A caller classifies an agent failure by its
// `code` instead of matching on adapter/process error strings, so knowledge of what an agent outcome
// *means* lives with the seam rather than being re-derived by every future consumer. This mirrors
// `speechFailure.ts`, which does the same job for the voice seam.
//
// Every failure is named. A turn either produces the provider's own text or fails by one of these
// codes — the seam never fabricates, truncates, or partially salvages an answer.
export type AgentFailureCode =
  // No provider is configured (no AGENT_BINARY + AGENT_MODEL) and the caller supplied no fake, so
  // there is no honest answer to return.
  | "agent_not_configured"
  // The configured executable did not answer the `--contract-version` readiness probe with the
  // expected contract: it failed to run, exited non-zero, printed non-JSON, or reported another
  // contract version. Detected before any prompt is handed over.
  | "agent_probe_failed"
  // The provider ran but exited non-zero. The message carries the child's stderr.
  | "agent_exit_failed"
  // The provider exited 0 but its stdout was not the JSON turn contract (`{"text": "..."}`).
  | "agent_malformed_response"
  // The provider exceeded the turn's wall-clock bound and was terminated.
  | "agent_timeout"
  // `send` was called after `close`: the conversation is over and taking another turn would silently
  // start a different one.
  | "agent_session_closed";

// Rejections carry a code because the port's `send` returns the turn itself (`{ text }`), so there is
// no result union to put a failure in; `isAgentError` is how a caller narrows a caught value.
export class AgentError extends Error {
  override readonly name = "AgentError";

  readonly code: AgentFailureCode;

  constructor(code: AgentFailureCode, message: string) {
    super(message);
    this.code = code;
  }
}

export function isAgentError(value: unknown): value is AgentError {
  return value instanceof AgentError;
}
