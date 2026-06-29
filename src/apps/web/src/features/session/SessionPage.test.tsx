// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./sessionApi", () => ({
  endSession: vi.fn(),
  say: vi.fn(),
  startSession: vi.fn(),
  transcribe: vi.fn()
}));

import type { DebriefDto, SessionPlanDto } from "@whetstone/contracts";

import { endSession, say, startSession, transcribe } from "./sessionApi";
import { SessionPage, type LiveDependencies } from "./SessionPage";

const mockedStart = vi.mocked(startSession);
const mockedSay = vi.mocked(say);
const mockedTranscribe = vi.mocked(transcribe);
const mockedEnd = vi.mocked(endSession);

const cue: SessionPlanDto["cues"][number] = {
  caseId: "k.table",
  chunkId: "c1",
  communicativeFunction: "Offering food",
  situation: "Welcoming a guest to the table",
  target: "Help yourself.",
  timerSeconds: 20
};

const oneCue: SessionPlanDto = { cues: [cue] };

const richDebrief: DebriefDto = {
  due: [{ dueAt: "2026-01-02T00:00:00.000Z", text: "Dig in." }],
  encouragement: "Good round — one landed cleanly.",
  moments: [
    {
      native: "Would you like more?",
      said: "you want more",
      why: "Reach for the native phrasing."
    },
    { native: "Make yourself comfortable.", said: "", why: "You went quiet here." }
  ],
  upgrade: { native: "Make yourself at home.", said: "be at home" },
  wins: ['Nailed "Help yourself.".']
};

const emptyDebrief: DebriefDto = {
  due: [],
  encouragement: "Good effort — let's lock in a phrasing next time.",
  moments: [],
  upgrade: { native: "Keep it natural.", said: "what you tried" },
  wins: []
};

function fakeLive(overrides?: { supported?: boolean; startRejects?: boolean }) {
  const callbacks: {
    onUtterance: ((audio: Blob) => void) | undefined;
    onBargeIn: (() => void) | undefined;
  } = { onBargeIn: undefined, onUtterance: undefined };
  const capture = {
    finishUtterance: vi.fn(),
    setCoachPlaying: vi.fn(),
    start: vi.fn(
      overrides?.startRejects === true
        ? async () => Promise.reject(new Error("denied"))
        : async () => {}
    ),
    stop: vi.fn()
  };
  const voice = { cancel: vi.fn(), speak: vi.fn(async () => {}) };
  const live: LiveDependencies = {
    createCapture: (cb) => {
      callbacks.onUtterance = cb.onUtterance;
      callbacks.onBargeIn = cb.onBargeIn;
      return capture;
    },
    createVoiceOut: () => voice,
    supported: overrides?.supported ?? true
  };
  return { callbacks, capture, live, voice };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("SessionPage", () => {
  it("shows a loading state while the call starts", () => {
    mockedStart.mockReturnValue(new Promise<SessionPlanDto>(() => {}));
    render(<SessionPage />);
    expect(screen.getByText("Setting up your call…")).toBeDefined();
  });

  it("shows an error with a retry when the call cannot start", async () => {
    mockedStart.mockRejectedValue(new Error("boom"));
    render(<SessionPage />);

    expect(await screen.findByRole("alert")).toBeDefined();
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("alert")).toBeDefined();
    expect(mockedStart).toHaveBeenCalledTimes(2);
  });

  it("shows an empty state when there is nothing to practise", async () => {
    mockedStart.mockResolvedValue({ cues: [] });
    render(<SessionPage />);
    expect(await screen.findByText(/Nothing to practise/)).toBeDefined();
  });

  it("runs a typed turn through the coach without a per-turn grade (no-mic fallback)", async () => {
    mockedStart.mockResolvedValue(oneCue);
    mockedSay.mockResolvedValue({ say: "Tell me more." });
    const user = userEvent.setup();
    render(<SessionPage />);

    await screen.findByText("Welcoming a guest to the table");
    expect(screen.queryByRole("button", { name: "Start call" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(mockedSay).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("Or type what you'd say"), "help yourself");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("help yourself")).toBeDefined();
    expect(await screen.findByText("Tell me more.")).toBeDefined();
    expect(mockedSay).toHaveBeenCalledWith({ caseId: "k.table", transcript: "help yourself" });
  });

  it("surfaces a light-repair recast as a second coach caption", async () => {
    mockedStart.mockResolvedValue(oneCue);
    mockedSay.mockResolvedValue({
      repair: { reason: "stuck", recast: "Try a short sentence." },
      say: "No rush."
    });
    const user = userEvent.setup();
    render(<SessionPage />);

    await screen.findByText("Welcoming a guest to the table");
    await user.type(screen.getByLabelText("Or type what you'd say"), "uh");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("No rush.")).toBeDefined();
    expect(await screen.findByText("Try a short sentence.")).toBeDefined();
  });

  it("shows an error when the typed turn fails", async () => {
    mockedStart.mockResolvedValue(oneCue);
    mockedSay.mockRejectedValue(new Error("boom"));
    const user = userEvent.setup();
    render(<SessionPage />);

    await screen.findByText("Welcoming a guest to the table");
    await user.type(screen.getByLabelText("Or type what you'd say"), "help yourself");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByRole("alert")).toBeDefined();
  });

  it("runs the spoken loop and carries word-timings into the end-of-round analysis", async () => {
    mockedStart.mockResolvedValue(oneCue);
    mockedTranscribe.mockResolvedValue({
      transcript: "help yourself",
      words: [{ end: 400, start: 0, text: "help" }]
    });
    mockedSay.mockResolvedValue({ say: "And then what?" });
    mockedEnd.mockResolvedValue(richDebrief);
    const { callbacks, capture, live, voice } = fakeLive();
    const user = userEvent.setup();
    render(<SessionPage live={live} />);

    await screen.findByText("Welcoming a guest to the table");
    await user.click(screen.getByRole("button", { name: "Start call" }));
    expect(capture.start).toHaveBeenCalledOnce();
    expect(await screen.findByText("Listening…")).toBeDefined();

    const audio = new Blob(["x"]);
    callbacks.onUtterance?.(audio);

    expect(await screen.findByText("help yourself")).toBeDefined();
    expect(await screen.findByText("And then what?")).toBeDefined();
    expect(mockedTranscribe).toHaveBeenCalledWith(audio);
    expect(voice.speak).toHaveBeenCalledWith("And then what?");

    await user.click(screen.getByRole("button", { name: "End & review" }));

    expect(capture.stop).toHaveBeenCalled();
    expect(mockedEnd).toHaveBeenCalledWith({
      caseId: "k.table",
      words: [{ end: 400, start: 0, text: "help" }]
    });
    expect(await screen.findByText("Good round — one landed cleanly.")).toBeDefined();
    expect(screen.getByText("Would you like more?")).toBeDefined();
    expect(screen.getByText("Reach for the native phrasing.")).toBeDefined();
    expect(screen.getByText("Make yourself at home.")).toBeDefined();
    expect(screen.getByText("—")).toBeDefined();
    expect(screen.getByText("Dig in.")).toBeDefined();
    expect(screen.getByText('Nailed "Help yourself.".')).toBeDefined();
  });

  it("stops coach playback and resumes listening on barge-in", async () => {
    mockedStart.mockResolvedValue(oneCue);
    const { callbacks, live, voice } = fakeLive();
    const user = userEvent.setup();
    render(<SessionPage live={live} />);

    await screen.findByText("Welcoming a guest to the table");
    await user.click(screen.getByRole("button", { name: "Start call" }));
    await screen.findByText("Listening…");

    callbacks.onBargeIn?.();
    expect(voice.cancel).toHaveBeenCalledOnce();
  });

  it("ends a typed round to a calm debrief and can practise again", async () => {
    mockedStart.mockResolvedValue(oneCue);
    mockedEnd.mockResolvedValue(emptyDebrief);
    const user = userEvent.setup();
    render(<SessionPage />);

    await screen.findByText("Welcoming a guest to the table");
    await user.click(screen.getByRole("button", { name: "End & review" }));

    expect(mockedEnd).toHaveBeenCalledWith({ caseId: "k.table", words: [] });
    expect(await screen.findByText("Smooth round — nothing needed correcting.")).toBeDefined();
    expect(screen.queryByRole("list", { name: "Wins" })).toBeNull();
    expect(screen.queryByText("Now due to recall")).toBeNull();
    expect(screen.getByText("what you tried")).toBeDefined();

    await user.click(screen.getByRole("button", { name: "Practise again" }));
    expect(await screen.findByText("Welcoming a guest to the table")).toBeDefined();
    expect(mockedStart).toHaveBeenCalledTimes(2);
  });

  it("shows an error when the spoken path fails to transcribe", async () => {
    mockedStart.mockResolvedValue(oneCue);
    mockedTranscribe.mockRejectedValue(new Error("boom"));
    const { callbacks, capture, live } = fakeLive();
    const user = userEvent.setup();
    render(<SessionPage live={live} />);

    await screen.findByText("Welcoming a guest to the table");
    await user.click(screen.getByRole("button", { name: "Start call" }));
    await screen.findByText("Listening…");

    callbacks.onUtterance?.(new Blob(["x"]));

    expect(await screen.findByRole("alert")).toBeDefined();
    expect(capture.stop).toHaveBeenCalled();
  });

  it("degrades to typed-only with a calm notice when the mic start fails (not fatal)", async () => {
    mockedStart.mockResolvedValue(oneCue);
    mockedSay.mockResolvedValue({ say: "Tell me more." });
    const { capture, live } = fakeLive({ startRejects: true });
    const user = userEvent.setup();
    render(<SessionPage live={live} />);

    await screen.findByText("Welcoming a guest to the table");
    await user.click(screen.getByRole("button", { name: "Start call" }));
    expect(capture.start).toHaveBeenCalledOnce();

    // No fatal screen: the cue stays, a calm notice appears, Start call is gone.
    expect(await screen.findByText(/Mic unavailable/)).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Welcoming a guest to the table")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Start call" })).toBeNull();

    // The typed fallback still works end to end.
    await user.type(screen.getByLabelText("Or type what you'd say"), "help yourself");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("help yourself")).toBeDefined();
    expect(await screen.findByText("Tell me more.")).toBeDefined();
    expect(mockedSay).toHaveBeenCalledWith({ caseId: "k.table", transcript: "help yourself" });
  });

  it("hides Start call and runs typed-only when capture is unsupported", async () => {
    mockedStart.mockResolvedValue(oneCue);
    mockedSay.mockResolvedValue({ say: "Go on." });
    const { capture, live } = fakeLive({ supported: false });
    const user = userEvent.setup();
    render(<SessionPage live={live} />);

    await screen.findByText("Welcoming a guest to the table");
    expect(screen.queryByRole("button", { name: "Start call" })).toBeNull();
    expect(capture.start).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("Or type what you'd say"), "hi");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Go on.")).toBeDefined();
  });

  it("offers a calm land-the-plane nudge after the time-box, without cutting off the call", async () => {
    mockedStart.mockResolvedValue(oneCue);
    mockedEnd.mockResolvedValue(emptyDebrief);
    const user = userEvent.setup();
    render(<SessionPage timeBoxMs={10} />);

    await screen.findByText("Welcoming a guest to the table");
    // The nudge appears after the (tiny) time-box; the call is not cut off — the input remains.
    expect(await screen.findByText(/land the plane/)).toBeDefined();
    expect(screen.getByLabelText("Or type what you'd say")).toBeDefined();

    // The explicit End control still works.
    await user.click(screen.getByRole("button", { name: "End & review" }));
    expect(await screen.findByText("Smooth round — nothing needed correcting.")).toBeDefined();
  });

  it("shows an error when the end-of-round analysis fails", async () => {
    mockedStart.mockResolvedValue(oneCue);
    mockedEnd.mockRejectedValue(new Error("boom"));
    const user = userEvent.setup();
    render(<SessionPage />);

    await screen.findByText("Welcoming a guest to the table");
    await user.click(screen.getByRole("button", { name: "End & review" }));

    expect(await screen.findByRole("alert")).toBeDefined();
  });
});
