// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./sessionApi", () => ({
  endSession: vi.fn(),
  startSession: vi.fn(),
  submitTurn: vi.fn(),
  transcribe: vi.fn()
}));

import type { SessionPlanDto, TurnResultDto } from "@whetstone/contracts";

import { endSession, startSession, submitTurn, transcribe } from "./sessionApi";
import { SessionPage } from "./SessionPage";

const mockedStart = vi.mocked(startSession);
const mockedSubmit = vi.mocked(submitTurn);
const mockedEnd = vi.mocked(endSession);
const mockedTranscribe = vi.mocked(transcribe);

const cueA: SessionPlanDto["cues"][number] = {
  caseId: "k.table",
  chunkId: "c1",
  communicativeFunction: "Offering food",
  situation: "Welcoming a guest to the table",
  target: "Help yourself.",
  timerSeconds: 20
};

const cueB: SessionPlanDto["cues"][number] = {
  caseId: "k.table",
  chunkId: "c2",
  communicativeFunction: "Encouraging",
  situation: "Urging them to start",
  target: "Dig in.",
  timerSeconds: 20
};

const twoCues: SessionPlanDto = { cues: [cueA, cueB] };
const oneCue: SessionPlanDto = { cues: [cueA] };

const perfectResult: TurnResultDto = {
  errorCategory: null,
  grade: 5,
  judgement: { category: "native_like", issues: [], natural: 1 },
  nextDueAt: "2026-01-02T00:00:00.000Z",
  target: "Help yourself.",
  transcript: "help yourself"
};

const flawedResult: TurnResultDto = {
  errorCategory: "register",
  grade: 2,
  judgement: {
    category: "awkward",
    issues: [{ kind: "register", note: "Too formal for the table.", severity: "minor" }],
    natural: 0.5
  },
  nextDueAt: "2026-01-02T00:00:00.000Z",
  target: "Dig in.",
  transcript: "please commence eating"
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("SessionPage", () => {
  it("shows a loading state while the session starts", () => {
    mockedStart.mockReturnValue(new Promise<SessionPlanDto>(() => {}));
    render(<SessionPage />);
    expect(screen.getByText("Setting up your session…")).toBeDefined();
  });

  it("shows an error with a retry when the session cannot start", async () => {
    mockedStart.mockRejectedValue(new Error("boom"));
    render(<SessionPage />);
    expect(await screen.findByRole("alert")).toBeDefined();
    const retry = screen.getByRole("button", { name: "Try again" });
    expect(retry).toBeDefined();
    // Retrying while still failing keeps the error state (covers restart's failure path).
    await userEvent.setup().click(retry);
    expect(await screen.findByRole("alert")).toBeDefined();
    expect(mockedStart).toHaveBeenCalledTimes(2);
  });

  it("shows an empty state when there is nothing to practise", async () => {
    mockedStart.mockResolvedValue({ cues: [] });
    render(<SessionPage />);
    expect(await screen.findByText(/Nothing to practise/)).toBeDefined();
  });

  it("runs the full loop: cue -> produce -> feedback -> next -> summary", async () => {
    mockedStart.mockResolvedValue(twoCues);
    mockedSubmit.mockResolvedValueOnce(perfectResult).mockResolvedValueOnce(flawedResult);
    mockedEnd.mockResolvedValue({
      averageGrade: 3.5,
      errorCounts: [{ category: "register", count: 1 }],
      strongTurns: 1,
      turnCount: 2
    });
    const user = userEvent.setup();
    render(<SessionPage />);

    // First cue: the English situation is shown, never an L1 prompt.
    expect(await screen.findByText("Welcoming a guest to the table")).toBeDefined();
    await user.type(screen.getByLabelText("Or type what you said"), "help yourself");
    await user.click(screen.getByRole("button", { name: "Submit" }));

    // Feedback reveals the native target and that it sounded natural.
    expect(await screen.findByText("Help yourself.")).toBeDefined();
    expect(screen.getByText("That sounded natural.")).toBeDefined();
    expect(mockedSubmit).toHaveBeenCalledWith({ chunkId: "c1", transcript: "help yourself" });

    await user.click(screen.getByRole("button", { name: "Next" }));

    // Second (last) cue.
    expect(await screen.findByText("Urging them to start")).toBeDefined();
    await user.type(screen.getByLabelText("Or type what you said"), "please commence eating");
    await user.click(screen.getByRole("button", { name: "Submit" }));

    expect(await screen.findByText("Too formal for the table.")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Finish" }));

    // Summary persists the recap; the accumulated grades are sent to endSession.
    expect(await screen.findByText("Session complete")).toBeDefined();
    expect(mockedEnd).toHaveBeenCalledWith({
      turns: [
        { errorCategory: null, grade: 5 },
        { errorCategory: "register", grade: 2 }
      ]
    });
    const summary = screen.getByRole("list", { name: "Session summary" });
    expect(summary.textContent).toContain("Average grade 3.5");
    expect(screen.getByText("register · 1")).toBeDefined();

    // Practise again restarts the loop (covers restart's success path).
    await user.click(screen.getByRole("button", { name: "Practise again" }));
    expect(await screen.findByText("Welcoming a guest to the table")).toBeDefined();
    expect(mockedStart).toHaveBeenCalledTimes(2);
  });

  it("shows an error when submitting a turn fails", async () => {
    mockedStart.mockResolvedValue(twoCues);
    mockedSubmit.mockRejectedValue(new Error("boom"));
    const user = userEvent.setup();
    render(<SessionPage />);

    await screen.findByText("Welcoming a guest to the table");
    await user.click(screen.getByRole("button", { name: "Submit" }));

    expect(await screen.findByRole("alert")).toBeDefined();
  });

  it("shows an error when ending the session fails", async () => {
    mockedStart.mockResolvedValue(oneCue);
    mockedSubmit.mockResolvedValue(perfectResult);
    mockedEnd.mockRejectedValue(new Error("boom"));
    const user = userEvent.setup();
    render(<SessionPage />);

    await screen.findByText("Welcoming a guest to the table");
    await user.click(screen.getByRole("button", { name: "Submit" }));
    await user.click(await screen.findByRole("button", { name: "Finish" }));

    expect(await screen.findByRole("alert")).toBeDefined();
  });

  it("records and transcribes through the STT seam before submitting the turn", async () => {
    mockedStart.mockResolvedValue(oneCue);
    const audio = new Uint8Array([1, 2, 3]);
    const captureAudio = vi.fn(async () => audio);
    mockedTranscribe.mockResolvedValue({ transcript: "help yourself" });
    mockedSubmit.mockResolvedValue(perfectResult);
    const user = userEvent.setup();
    render(<SessionPage captureAudio={captureAudio} />);

    await screen.findByText("Welcoming a guest to the table");
    await user.click(screen.getByRole("button", { name: "Record & transcribe" }));

    expect(await screen.findByText("Help yourself.")).toBeDefined();
    expect(captureAudio).toHaveBeenCalledOnce();
    // The STT seam is called with the recorded bytes, then the recognized transcript is submitted.
    expect(mockedTranscribe).toHaveBeenCalledWith(audio);
    expect(mockedSubmit).toHaveBeenCalledWith({ chunkId: "c1", transcript: "help yourself" });
  });

  it("shows an error when the spoken path fails", async () => {
    mockedStart.mockResolvedValue(oneCue);
    mockedTranscribe.mockRejectedValue(new Error("boom"));
    const user = userEvent.setup();
    render(<SessionPage captureAudio={vi.fn(async () => new Uint8Array([1]))} />);

    await screen.findByText("Welcoming a guest to the table");
    await user.click(screen.getByRole("button", { name: "Record & transcribe" }));

    expect(await screen.findByRole("alert")).toBeDefined();
  });

  it("omits the error list when a session has no recurring errors", async () => {
    mockedStart.mockResolvedValue(oneCue);
    mockedSubmit.mockResolvedValue(perfectResult);
    mockedEnd.mockResolvedValue({
      averageGrade: 5,
      errorCounts: [],
      strongTurns: 1,
      turnCount: 1
    });
    const user = userEvent.setup();
    render(<SessionPage />);

    await screen.findByText("Welcoming a guest to the table");
    await user.click(screen.getByRole("button", { name: "Submit" }));
    await user.click(await screen.findByRole("button", { name: "Finish" }));

    expect(await screen.findByText("Session complete")).toBeDefined();
    expect(screen.queryByRole("list", { name: "Errors to watch" })).toBeNull();
  });
});
