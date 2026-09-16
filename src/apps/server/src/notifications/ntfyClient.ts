// A minimal outbound boundary for posting a text message to an ntfy topic (#936), so the daily
// due-recitation forward can also reach a personal iPhone as a free push notification (the ntfy iOS
// app subscribes to a topic URL and turns each POST into a native push). Mirrors `dingTalkClient.ts`'s
// shape (injected transport, typed result, never throws) rather than widening it with an ntfy-specific
// payload shape it has no other caller for.

export type NtfyError =
  | Readonly<{ kind: "network" }>
  | Readonly<{ kind: "timeout" }>
  | Readonly<{ kind: "http"; status: number }>;

export type NtfySendResult = Readonly<{ ok: true }> | Readonly<{ error: NtfyError; ok: false }>;

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
  // Takes the heading and due-Work titles as structured data, not a pre-composed string, so bounding
  // an oversized due-list can drop whole Works by their real record boundaries (#936 review: a title's
  // own text — e.g. an internal newline or a "- " continuation — must never be misread as a boundary).
  send: (heading: string, workTitles: readonly string[]) => Promise<NtfySendResult>;
}>;

const DEFAULT_TIMEOUT_MS = 10_000;

// ntfy treats a body over 4096 UTF-8 bytes as a file attachment rather than notification text (it
// still returns 200), so an oversized due-list would silently lose its reminder text while Whetstone
// marks the day notified. Leave headroom under ntfy's own limit for the "omitted" line this module adds.
const MAX_NTFY_BODY_BYTES = 4096;

const textEncoder = new TextEncoder();

function byteLength(text: string): number {
  return textEncoder.encode(text).length;
}

// Composes and bounds the ntfy body from structured heading + title data, so an oversized due-list is
// truncated by real Work-record boundaries rather than by re-parsing display text. A Work title may
// contain arbitrary text — including internal newlines or a leading "- " — none of which is a record
// separator, so composition (join by `- ` markers) and truncation happen together here instead of
// splitting an already-composed message back apart.
export function composeNtfyBody(
  heading: string,
  workTitles: readonly string[],
  maxBytes: number = MAX_NTFY_BODY_BYTES
): string {
  const full = [heading, ...workTitles.map((title) => `- ${title}`)].join("\n");
  if (byteLength(full) <= maxBytes) {
    return full;
  }

  const kept: string[] = [];

  for (let index = 0; index < workTitles.length; index += 1) {
    const omittedCount = workTitles.length - index - 1;
    const candidate = [
      heading,
      ...kept.map((title) => `- ${title}`),
      `- ${workTitles[index]}`,
      `- (+${omittedCount} more not shown)`
    ].join("\n");

    if (byteLength(candidate) > maxBytes) {
      break;
    }

    kept.push(workTitles[index] as string);
  }

  const omittedCount = workTitles.length - kept.length;
  return [
    heading,
    ...kept.map((title) => `- ${title}`),
    `- (+${omittedCount} more not shown)`
  ].join("\n");
}

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
  async function send(heading: string, workTitles: readonly string[]): Promise<NtfySendResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchFn(topicUrl, {
        body: composeNtfyBody(heading, workTitles),
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
