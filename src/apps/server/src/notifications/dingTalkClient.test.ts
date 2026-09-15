import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDingTalkClient,
  type DingTalkFetchLike,
  type DingTalkFetchResponse
} from "./dingTalkClient.js";

function okResponse(status = 200): DingTalkFetchResponse {
  return { ok: status >= 200 && status < 300, status };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("createDingTalkClient.send", () => {
  it("posts the message as a DingTalk text payload and reports success on a 2xx response", async () => {
    let seenUrl: string | undefined;
    let seenInit: Parameters<DingTalkFetchLike>[1] | undefined;
    const fetchFn: DingTalkFetchLike = (url, init) => {
      seenUrl = url;
      seenInit = init;
      return Promise.resolve(okResponse());
    };
    const client = createDingTalkClient(
      "https://oapi.dingtalk.com/robot/send?access_token=t",
      fetchFn
    );

    expect(await client.send("3 cards due")).toEqual({ ok: true });
    expect(seenUrl).toBe("https://oapi.dingtalk.com/robot/send?access_token=t");
    expect(seenInit?.method).toBe("POST");
    expect(seenInit?.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(seenInit!.body)).toEqual({
      msgtype: "text",
      text: { content: "3 cards due" }
    });
  });

  it("maps a non-2xx response to a typed http error", async () => {
    const client = createDingTalkClient("https://example.test/webhook", () =>
      Promise.resolve(okResponse(500))
    );

    expect(await client.send("hello")).toEqual({ error: { kind: "http", status: 500 }, ok: false });
  });

  it("normalizes a thrown transport error to a network error", async () => {
    const client = createDingTalkClient("https://example.test/webhook", () =>
      Promise.reject(new Error("boom"))
    );

    expect(await client.send("hello")).toEqual({ error: { kind: "network" }, ok: false });
  });

  it("normalizes a timeout abort into a timeout error", async () => {
    vi.useFakeTimers();
    const fetchFn: DingTalkFetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    const client = createDingTalkClient("https://example.test/webhook", fetchFn, 1000);

    const pending = client.send("hello");
    await vi.advanceTimersByTimeAsync(1000);

    expect(await pending).toEqual({ error: { kind: "timeout" }, ok: false });
  });

  it("uses the global fetch by default", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(okResponse()));
    const client = createDingTalkClient("https://example.test/webhook");

    expect(await client.send("hello")).toEqual({ ok: true });
  });
});
