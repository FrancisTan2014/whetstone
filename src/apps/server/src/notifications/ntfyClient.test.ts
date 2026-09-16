import { afterEach, describe, expect, it, vi } from "vitest";

import {
  composeNtfyBody,
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
  it("posts the heading and titles as a plain-text body and reports success on a 2xx response", async () => {
    let seenUrl: string | undefined;
    let seenInit: Parameters<NtfyFetchLike>[1] | undefined;
    const fetchFn: NtfyFetchLike = (url, init) => {
      seenUrl = url;
      seenInit = init;
      return Promise.resolve(okResponse());
    };
    const client = createNtfyClient("https://ntfy.sh/my-private-topic", fetchFn);

    expect(await client.send("1 Work has recitation due today:", ["The Analects"])).toEqual({
      ok: true
    });
    expect(seenUrl).toBe("https://ntfy.sh/my-private-topic");
    expect(seenInit?.method).toBe("POST");
    expect(seenInit?.headers).toEqual({ "content-type": "text/plain; charset=utf-8" });
    expect(seenInit?.body).toBe("1 Work has recitation due today:\n- The Analects");
  });

  it("maps a non-2xx response to a typed http error", async () => {
    const client = createNtfyClient("https://ntfy.sh/topic", () =>
      Promise.resolve(okResponse(500))
    );

    expect(await client.send("heading", [])).toEqual({
      error: { kind: "http", status: 500 },
      ok: false
    });
  });

  it("normalizes a thrown transport error to a network error", async () => {
    const client = createNtfyClient("https://ntfy.sh/topic", () =>
      Promise.reject(new Error("boom"))
    );

    expect(await client.send("heading", [])).toEqual({ error: { kind: "network" }, ok: false });
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

    const pending = client.send("heading", []);
    await vi.advanceTimersByTimeAsync(1000);

    expect(await pending).toEqual({ error: { kind: "timeout" }, ok: false });
  });

  it("uses the global fetch by default", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(okResponse()));
    const client = createNtfyClient("https://ntfy.sh/topic");

    expect(await client.send("heading", [])).toEqual({ ok: true });
  });

  it("bounds an oversized body before sending, so it stays notification text rather than an attachment", async () => {
    let seenBody: string | undefined;
    const fetchFn: NtfyFetchLike = (_url, init) => {
      seenBody = init.body;
      return Promise.resolve(okResponse());
    };
    const client = createNtfyClient("https://ntfy.sh/topic", fetchFn);
    const heading = "30 Works have recitation due today:";
    const titles = Array.from({ length: 30 }, (_, i) => `${"字".repeat(50)}${i}`);

    expect(await client.send(heading, titles)).toEqual({ ok: true });
    expect(seenBody).toBeDefined();
    expect(new TextEncoder().encode(seenBody as string).length).toBeLessThanOrEqual(4096);
    expect(seenBody).toContain(heading);
    expect(seenBody).toMatch(/more not shown\)$/);
  });

  it("keeps titles with internal newlines or a leading '- ' intact when they fit, without misreading them as extra Works", async () => {
    let seenBody: string | undefined;
    const fetchFn: NtfyFetchLike = (_url, init) => {
      seenBody = init.body;
      return Promise.resolve(okResponse());
    };
    const client = createNtfyClient("https://ntfy.sh/topic", fetchFn);
    const heading = "1 Work has recitation due today:";
    const titleWithContinuation = "Volume One\n- Appendix";

    expect(await client.send(heading, [titleWithContinuation])).toEqual({ ok: true });
    expect(seenBody).toBe([heading, `- ${titleWithContinuation}`].join("\n"));
    expect(seenBody).not.toContain("more not shown");
  });
});

describe("composeNtfyBody", () => {
  it("returns the composed body unchanged when it already fits", () => {
    const heading = "1 Work has recitation due today:";
    expect(composeNtfyBody(heading, ["The Analects"], 4096)).toBe(`${heading}\n- The Analects`);
  });

  it("keeps the heading and as many titles as fit, replacing the rest with an omitted-count line", () => {
    const heading = "3 Works have recitation due today:";
    const titles = ["Alpha the first", "Beta the second", "Gamma the third"];
    // A byte budget that fits the heading and the first title, but not all three.
    const maxBytes = new TextEncoder().encode(
      [heading, "- Alpha the first", "- (+2 more not shown)"].join("\n")
    ).length;

    const bounded = composeNtfyBody(heading, titles, maxBytes);

    expect(bounded).toContain(heading);
    expect(bounded).toContain("- Alpha the first");
    expect(bounded).not.toContain("Gamma the third");
    expect(bounded).toContain("- (+2 more not shown)");
    expect(new TextEncoder().encode(bounded).length).toBeLessThanOrEqual(maxBytes);
  });

  it("counts omitted Works by real title boundaries, not by a title's own '- '-prefixed continuation text", () => {
    const heading = "5 Works have recitation due today:";
    const titles = [
      "Alpha",
      // A title containing text that looks like a bullet continuation must still count as ONE Work.
      "Beta\n- Appendix",
      "Gamma",
      "Delta",
      "Epsilon"
    ];
    // A byte budget that fits only the heading and the first (single-line) title.
    const maxBytes = new TextEncoder().encode(
      [heading, "- Alpha", "- (+4 more not shown)"].join("\n")
    ).length;

    const bounded = composeNtfyBody(heading, titles, maxBytes);

    expect(bounded).toContain("- (+4 more not shown)");
    expect(bounded).not.toContain("- (+5 more not shown)");
  });
});
