import { afterEach, describe, expect, it, vi } from "vitest";

import { createHttpClient, type FetchLike, type FetchResponse } from "./httpClient.js";

function okResponse(body: string, status = 200): FetchResponse {
  return { ok: status >= 200 && status < 300, status, text: () => Promise.resolve(body) };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("createHttpClient.getText", () => {
  it("returns the body text on a 2xx response", async () => {
    const client = createHttpClient(() => Promise.resolve(okResponse("hello")));

    expect(await client.getText("https://example.test/a")).toEqual({ ok: true, value: "hello" });
  });

  it("passes custom headers to the transport and maps non-2xx to an http error", async () => {
    let seenHeaders: Record<string, string> | undefined;
    const fetchFn: FetchLike = (_url, init) => {
      seenHeaders = init.headers;
      return Promise.resolve(okResponse("nope", 503));
    };
    const client = createHttpClient(fetchFn);

    const result = await client.getText("https://example.test/a", {
      headers: { authorization: "Bearer t" }
    });

    expect(seenHeaders).toEqual({ authorization: "Bearer t" });
    expect(result).toEqual({ error: { kind: "http", status: 503 }, ok: false });
  });

  it("normalizes a thrown transport error to a network error", async () => {
    const client = createHttpClient(() => Promise.reject(new Error("boom")));

    expect(await client.getText("https://example.test/a")).toEqual({
      error: { kind: "network" },
      ok: false
    });
  });

  it("normalizes a timeout abort into a timeout error", async () => {
    vi.useFakeTimers();
    const fetchFn: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    const client = createHttpClient(fetchFn);

    const pending = client.getText("https://example.test/slow", { timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);

    expect(await pending).toEqual({ error: { kind: "timeout" }, ok: false });
  });

  it("uses the global fetch by default", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(okResponse("from-global")));
    const client = createHttpClient();

    expect(await client.getText("https://example.test/a")).toEqual({
      ok: true,
      value: "from-global"
    });
  });
});

describe("createHttpClient.getJson", () => {
  it("parses a JSON body", async () => {
    const client = createHttpClient(() => Promise.resolve(okResponse('{"headword":"set"}')));

    expect(await client.getJson<{ headword: string }>("https://example.test/a")).toEqual({
      ok: true,
      value: { headword: "set" }
    });
  });

  it("propagates a transport error without attempting to parse", async () => {
    const client = createHttpClient(() => Promise.resolve(okResponse("", 500)));

    expect(await client.getJson("https://example.test/a")).toEqual({
      error: { kind: "http", status: 500 },
      ok: false
    });
  });

  it("maps an unparseable body to a parse error", async () => {
    const client = createHttpClient(() => Promise.resolve(okResponse("not json")));

    expect(await client.getJson("https://example.test/a")).toEqual({
      error: { kind: "parse" },
      ok: false
    });
  });
});
