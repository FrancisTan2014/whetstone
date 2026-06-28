// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./sessionApi", () => ({
  say: vi.fn(),
  startSession: vi.fn(),
  transcribe: vi.fn()
}));

import type { CoachConverseResult, SessionPlanDto } from "@whetstone/contracts";

import { say, startSession, transcribe } from "./sessionApi";
import { SessionPage, type LiveDependencies } from "./SessionPage";

const mockedStart = vi.mocked(startSession);
const mockedSay = vi.mocked(say);
const mockedTranscribe = vi.mocked(transcribe);

const cue: SessionPlanDto["cues"][number] = {
  caseId: "k.table",
  chunkId: "c1",
  communicativeFunction: "Offering food",
  situation: "Welcoming a guest to the table",
  target: "Help yourself.",
  timerSeconds: 20
};

const oneCue: SessionPlanDto = { cues: [cue] };

// A fake live stack: captures the callbacks the page registers so a test can drive utterance-end and
// barge-in, and records capture/voice calls. No real audio or speech is touched.
function fakeLive() {
  const callbacks: {
    onUtterance: ((audio: Blob) => void) | undefined;
    onBargeIn: (() => void) | undefined;
  } = { onBargeIn: undefined, onUtterance: undefined };
  const capture = {
    finishUtterance: vi.fn(),
    setCoachPlaying: vi.fn(),
    start: vi.fn(async () => {}),
    stop: vi.fn()
  };
  const voice = { cancel: vi.fn(), speak: vi.fn(async () => {}) };
  const live: LiveDependencies = {
    createCapture: (cb) => {
      callbacks.onUtterance = cb.onUtterance;
      callbacks.onBargeIn = cb.onBargeIn;
      return capture;
    },
    createVoiceOut: () => voice
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
    const retry = screen.getByRole("button", { name: "Try again" });
    await userEvent.setup().click(retry);
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
    // No mic: there is no Start call control, only the typed fallback.
    expect(screen.queryByRole("button", { name: "Start call" })).toBeNull();

    // A blank submit is ignored.
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
    } satisfies CoachConverseResult);
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

  it("runs the spoken loop: start -> utterance -> STT -> coach -> TTS -> back to listening", async () => {
    mockedStart.mockResolvedValue(oneCue);
    mockedTranscribe.mockResolvedValue({ transcript: "help yourself" });
    mockedSay.mockResolvedValue({ say: "And then what?" });
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
    expect(mockedSay).toHaveBeenCalledWith({ caseId: "k.table", transcript: "help yourself" });
    expect(voice.speak).toHaveBeenCalledWith("And then what?");
    expect(capture.setCoachPlaying).toHaveBeenNthCalledWith(1, true);
    expect(capture.setCoachPlaying).toHaveBeenNthCalledWith(2, false);
    expect(await screen.findByText("Listening…")).toBeDefined();
  });

  it("stops coach playback and resumes listening on barge-in", async () => {
    mockedStart.mockResolvedValue(oneCue);
    const { callbacks, capture, live, voice } = fakeLive();
    const user = userEvent.setup();
    render(<SessionPage live={live} />);

    await screen.findByText("Welcoming a guest to the table");
    await user.click(screen.getByRole("button", { name: "Start call" }));
    await screen.findByText("Listening…");

    callbacks.onBargeIn?.();

    await waitFor(() => expect(voice.cancel).toHaveBeenCalledOnce());
    expect(capture.setCoachPlaying).toHaveBeenLastCalledWith(false);
  });

  it("ends the call to a completion state and can start another", async () => {
    mockedStart.mockResolvedValue(oneCue);
    mockedTranscribe.mockResolvedValue({ transcript: "help yourself" });
    mockedSay.mockResolvedValue({ say: "Go on." });
    const { callbacks, capture, live, voice } = fakeLive();
    const user = userEvent.setup();
    render(<SessionPage live={live} />);

    await screen.findByText("Welcoming a guest to the table");
    await user.click(screen.getByRole("button", { name: "Start call" }));
    await screen.findByText("Listening…");
    callbacks.onUtterance?.(new Blob(["x"]));
    await screen.findByText("Go on.");

    await user.click(screen.getByRole("button", { name: "End" }));

    expect(capture.stop).toHaveBeenCalledOnce();
    expect(voice.cancel).toHaveBeenCalled();
    expect(await screen.findByText("Call complete")).toBeDefined();
    expect(screen.getByText(/spoke 1 turn/)).toBeDefined();

    await user.click(screen.getByRole("button", { name: "Start another" }));
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
});
