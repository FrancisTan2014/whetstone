import { afterEach, describe, expect, it, vi } from "vitest";

import { createNtfyClient, type NtfyFetchLike, type NtfyFetchResponse } from "./ntfyClient.js";

function okResponse(status = 200): NtfyFetchResponse {
  return { ok: status >= 200 && status < 300, status };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("createNtfyClient.send", () => {
  it("posts the message as a plain-text body and reports success on a 2xx response", async () => {
    let seenUrl: string | undefined;
    let seenInit: Parameters<NtfyFetchLike>[1] | undefined;
    const fetchFn: NtfyFetchLike = (url, init) => {
      seenUrl = url;
      seenInit = init;
      return Promise.resolve(okResponse());
    };
    const client = createNtfyClient("https://ntfy.sh/my-private-topic", fetchFn);

    expect(await client.send("3 cards due")).toEqual({ ok: true });
    expect(seenUrl).toBe("https://ntfy.sh/my-private-topic");
    expect(seenInit?.method).toBe("POST");
    expect(seenInit?.headers).toEqual({ "content-type": "text/plain; charset=utf-8" });
    expect(seenInit?.body).toBe("3 cards due");
  });

  it("maps a non-2xx response to a typed http error", async () => {
    const client = createNtfyClient("https://ntfy.sh/topic", () => Promise.resolve(okResponse(500)));

    expect(await client.send("hello")).toEqual({ error: { kind: "http", status: 500 }, ok: false });
  });

  it("normalizes a thrown transport error to a network error", async () => {
    const client = createNtfyClient("https://ntfy.sh/topic", () => Promise.reject(new Error("boom")));

    expect(await client.send("hello")).toEqual({ error: { kind: "network" }, ok: false });
  });

  it("normalizes a timeout abort into a timeout error", async () => {
    vi.useFakeTimers();
    const fetchFn: NtfyFetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    const client = createNtfyClient("https://ntfy.sh/topic", fetchFn, 1000);

    const pending = client.send("hello");
    await vi.advanceTimersByTimeAsync(1000);

    expect(await pending).toEqual({ error: { kind: "timeout" }, ok: false });
  });

  it("uses the global fetch by default", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(okResponse()));
    const client = createNtfyClient("https://ntfy.sh/topic");

    expect(await client.send("hello")).toEqual({ ok: true });
  });
});
