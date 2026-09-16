// A minimal outbound boundary for posting a text message to an ntfy topic (#936), so the daily
// due-recitation forward can also reach a personal iPhone as a free push notification (the ntfy iOS
// app subscribes to a topic URL and turns each POST into a native push). Mirrors `dingTalkClient.ts`'s
// shape (injected transport, typed result, never throws) rather than widening it with an ntfy-specific
// payload shape it has no other caller for.

export type NtfyError =
  | Readonly<{ kind: "network" }>
  | Readonly<{ kind: "timeout" }>
  | Readonly<{ kind: "http"; status: number }>;

export type NtfySendResult =
  | Readonly<{ ok: true }>
  | Readonly<{ error: NtfyError; ok: false }>;

// The minimal response surface the client reads; the global `fetch` Response satisfies it.
export type NtfyFetchResponse = Readonly<{ ok: boolean; status: number }>;

export type NtfyFetchLike = (
  url: string,
  init: Readonly<{
    body: string;
    headers: Record<string, string>;
    method: "POST";
    signal: AbortSignal;
  }>
) => Promise<NtfyFetchResponse>;

export type NtfyClient = Readonly<{
  send: (message: string) => Promise<NtfySendResult>;
}>;

const DEFAULT_TIMEOUT_MS = 10_000;

// Adapts the runtime's global fetch to NtfyFetchLike; read lazily so tests can stub it.
const defaultFetch: NtfyFetchLike = (url, init) => fetch(url, init);

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name: unknown }).name === "AbortError"
  );
}

// An ntfy client bound to one topic URL (e.g. https://ntfy.sh/<private-topic>). ntfy accepts a plain
// text body as the message; an unauthenticated public topic is guessable, so the URL is still treated
// as a secret (GUIDELINES.md) and is never logged by this module or its callers. `send` reports only a
// typed success/failure outcome, never the message body.
export function createNtfyClient(
  topicUrl: string,
  fetchFn: NtfyFetchLike = defaultFetch,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): NtfyClient {
  async function send(message: string): Promise<NtfySendResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchFn(topicUrl, {
        body: message,
        headers: { "content-type": "text/plain; charset=utf-8" },
        method: "POST",
        signal: controller.signal
      });

      if (!response.ok) {
        return { error: { kind: "http", status: response.status }, ok: false };
      }

      return { ok: true };
    } catch (error) {
      return { error: { kind: isAbortError(error) ? "timeout" : "network" }, ok: false };
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({ send });
}
