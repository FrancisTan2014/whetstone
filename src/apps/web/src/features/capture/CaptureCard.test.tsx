// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../diary/diaryApi", () => ({
  submitDiaryCapture: vi.fn()
}));

vi.mock("./voiceCaptureApi", () => ({
  submitVoiceCapture: vi.fn(),
  fetchActiveVoiceCaptures: vi.fn(),
  fetchVoiceCaptureStatus: vi.fn(),
  retryVoiceCapture: vi.fn()
}));

import type { DiaryEntryDto, VoiceCaptureStatusDto } from "@whetstone/contracts";
import { createTextDocument, documentText } from "@whetstone/document";

import {
  fetchActiveVoiceCaptures,
  fetchVoiceCaptureStatus,
  retryVoiceCapture,
  submitVoiceCapture
} from "./voiceCaptureApi";
import { submitDiaryCapture } from "../diary/diaryApi";
import { CaptureCard, type CaptureVoiceDependencies } from "./CaptureCard";

const mockedSubmit = vi.mocked(submitDiaryCapture);
const mockedVoiceSubmit = vi.mocked(submitVoiceCapture);
const mockedVoiceActive = vi.mocked(fetchActiveVoiceCaptures);
const mockedVoiceStatus = vi.mocked(fetchVoiceCaptureStatus);
const mockedVoiceRetry = vi.mocked(retryVoiceCapture);

// A deterministic voice capture seam: `start()` opens a fake recording whose `stop()` resolves a stub
// audio blob (the real MediaRecorder/Web Audio path is not exercisable in jsdom).
function fakeVoice(
  overrides: Partial<{
    start: CaptureVoiceDependencies["start"];
    supported: boolean;
  }> = {}
): CaptureVoiceDependencies {
  return {
    start: overrides.start ?? (async () => ({ stop: async () => new Blob(["audio"]) })),
    supported: overrides.supported ?? true
  };
}

function diaryEntry(text: string, overrides: Partial<DiaryEntryDto> = {}): DiaryEntryDto {
  return {
    bodyDoc: createTextDocument(text),
    bodyText: text,
    createdAt: "2026-07-06T09:30:00.000Z",
    failureReason: null,
    id: "entry-1",
    inputMode: "typed",
    language: "en",
    occurredAt: "2026-07-06T09:30:00.000Z",
    processingStatus: null,
    updatedAt: "2026-07-06T09:30:00.000Z",
    ...overrides
  };
}

function voiceStatus(overrides: Partial<VoiceCaptureStatusDto> = {}): VoiceCaptureStatusDto {
  return {
    failureReason: null,
    id: "vc-1",
    language: "en",
    occurredAt: "2026-07-06T09:30:00.000Z",
    status: "queued",
    text: null,
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  mockedVoiceActive.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
});

async function typeCapture(text: string): Promise<void> {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Capture text"), text);
  await user.click(screen.getByRole("button", { name: "Capture" }));
}

describe("CaptureCard (journal-only diary capture, #571)", () => {
  it("keeps Capture disabled until there is text", () => {
    render(<CaptureCard />);

    expect((screen.getByRole("button", { name: "Capture" }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it("offers no proposal / Make Durable controls (#571)", () => {
    render(<CaptureCard />);

    // A diary capture journals only: no history-mining action and no review card ever appears.
    expect(screen.queryByRole("button", { name: "Mine my history" })).toBeNull();
    expect(screen.queryByText("Make this durable?")).toBeNull();
  });

  it("renders a compact bilingual selector with English as the first-use default", () => {
    render(<CaptureCard />);

    expect(screen.getByRole("button", { name: "中文" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "EN" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("uses a stored English language default", () => {
    window.localStorage.setItem("whetstone.capture.language", "en");

    render(<CaptureCard />);

    expect(screen.getByRole("button", { name: "EN" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("remembers the selected language and threads it into typed captures", async () => {
    mockedSubmit.mockResolvedValue(diaryEntry("今天我读了一本书"));
    render(<CaptureCard />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "中文" }));
    await user.type(screen.getByLabelText("Capture text"), "今天我读了一本书");
    await user.click(screen.getByRole("button", { name: "Capture" }));

    expect(window.localStorage.getItem("whetstone.capture.language")).toBe("zh");
    expect(mockedSubmit).toHaveBeenCalledWith("今天我读了一本书", "typed", "zh");

    cleanup();
    render(<CaptureCard />);
    expect(screen.getByRole("button", { name: "中文" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("saves a typed capture and hands the diary Entry to the parent (#571)", async () => {
    const entry = diaryEntry("I couldn't say it");
    mockedSubmit.mockResolvedValue(entry);
    const onCaptured = vi.fn();
    render(<CaptureCard onCaptured={onCaptured} />);

    await typeCapture("I couldn't say it");

    expect(mockedSubmit).toHaveBeenCalledWith("I couldn't say it", "typed", "en");
    expect(onCaptured).toHaveBeenCalledWith(entry);
  });

  it("clears the typed box after a successful capture", async () => {
    mockedSubmit.mockResolvedValue(diaryEntry("diary text"));
    render(<CaptureCard />);

    await typeCapture("diary text");

    await waitFor(() =>
      expect((screen.getByLabelText("Capture text") as HTMLTextAreaElement).value).toBe("")
    );
  });

  it("surfaces a quiet error when the capture fails", async () => {
    mockedSubmit.mockRejectedValue(new Error("boom"));
    render(<CaptureCard />);

    await typeCapture("try me");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't save your capture");
  });

  it("ignores a capture submit with no text", () => {
    render(<CaptureCard />);

    const form = screen.getByLabelText("Capture text").closest("form");
    fireEvent.submit(form as HTMLFormElement);

    expect(mockedSubmit).not.toHaveBeenCalled();
  });
});

describe("CaptureCard voice capture (saved-first, #566)", () => {
  it("hides the voice control when capture is unsupported (typed box remains)", () => {
    render(<CaptureCard capture={fakeVoice({ supported: false })} />);

    expect(screen.queryByRole("button", { name: "Tap to talk" })).toBeNull();
    expect(screen.getByLabelText("Capture text")).toBeTruthy();
  });

  it("saves the recorded audio first and shows the pending capture", async () => {
    mockedVoiceSubmit.mockResolvedValue({ id: "vc-1", status: "queued" });
    // The submit rebuilds the list from the server: it now returns the saved, still-queued capture.
    mockedVoiceActive.mockResolvedValueOnce([]).mockResolvedValue([voiceStatus()]);
    render(<CaptureCard capture={fakeVoice()} />);
    await waitFor(() => expect(mockedVoiceActive).toHaveBeenCalled());
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Tap to talk" }));
    await user.click(await screen.findByRole("button", { name: "Stop & save" }));

    expect(mockedVoiceSubmit).toHaveBeenCalledWith(expect.any(Blob), "en");
    expect(await screen.findByText("Saved — waiting to transcribe…")).toBeTruthy();
  });

  it("threads the selected language into the saved audio", async () => {
    mockedVoiceSubmit.mockResolvedValue({ id: "vc-1", status: "queued" });
    render(<CaptureCard capture={fakeVoice()} />);
    await waitFor(() => expect(mockedVoiceActive).toHaveBeenCalled());
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "中文" }));
    await user.click(screen.getByRole("button", { name: "Tap to talk" }));
    await user.click(await screen.findByRole("button", { name: "Stop & save" }));

    expect(mockedVoiceSubmit).toHaveBeenCalledWith(expect.any(Blob), "zh");
  });

  it("shows a calm retry and saves nothing when no speech is caught", async () => {
    const start = vi.fn(async () => ({ stop: async () => new Blob() }));
    render(<CaptureCard capture={fakeVoice({ start })} />);
    await waitFor(() => expect(mockedVoiceActive).toHaveBeenCalled());
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Tap to talk" }));
    await user.click(await screen.findByRole("button", { name: "Stop & save" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Didn't catch any speech");
    expect(mockedVoiceSubmit).not.toHaveBeenCalled();
    // The control returns to idle so the learner can retry or type.
    expect(screen.getByRole("button", { name: "Tap to talk" })).toBeTruthy();
  });

  it("falls back to typing when the microphone can't be reached", async () => {
    const start = vi.fn().mockRejectedValue(new Error("denied"));
    render(<CaptureCard capture={fakeVoice({ start })} />);
    await waitFor(() => expect(mockedVoiceActive).toHaveBeenCalled());

    await userEvent.setup().click(screen.getByRole("button", { name: "Tap to talk" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't reach the microphone");
    expect(screen.getByLabelText("Capture text")).toBeTruthy();
  });

  it("surfaces a quiet error when saving the audio fails", async () => {
    mockedVoiceSubmit.mockRejectedValue(new Error("save down"));
    render(<CaptureCard capture={fakeVoice()} />);
    await waitFor(() => expect(mockedVoiceActive).toHaveBeenCalled());
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Tap to talk" }));
    await user.click(await screen.findByRole("button", { name: "Stop & save" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't save your capture");
  });

  it("rebuilds saved pending captures from the server on mount", async () => {
    mockedVoiceActive.mockResolvedValue([voiceStatus({ id: "vc-1", status: "transcribing" })]);
    render(<CaptureCard capture={fakeVoice()} />);

    expect(await screen.findByText("Transcribing…")).toBeTruthy();
  });

  it("renders multiple pending captures in capture order", async () => {
    mockedVoiceActive.mockResolvedValue([
      voiceStatus({ id: "vc-1", occurredAt: "2026-07-06T09:00:00.000Z", status: "transcribing" }),
      voiceStatus({ id: "vc-2", occurredAt: "2026-07-06T09:05:00.000Z", status: "tidying" })
    ]);
    render(<CaptureCard capture={fakeVoice()} />);

    const first = await screen.findByText("Transcribing…");
    const second = screen.getByText("Tidying up…");
    // Oldest capture renders above the newer one.
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("polls a pending capture and hands the ready diary Entry to the parent (#571)", async () => {
    vi.useFakeTimers();
    try {
      mockedVoiceActive.mockResolvedValue([voiceStatus({ id: "vc-1", status: "transcribing" })]);
      mockedVoiceStatus.mockResolvedValue(
        voiceStatus({ id: "vc-1", status: "ready", text: "WorkInsight is back up now" })
      );
      const onCaptured = vi.fn();
      render(<CaptureCard capture={fakeVoice()} onCaptured={onCaptured} />);

      // Flush the mount refresh so the pending row (and its polling effect) is committed.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });

      expect(mockedVoiceStatus).toHaveBeenCalledWith("vc-1");
      const entry = onCaptured.mock.calls[0]?.[0] as DiaryEntryDto;
      expect(entry.id).toBe("vc-1");
      expect(entry.inputMode).toBe("voice");
      expect(entry.processingStatus).toBe("ready");
      expect(entry.occurredAt).toBe("2026-07-06T09:30:00.000Z");
      expect(entry.bodyText).toBe("WorkInsight is back up now");
      expect(documentText(entry.bodyDoc)).toBe("WorkInsight is back up now");
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces a quiet error when finalizing the recording throws", async () => {
    // handle.stop() rejecting (a mic/encoder glitch) is the catch path: nothing is submitted and the
    // learner sees the calm save error rather than a crash.
    const start = vi.fn(async () => ({
      stop: async () => {
        throw new Error("mic glitch");
      }
    }));
    render(<CaptureCard capture={fakeVoice({ start })} />);
    await waitFor(() => expect(mockedVoiceActive).toHaveBeenCalled());
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Tap to talk" }));
    await user.click(await screen.findByRole("button", { name: "Stop & save" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't save your capture");
    expect(mockedVoiceSubmit).not.toHaveBeenCalled();
  });

  it("guards a refresh/navigation while a recording is in flight", async () => {
    // While recording (before the audio is saved) the beforeunload guard is armed so a refresh cannot
    // silently drop the clip: the event is cancelled.
    render(<CaptureCard capture={fakeVoice()} />);
    await waitFor(() => expect(mockedVoiceActive).toHaveBeenCalled());
    await userEvent.setup().click(screen.getByRole("button", { name: "Tap to talk" }));
    await screen.findByRole("button", { name: "Stop & save" });

    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it("drops a ready capture without a parent listener without crashing", async () => {
    // No onCaptured prop (Today mounts CaptureCard without one): the ready capture still graduates out of
    // the processing list; the optional handoff is simply skipped.
    vi.useFakeTimers();
    try {
      mockedVoiceActive.mockResolvedValue([voiceStatus({ id: "vc-1", status: "transcribing" })]);
      mockedVoiceStatus.mockResolvedValue(
        voiceStatus({ id: "vc-1", status: "ready", text: "all clear" })
      );
      render(<CaptureCard capture={fakeVoice()} />);

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });

      expect(screen.queryByText("Transcribing…")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not push a ready capture with no text to the timeline", async () => {
    // A ready row that carries no text is not a diary entry: it graduates out but onCaptured never fires.
    vi.useFakeTimers();
    try {
      mockedVoiceActive.mockResolvedValue([voiceStatus({ id: "vc-1", status: "transcribing" })]);
      mockedVoiceStatus.mockResolvedValue(voiceStatus({ id: "vc-1", status: "ready", text: null }));
      const onCaptured = vi.fn();
      render(<CaptureCard capture={fakeVoice()} onCaptured={onCaptured} />);

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });

      expect(onCaptured).not.toHaveBeenCalled();
      expect(screen.queryByText("Transcribing…")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a failed capture with a Retry that re-queues it", async () => {
    mockedVoiceActive.mockResolvedValue([voiceStatus({ id: "vc-1", status: "failed" })]);
    mockedVoiceRetry.mockResolvedValue(voiceStatus({ id: "vc-1", status: "queued" }));
    render(<CaptureCard capture={fakeVoice()} />);

    expect(await screen.findByText("Couldn't transcribe — your recording is safe.")).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }));

    expect(mockedVoiceRetry).toHaveBeenCalledWith("vc-1");
    expect(await screen.findByText("Saved — waiting to transcribe…")).toBeTruthy();
  });

  it("surfaces a quiet error when a retry fails", async () => {
    mockedVoiceActive.mockResolvedValue([voiceStatus({ id: "vc-1", status: "failed" })]);
    mockedVoiceRetry.mockRejectedValue(new Error("nope"));
    render(<CaptureCard capture={fakeVoice()} />);

    await screen.findByText("Couldn't transcribe — your recording is safe.");
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Couldn't retry that capture. Please try again.")).toBeTruthy();
  });
});
