// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../makeDurable/makeDurableApi", () => ({
  fetchMakeDurableCards: vi.fn(),
  reviewMakeDurableCard: vi.fn(),
  runMakeDurableBackfill: vi.fn()
}));

vi.mock("../diary/diaryApi", () => ({
  submitDiaryCapture: vi.fn()
}));

vi.mock("./voiceCaptureApi", () => ({
  submitVoiceCapture: vi.fn(),
  fetchActiveVoiceCaptures: vi.fn(),
  fetchVoiceCaptureStatus: vi.fn(),
  retryVoiceCapture: vi.fn()
}));

import type {
  DiaryCaptureResultDto,
  MakeDurableCardDto,
  RecallItemDto,
  VoiceCaptureStatusDto
} from "@whetstone/contracts";

import {
  fetchActiveVoiceCaptures,
  fetchVoiceCaptureStatus,
  retryVoiceCapture,
  submitVoiceCapture
} from "./voiceCaptureApi";
import {
  fetchMakeDurableCards,
  reviewMakeDurableCard,
  runMakeDurableBackfill
} from "../makeDurable/makeDurableApi";
import { submitDiaryCapture } from "../diary/diaryApi";
import { CaptureCard, type CaptureVoiceDependencies } from "./CaptureCard";

const mockedFetch = vi.mocked(fetchMakeDurableCards);
const mockedSubmit = vi.mocked(submitDiaryCapture);
const mockedReview = vi.mocked(reviewMakeDurableCard);
const mockedBackfill = vi.mocked(runMakeDurableBackfill);
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

const card: MakeDurableCardDto = {
  proposalCandidateId: "cand-1",
  timelineEntryId: "entry-1",
  type: "phrase_chunk",
  target: "WorkInsight is back up now",
  cue: "a service is back",
  useContext: "reporting availability",
  reason: "a reusable status phrase",
  category: "work",
  tags: ["service-status"]
};

function recallItem(): RecallItemDto {
  return {
    chunkId: null,
    createdAt: "2026-07-06T09:30:00.000Z",
    gloss: null,
    id: "recall-1",
    kind: "phrase",
    provenanceEntryId: null,
    review: {
      dueAt: "2026-07-06T09:30:00.000Z",
      easeFactor: 2.5,
      intervalDays: 0,
      lapses: 0,
      lastReviewedAt: null,
      repetitions: 0
    },
    text: "WorkInsight is back up now",
    cue: "a service is back",
    useContext: "reporting availability",
    category: "work",
    tags: ["service-status"],
    sourceProposalCandidateId: "cand-1"
  };
}

function captureResult(withCard: MakeDurableCardDto | null): DiaryCaptureResultDto {
  return {
    card: withCard,
    entry: {
      createdAt: "2026-07-06T09:30:00.000Z",
      entryDate: "2026-07-06",
      id: "entry-1",
      language: "en",
      text: "the deploy failed"
    }
  };
}

function voiceStatus(overrides: Partial<VoiceCaptureStatusDto> = {}): VoiceCaptureStatusDto {
  return {
    createdAt: "2026-07-06T09:30:00.000Z",
    entryDate: "2026-07-06",
    failureReason: null,
    id: "vc-1",
    language: "en",
    status: "queued",
    text: null,
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  mockedFetch.mockResolvedValue([]);
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

describe("CaptureCard", () => {
  it("loads and shows pending cards on mount", async () => {
    mockedFetch.mockResolvedValue([card]);
    render(<CaptureCard />);

    expect(await screen.findByText("WorkInsight is back up now")).toBeTruthy();
  });

  it("keeps Capture disabled until there is text", async () => {
    render(<CaptureCard />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalled());

    expect((screen.getByRole("button", { name: "Capture" }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it("renders a compact bilingual selector with English as the first-use default", async () => {
    render(<CaptureCard />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalled());

    expect(screen.getByRole("button", { name: "中文" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "EN" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("uses a stored English language default", async () => {
    window.localStorage.setItem("whetstone.capture.language", "en");

    render(<CaptureCard />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalled());

    expect(screen.getByRole("button", { name: "EN" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("remembers the selected language and threads it into typed captures", async () => {
    mockedSubmit.mockResolvedValue(captureResult(null));
    render(<CaptureCard />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalled());
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "中文" }));
    await user.type(screen.getByLabelText("Capture text"), "今天我读了一本书");
    await user.click(screen.getByRole("button", { name: "Capture" }));

    expect(window.localStorage.getItem("whetstone.capture.language")).toBe("zh");
    expect(mockedSubmit).toHaveBeenCalledWith("今天我读了一本书", "typed", "zh");

    cleanup();
    vi.clearAllMocks();
    mockedFetch.mockResolvedValue([]);
    render(<CaptureCard />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "中文" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("degrades quietly and still offers capture when the cards fail to load on mount", async () => {
    mockedFetch.mockRejectedValue(new Error("boom"));
    render(<CaptureCard />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalled());

    // No card and no error banner — a failed load simply leaves the always-present capture box.
    expect(screen.queryByText("Make this durable?")).toBeNull();
    expect(screen.getByLabelText("Capture text")).toBeTruthy();
  });

  it("submits a capture and shows the returned review card", async () => {
    mockedSubmit.mockResolvedValue(captureResult(card));
    render(<CaptureCard />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalled());

    await typeCapture("I couldn't say it");

    expect(mockedSubmit).toHaveBeenCalledWith("I couldn't say it", "typed", "en");
    expect(await screen.findByText("WorkInsight is back up now")).toBeTruthy();
  });

  it("notifies the parent with the saved diary entry after capture", async () => {
    const result = captureResult(null);
    mockedSubmit.mockResolvedValue(result);
    const onCaptured = vi.fn();
    render(<CaptureCard onCaptured={onCaptured} />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalled());

    await typeCapture("diary text");

    expect(onCaptured).toHaveBeenCalledWith(result.entry);
  });

  it("shows no card when the capture yields no proposal", async () => {
    mockedSubmit.mockResolvedValue(captureResult(null));
    render(<CaptureCard />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalled());

    await typeCapture("nothing special");

    expect(screen.queryByText("Make this durable?")).toBeNull();
  });

  it("surfaces a quiet error when the capture fails", async () => {
    mockedSubmit.mockRejectedValue(new Error("boom"));
    render(<CaptureCard />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalled());

    await typeCapture("try me");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't save your capture");
  });

  it("saves an approved card and removes it", async () => {
    mockedFetch.mockResolvedValue([card]);
    mockedReview.mockResolvedValue(null);
    render(<CaptureCard />);
    await screen.findByText("WorkInsight is back up now");

    await userEvent.setup().click(screen.getByRole("button", { name: "Save" }));

    expect(mockedReview).toHaveBeenCalledWith("cand-1", { outcome: "saved" });
    await waitFor(() => expect(screen.queryByText("WorkInsight is back up now")).toBeNull());
  });

  it("notifies the parent when a save creates a recall item (#509)", async () => {
    mockedFetch.mockResolvedValue([card]);
    mockedReview.mockResolvedValue(recallItem());
    const onDurableSaved = vi.fn();
    render(<CaptureCard onDurableSaved={onDurableSaved} />);
    await screen.findByText("WorkInsight is back up now");

    await userEvent.setup().click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onDurableSaved).toHaveBeenCalledTimes(1));
  });

  it("does not notify the parent for a negative outcome that creates no recall item (#509)", async () => {
    mockedFetch.mockResolvedValue([card]);
    mockedReview.mockResolvedValue(null);
    const onDurableSaved = vi.fn();
    render(<CaptureCard onDurableSaved={onDurableSaved} />);
    await screen.findByText("WorkInsight is back up now");

    await userEvent.setup().click(screen.getByRole("button", { name: "Not useful now" }));

    await waitFor(() => expect(screen.queryByText("WorkInsight is back up now")).toBeNull());
    expect(onDurableSaved).not.toHaveBeenCalled();
  });

  it("does not notify the parent when the review action fails (#509)", async () => {
    mockedFetch.mockResolvedValue([card]);
    mockedReview.mockRejectedValue(new Error("nope"));
    const onDurableSaved = vi.fn();
    render(<CaptureCard onDurableSaved={onDurableSaved} />);
    await screen.findByText("WorkInsight is back up now");

    await userEvent.setup().click(screen.getByRole("button", { name: "Save" }));

    await screen.findByRole("alert");
    expect(onDurableSaved).not.toHaveBeenCalled();
  });

  it("saves without a parent listener and does not crash when a recall item is created (#509)", async () => {
    // With no onDurableSaved prop, the optional-chain call is a no-op: the card is still removed and
    // nothing throws.
    mockedFetch.mockResolvedValue([card]);
    mockedReview.mockResolvedValue(recallItem());
    render(<CaptureCard />);
    await screen.findByText("WorkInsight is back up now");

    await userEvent.setup().click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.queryByText("WorkInsight is back up now")).toBeNull());
  });

  it("dismisses a card on Not useful now", async () => {
    mockedFetch.mockResolvedValue([card]);
    mockedReview.mockResolvedValue(null);
    render(<CaptureCard />);
    await screen.findByText("WorkInsight is back up now");

    await userEvent.setup().click(screen.getByRole("button", { name: "Not useful now" }));

    expect(mockedReview).toHaveBeenCalledWith("cand-1", { outcome: "not_useful_now" });
    await waitFor(() => expect(screen.queryByText("WorkInsight is back up now")).toBeNull());
  });

  it("marks a card Wrong", async () => {
    mockedFetch.mockResolvedValue([card]);
    mockedReview.mockResolvedValue(null);
    render(<CaptureCard />);
    await screen.findByText("WorkInsight is back up now");

    await userEvent.setup().click(screen.getByRole("button", { name: "Wrong" }));

    expect(mockedReview).toHaveBeenCalledWith("cand-1", { outcome: "wrong_hallucinated" });
  });

  it("edits every field and saves the edited payload", async () => {
    mockedFetch.mockResolvedValue([card]);
    mockedReview.mockResolvedValue(null);
    render(<CaptureCard />);
    await screen.findByText("WorkInsight is back up now");
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const targetInput = screen.getByLabelText("Target");
    await user.clear(targetInput);
    await user.type(targetInput, "It's back up now");
    const cueInput = screen.getByLabelText("Cue");
    await user.clear(cueInput);
    await user.type(cueInput, "the wifi is working again");
    const contextInput = screen.getByLabelText("When to use it");
    await user.clear(contextInput);
    await user.type(contextInput, "telling a friend");
    await user.selectOptions(screen.getByLabelText("Category"), "daily_life");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(mockedReview).toHaveBeenCalledWith("cand-1", {
      outcome: "edited_saved",
      editedPayload: {
        target: "It's back up now",
        cue: "the wifi is working again",
        useContext: "telling a friend",
        category: "daily_life",
        tags: ["service-status"]
      }
    });
  });

  it("does not save an edit when a required field is blank", async () => {
    mockedFetch.mockResolvedValue([card]);
    render(<CaptureCard />);
    await screen.findByText("WorkInsight is back up now");
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.clear(screen.getByLabelText("Target"));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(mockedReview).not.toHaveBeenCalled();
  });

  it("ignores a capture submit with no text", async () => {
    render(<CaptureCard />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalled());

    const form = screen.getByLabelText("Capture text").closest("form");
    fireEvent.submit(form as HTMLFormElement);

    expect(mockedSubmit).not.toHaveBeenCalled();
  });

  it("cancels an edit without saving", async () => {
    mockedFetch.mockResolvedValue([card]);
    render(<CaptureCard />);
    await screen.findByText("WorkInsight is back up now");
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByLabelText("Target")).toBeNull();
    expect(mockedReview).not.toHaveBeenCalled();
  });

  it("surfaces a quiet error when a review action fails", async () => {
    mockedFetch.mockResolvedValue([card]);
    mockedReview.mockRejectedValue(new Error("nope"));
    render(<CaptureCard />);
    await screen.findByText("WorkInsight is back up now");

    await userEvent.setup().click(screen.getByRole("button", { name: "Save" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't record your choice");
  });
});

describe("CaptureCard backfill (#456)", () => {
  it("mines history and surfaces the returned card on Today", async () => {
    mockedBackfill.mockResolvedValue({ card, scannedCount: 3 });
    render(<CaptureCard />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalled());

    await userEvent.setup().click(screen.getByRole("button", { name: "Mine my history" }));

    expect(mockedBackfill).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("WorkInsight is back up now")).toBeTruthy();
  });

  it("shows a calm note when the scan surfaces nothing", async () => {
    mockedBackfill.mockResolvedValue({ card: null, scannedCount: 2 });
    render(<CaptureCard />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalled());

    await userEvent.setup().click(screen.getByRole("button", { name: "Mine my history" }));

    expect(await screen.findByText("No new suggestions from your history yet.")).toBeTruthy();
    expect(screen.queryByText("Make this durable?")).toBeNull();
  });

  it("surfaces a quiet error when the scan fails", async () => {
    mockedBackfill.mockRejectedValue(new Error("boom"));
    render(<CaptureCard />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalled());

    await userEvent.setup().click(screen.getByRole("button", { name: "Mine my history" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't scan your history");
  });
});

describe("CaptureCard voice capture (saved-first, #566)", () => {
  it("hides the voice control when capture is unsupported (typed box remains)", async () => {
    render(<CaptureCard capture={fakeVoice({ supported: false })} />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalled());

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
      voiceStatus({ id: "vc-1", createdAt: "2026-07-06T09:00:00.000Z", status: "transcribing" }),
      voiceStatus({ id: "vc-2", createdAt: "2026-07-06T09:05:00.000Z", status: "tidying" })
    ]);
    render(<CaptureCard capture={fakeVoice()} />);

    const first = await screen.findByText("Transcribing…");
    const second = screen.getByText("Tidying up…");
    // Oldest capture renders above the newer one.
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("polls a pending capture and hands the ready entry to the parent", async () => {
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
      expect(onCaptured).toHaveBeenCalledWith({
        createdAt: "2026-07-06T09:30:00.000Z",
        entryDate: "2026-07-06",
        id: "vc-1",
        language: "en",
        text: "WorkInsight is back up now"
      });
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

  it("still files a ready capture when the Make Durable card refetch fails", async () => {
    // A ready capture must reach the Timeline even if the follow-up card refresh errors: the rejection
    // is swallowed and onCaptured still fires.
    vi.useFakeTimers();
    try {
      mockedVoiceActive.mockResolvedValue([voiceStatus({ id: "vc-1", status: "transcribing" })]);
      mockedVoiceStatus.mockResolvedValue(
        voiceStatus({ id: "vc-1", status: "ready", text: "the deploy is green" })
      );
      mockedFetch.mockRejectedValue(new Error("cards down"));
      const onCaptured = vi.fn();
      render(<CaptureCard capture={fakeVoice()} onCaptured={onCaptured} />);

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });

      expect(onCaptured).toHaveBeenCalledWith(
        expect.objectContaining({ id: "vc-1", text: "the deploy is green" })
      );
    } finally {
      vi.useRealTimers();
    }
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
