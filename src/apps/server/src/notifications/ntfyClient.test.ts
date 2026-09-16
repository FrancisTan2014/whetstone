import { afterEach, describe, expect, it, vi } from "vitest";

import {
  boundNtfyMessage,
  createNtfyClient,
  type NtfyFetchLike,
  type NtfyFetchResponse
} from "./ntfyClient.js";

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
    const client = createNtfyClient("https://ntfy.sh/topic", () =>
      Promise.resolve(okResponse(500))
    );

    expect(await client.send("hello")).toEqual({ error: { kind: "http", status: 500 }, ok: false });
  });

  it("normalizes a thrown transport error to a network error", async () => {
    const client = createNtfyClient("https://ntfy.sh/topic", () =>
      Promise.reject(new Error("boom"))
    );

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

  it("bounds an oversized body before sending, so it stays notification text rather than an attachment", async () => {
    let seenBody: string | undefined;
    const fetchFn: NtfyFetchLike = (_url, init) => {
      seenBody = init.body;
      return Promise.resolve(okResponse());
    };
    const client = createNtfyClient("https://ntfy.sh/topic", fetchFn);
    const oversized = [
      "30 Works have recitation due today:",
      ...Array.from({ length: 30 }, (_, i) => `- ${"字".repeat(50)}${i}`)
    ].join("\n");

    expect(await client.send(oversized)).toEqual({ ok: true });
    expect(seenBody).toBeDefined();
    expect(new TextEncoder().encode(seenBody as string).length).toBeLessThanOrEqual(4096);
    expect(seenBody).toContain("30 Works have recitation due today:");
    expect(seenBody).toMatch(/more not shown\)$/);
  });
});

describe("boundNtfyMessage", () => {
  it("returns the message unchanged when it already fits", () => {
    const message = "1 Work has recitation due today:\n- The Analects";
    expect(boundNtfyMessage(message, 4096)).toBe(message);
  });

  it("keeps the heading and as many titles as fit, replacing the rest with an omitted-count line", () => {
    const heading = "3 Works have recitation due today:";
    const lines = [heading, "- Alpha the first", "- Beta the second", "- Gamma the third"];
    const message = lines.join("\n");
    // A byte budget that fits the heading and the first title, but not all three.
    const maxBytes = new TextEncoder().encode(
      [heading, "- Alpha the first", "- (+2 more not shown)"].join("\n")
    ).length;

    const bounded = boundNtfyMessage(message, maxBytes);

    expect(bounded).toContain(heading);
    expect(bounded).toContain("- Alpha the first");
    expect(bounded).not.toContain("- Gamma the third");
    expect(bounded).toContain("- (+2 more not shown)");
    expect(new TextEncoder().encode(bounded).length).toBeLessThanOrEqual(maxBytes);
  });

  it("never exceeds the byte budget even when even the heading alone does not fit with room for an omitted line", () => {
    const message = [
      "1 Work has recitation due today:",
      "- A very very very long title that will not fit at all"
    ].join("\n");

    const bounded = boundNtfyMessage(message, 40);

    expect(new TextEncoder().encode(bounded).length).toBeLessThanOrEqual(40);
  });
});
