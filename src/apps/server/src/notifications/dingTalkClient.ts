// A minimal outbound boundary for posting a text message to a DingTalk custom group-robot webhook
// (#933). Mirrors `lookup/httpClient.ts`'s shape (injected transport, typed result, never throws) but
// stays local to this module rather than widening the shared GET-oriented `HttpClient` with a POST it
// has no other caller for.

export type DingTalkError =
  | Readonly<{ kind: "network" }>
  | Readonly<{ kind: "timeout" }>
  | Readonly<{ kind: "http"; status: number }>;

export type DingTalkSendResult =
  | Readonly<{ ok: true }>
  | Readonly<{ error: DingTalkError; ok: false }>;

// The minimal response surface the client reads; the global `fetch` Response satisfies it.
export type DingTalkFetchResponse = Readonly<{ ok: boolean; status: number }>;

export type DingTalkFetchLike = (
  url: string,
  init: Readonly<{
    body: string;
    headers: Record<string, string>;
    method: "POST";
    signal: AbortSignal;
  }>
) => Promise<DingTalkFetchResponse>;

export type DingTalkClient = Readonly<{
  send: (message: string) => Promise<DingTalkSendResult>;
}>;

const DEFAULT_TIMEOUT_MS = 10_000;

// Adapts the runtime's global fetch to DingTalkFetchLike; read lazily so tests can stub it.
const defaultFetch: DingTalkFetchLike = (url, init) => fetch(url, init);

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name: unknown }).name === "AbortError"
  );
}

// A DingTalk custom-robot client bound to one webhook URL. The webhook URL itself is a secret
// (GUIDELINES.md) and is never logged by this module or its callers; `send` reports only a typed
// success/failure outcome, never the message body.
export function createDingTalkClient(
  webhookUrl: string,
  fetchFn: DingTalkFetchLike = defaultFetch,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): DingTalkClient {
  async function send(message: string): Promise<DingTalkSendResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchFn(webhookUrl, {
        body: JSON.stringify({ msgtype: "text", text: { content: message } }),
        headers: { "content-type": "application/json" },
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
