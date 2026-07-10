import { describe, expect, it, vi } from "vitest";

import type { AnalyzeRoundRequest, CoachKnobs } from "@whetstone/contracts";

import { createFakeCoach } from "./fakeCoach.js";
import { createLlmCoach } from "./llmCoach.js";
import type { LlmModel } from "../llm/llmModel.js";

const knobs: CoachKnobs = {
  challenge: "medium",
  focus: "kitchen.offering-food",
  l1: "none",
  pace: "steady",
  probeErrorPatterns: [],
  register: "neutral",
  support: "medium",
  targetBand: "intermediate",
  targetL1Share: 0
};

const request: AnalyzeRoundRequest = {
  communicativeFunction: "Offering food",
  context: { profile: null, rankedChunks: [], recentOutcomes: [], relevantErrors: [] },
  history: [{ role: "user", text: "Help yourself to some rice" }],
  knobs,
  situation: "At the table",
  targetChunks: [{ chunkId: "c1", text: "Help yourself." }],
  words: []
};

const converseRequest = {
  communicativeFunction: "Offering food",
  context: { focus: "table", recentTargets: [] },
  history: [{ role: "user" as const, text: "I want give you food" }],
  knobs,
  situation: "At the table"
};

const judgeJson =
  '{"chunkGrades":[{"chunkId":"c1","rating":"easy"}],"mistakes":[],"wins":["Clear and natural"],' +
  '"upgrade":{"said":"help yourself","native":"Help yourself."},"encouragement":"Understood you."}';

// Build a coach over the deterministic fake with a named model and a spy fallback logger, so tests can
// assert both the degraded behavior and the observability seam (#432).
function makeCoach(chat: LlmModel, model = "llama3.1:8b") {
  const onFallback = vi.fn();
  const coach = createLlmCoach({ chat, fallback: createFakeCoach(), model, onFallback });
  return { coach, onFallback };
}

describe("createLlmCoach analyze", () => {
  it("rates an intelligible-but-accented attempt high, parsing the model's JSON", async () => {
    const chat = vi.fn().mockResolvedValue(`Here you go: ${judgeJson} done.`);
    const { coach, onFallback } = makeCoach(chat);

    const result = await coach.analyze(request);
    expect(result.chunkGrades).toEqual([{ chunkId: "c1", rating: "easy" }]);
    expect(result.encouragement).toBe("Understood you.");
    // The prompt is intelligibility-first and never penalizes accent.
    expect((chat.mock.calls[0]?.[0] as string).toLowerCase()).toContain("intelligibility");
    // analyze asks the model for JSON mode so the strict parse gets valid JSON (#433).
    expect(chat).toHaveBeenCalledWith(expect.any(String), { json: true });
    // A successful call must not log a fallback.
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("degrades to the deterministic fallback when the model output is unusable", async () => {
    const { coach } = makeCoach(vi.fn().mockResolvedValue("not json"));

    const result = await coach.analyze(request);
    // Fallback graded the produced chunk, so the round still grades.
    expect(result.chunkGrades).toHaveLength(1);
  });

  it("delegates non-analyze calls to the fallback", async () => {
    const { coach } = makeCoach(vi.fn());
    expect(
      (await coach.proposeNext({ focus: "x", recentTargets: [] })).target.length
    ).toBeGreaterThan(0);
    expect(coach.ratingForScheduler({ category: "good", issues: [], natural: 1 })).toBe("good");
    expect((await coach.authorCase({ communicativeFunction: "f", situation: "s" })).situation).toBe(
      "s"
    );
    expect((await coach.converse({ ...request, history: [] })).say.length).toBeGreaterThan(0);
    expect(
      (
        await coach.judgeProduction({
          context:
            request.context.profile === null
              ? { focus: "x", recentTargets: [] }
              : { focus: "x", recentTargets: [] },
          target: "hi",
          transcript: "hi"
        })
      ).category
    ).toBe("native_like");
  });
});

describe("createLlmCoach converse", () => {
  it("returns the model's in-flow line with a recast on breakdown, no grade", async () => {
    const chat = vi
      .fn()
      .mockResolvedValue(
        '{"say":"Nice — would you offer some?","repair":{"reason":"stuck","recast":"Try: help yourself"}}'
      );
    const { coach, onFallback } = makeCoach(chat);

    const result = await coach.converse(converseRequest);
    expect(result.say).toContain("offer");
    expect(result.repair?.recast).toContain("help yourself");
    expect((chat.mock.calls[0]?.[0] as string).toLowerCase()).toContain("register");
    // converse asks the model for JSON mode (#433).
    expect(chat).toHaveBeenCalledWith(expect.any(String), { json: true });
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("falls back to the deterministic turn when output is unusable", async () => {
    const { coach } = makeCoach(vi.fn().mockResolvedValue("???"));
    expect((await coach.converse(converseRequest)).say.length).toBeGreaterThan(0);
  });

  it("briefs a bilingual mix and returns the pushed English target (#270)", async () => {
    const chat = vi
      .fn()
      .mockResolvedValue('{"say":"好的 — 我们试试英文。","englishTarget":"Help yourself."}');
    const { coach } = makeCoach(chat);

    const result = await coach.converse({
      ...converseRequest,
      knobs: { ...knobs, l1: "zh", targetL1Share: 0.5 }
    });

    expect(result.englishTarget).toBe("Help yourself.");
    const prompt = (chat.mock.calls[0]?.[0] as string).toLowerCase();
    expect(prompt).toContain("bilingual");
    expect(prompt).toContain("englishtarget");
  });
});

describe("createLlmCoach fallback logging (#432)", () => {
  it("logs once with method/model/reason and returns the fake when converse's model call throws", async () => {
    const { coach, onFallback } = makeCoach(vi.fn().mockRejectedValue(new Error("daemon down")));

    const result = await coach.converse(converseRequest);
    // Behavior is unchanged: the fake still completes the turn.
    expect(result.say.length).toBeGreaterThan(0);
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledWith({
      err: "daemon down",
      method: "converse",
      model: "llama3.1:8b"
    });
  });

  it("logs once with method/model/reason and returns the fake when analyze's model call throws", async () => {
    const { coach, onFallback } = makeCoach(vi.fn().mockRejectedValue(new Error("timeout")));

    const result = await coach.analyze(request);
    expect(result.chunkGrades).toHaveLength(1);
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledWith({
      err: "timeout",
      method: "analyze",
      model: "llama3.1:8b"
    });
  });

  it("logs once when converse output is unparseable, naming the parse reason", async () => {
    const { coach, onFallback } = makeCoach(vi.fn().mockResolvedValue("no braces here"));

    await coach.converse(converseRequest);
    expect(onFallback).toHaveBeenCalledTimes(1);
    const info = onFallback.mock.calls[0]?.[0];
    expect(info).toMatchObject({ method: "converse", model: "llama3.1:8b" });
    expect(info.err).toContain("No JSON object");
  });

  it("logs once when analyze output is unparseable", async () => {
    const { coach, onFallback } = makeCoach(vi.fn().mockResolvedValue("not json"));

    await coach.analyze(request);
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback.mock.calls[0]?.[0]).toMatchObject({
      method: "analyze",
      model: "llama3.1:8b"
    });
  });

  it("reports a non-Error thrown value as its string form", async () => {
    const { coach, onFallback } = makeCoach(vi.fn().mockRejectedValue("plain string failure"));

    await coach.converse(converseRequest);
    expect(onFallback).toHaveBeenCalledWith({
      err: "plain string failure",
      method: "converse",
      model: "llama3.1:8b"
    });
  });

  it("logs nothing on a successful converse or analyze call", async () => {
    const converse = makeCoach(vi.fn().mockResolvedValue('{"say":"Go on, what would you say?"}'));
    await converse.coach.converse(converseRequest);
    expect(converse.onFallback).not.toHaveBeenCalled();

    const analyze = makeCoach(vi.fn().mockResolvedValue(judgeJson));
    await analyze.coach.analyze(request);
    expect(analyze.onFallback).not.toHaveBeenCalled();
  });
});
