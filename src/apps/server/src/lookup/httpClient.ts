// A small outbound HTTP boundary for calling external services. It supports GET as text or
// JSON, an optional per-request timeout, and custom headers, and normalizes every failure
// mode into a typed `HttpError` (network failure, non-2xx with status, timeout, JSON parse)
// so callers branch on data, never on thrown exceptions. The transport is injected so tests
// run against a fake and never touch the network.

export type HttpError =
  | Readonly<{ kind: "network" }>
  | Readonly<{ kind: "timeout" }>
  | Readonly<{ kind: "http"; status: number }>
  | Readonly<{ kind: "parse" }>;

export type HttpResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ error: HttpError; ok: false }>;

export type HttpRequestOptions = Readonly<{
  headers?: Readonly<Record<string, string>>;
  timeoutMs?: number;
}>;

// The minimal response surface the client reads; the global `fetch` Response satisfies it.
export type FetchResponse = Readonly<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

export type FetchLike = (
  url: string,
  init: Readonly<{ headers?: Record<string, string>; signal: AbortSignal }>
) => Promise<FetchResponse>;

export type HttpClient = Readonly<{
  getJson: <T>(url: string, options?: HttpRequestOptions) => Promise<HttpResult<T>>;
  getText: (url: string, options?: HttpRequestOptions) => Promise<HttpResult<string>>;
}>;

// Adapts the runtime's global fetch to FetchLike; read lazily so tests can stub it.
const defaultFetch: FetchLike = (url, init) => fetch(url, init);

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name: unknown }).name === "AbortError"
  );
}

export function createHttpClient(fetchFn: FetchLike = defaultFetch): HttpClient {
  async function getText(url: string, options?: HttpRequestOptions): Promise<HttpResult<string>> {
    const controller = new AbortController();
    const timer =
      options?.timeoutMs === undefined
        ? undefined
        : setTimeout(() => controller.abort(), options.timeoutMs);

    try {
      const init =
        options?.headers === undefined
          ? { signal: controller.signal }
          : { headers: { ...options.headers }, signal: controller.signal };
      const response = await fetchFn(url, init);

      if (!response.ok) {
        return { error: { kind: "http", status: response.status }, ok: false };
      }

      return { ok: true, value: await response.text() };
    } catch (error) {
      return { error: { kind: isAbortError(error) ? "timeout" : "network" }, ok: false };
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  async function getJson<T>(url: string, options?: HttpRequestOptions): Promise<HttpResult<T>> {
    const result = await getText(url, options);

    if (!result.ok) {
      return result;
    }

    try {
      return { ok: true, value: JSON.parse(result.value) as T };
    } catch {
      return { error: { kind: "parse" }, ok: false };
    }
  }

  return Object.freeze({ getJson, getText });
}
