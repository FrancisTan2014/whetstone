// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./makeDurableApi", () => ({
  fetchMakeDurableCards: vi.fn(),
  reviewMakeDurableCard: vi.fn(),
  submitQuickCapture: vi.fn()
}));

vi.mock("../session/sessionApi", () => ({
  transcribe: vi.fn()
}));

import type { MakeDurableCardDto, QuickCaptureResultDto } from "@whetstone/contracts";

import { transcribe } from "../session/sessionApi";
import { fetchMakeDurableCards, reviewMakeDurableCard, submitQuickCapture } from "./makeDurableApi";
import { MakeDurableSection, type QuickCaptureVoiceDependencies } from "./MakeDurableSection";

const mockedFetch = vi.mocked(fetchMakeDurableCards);
const mockedSubmit = vi.mocked(submitQuickCapture);
const mockedReview = vi.mocked(reviewMakeDurableCard);
const mockedTranscribe = vi.mocked(transcribe);

// A deterministic voice capture seam: `start()` opens a fake recording whose `stop()` resolves a stub
// audio blob (the real MediaRecorder/Web Audio path is not exercisable in jsdom).
function fakeVoice(
  overrides: Partial<{
    start: QuickCaptureVoiceDependencies["start"];
    supported: boolean;
  }> = {}
): QuickCaptureVoiceDependencies {
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

function captureResult(withCard: MakeDurableCardDto | null): QuickCaptureResultDto {
  return {
    card: withCard,
    timelineEntry: {
      entryId: "entry-1",
      createdAt: "2026-07-06T09:30:00.000Z",
      entryDate: "2026-07-06",
      inputMode: "typed",
      captureSource: "quick_capture",
      rawInputText: "the deploy failed",
      tidiedText: null,
      language: null,
      rawAudioPath: null
    }
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedFetch.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
});

async function typeCapture(text: string): Promise<void> {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Quick capture text"), text);
  await user.click(screen.getByRole("button", { name: "Capture" }));
}

describe("MakeDurableSection", () => {
  it("loads and shows pending cards on mount", async () => {
    mockedFetch.mockResolvedValue([card]);
    render(<MakeDurableSection />);

    expect(await screen.findByText("WorkInsight is back up now")).toBeTruthy();
  });

  it("keeps Capture disabled until there is text", async () => {
    render(<MakeDurableSection />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalled());

    expect((screen.getByRole("button", { name: "Capture" }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it("submits a capture and shows the returned review card", async () => {
    mockedSubmit.mockResolvedValue(captureResult(card));
    render(<MakeDurableSection />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalled());

    await typeCapture("I couldn't say it");

    expect(mockedSubmit).toHaveBeenCalledWith("I couldn't say it", "typed");
    expect(await screen.findByText("WorkInsight is back up now")).toBeTruthy();
  });

  it("shows no card when the capture yields no proposal", async () => {
    mockedSubmit.mockResolvedValue(captureResult(null));
    render(<MakeDurableSection />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalled());

    await typeCapture("nothing special");

    expect(screen.queryByText("Make this durable?")).toBeNull();
  });

  it("surfaces a quiet error when the capture fails", async () => {
    mockedSubmit.mockRejectedValue(new Error("boom"));
    render(<MakeDurableSection />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalled());

    await typeCapture("try me");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't save your capture");
  });

  it("saves an approved card and removes it", async () => {
    mockedFetch.mockResolvedValue([card]);
    mockedReview.mockResolvedValue(null);
    render(<MakeDurableSection />);
    await screen.findByText("WorkInsight is back up now");

    await userEvent.setup().click(screen.getByRole("button", { name: "Save" }));

    expect(mockedReview).toHaveBeenCalledWith("cand-1", { outcome: "saved" });
    await waitFor(() => expect(screen.queryByText("WorkInsight is back up now")).toBeNull());
  });

  it("dismisses a card on Not useful now", async () => {
    mockedFetch.mockResolvedValue([card]);
    mockedReview.mockResolvedValue(null);
    render(<MakeDurableSection />);
    await screen.findByText("WorkInsight is back up now");

    await userEvent.setup().click(screen.getByRole("button", { name: "Not useful now" }));

    expect(mockedReview).toHaveBeenCalledWith("cand-1", { outcome: "not_useful_now" });
    await waitFor(() => expect(screen.queryByText("WorkInsight is back up now")).toBeNull());
  });

  it("marks a card Wrong", async () => {
    mockedFetch.mockResolvedValue([card]);
    mockedReview.mockResolvedValue(null);
    render(<MakeDurableSection />);
    await screen.findByText("WorkInsight is back up now");

    await userEvent.setup().click(screen.getByRole("button", { name: "Wrong" }));

    expect(mockedReview).toHaveBeenCalledWith("cand-1", { outcome: "wrong_hallucinated" });
  });

  it("edits every field and saves the edited payload", async () => {
    mockedFetch.mockResolvedValue([card]);
    mockedReview.mockResolvedValue(null);
    render(<MakeDurableSection />);
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
    render(<MakeDurableSection />);
    await screen.findByText("WorkInsight is back up now");
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.clear(screen.getByLabelText("Target"));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(mockedReview).not.toHaveBeenCalled();
  });

  it("ignores a capture submit with no text", async () => {
    render(<MakeDurableSection />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalled());

    const form = screen.getByLabelText("Quick capture text").closest("form");
    fireEvent.submit(form as HTMLFormElement);

    expect(mockedSubmit).not.toHaveBeenCalled();
  });

  it("cancels an edit without saving", async () => {
    mockedFetch.mockResolvedValue([card]);
    render(<MakeDurableSection />);
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
    render(<MakeDurableSection />);
    await screen.findByText("WorkInsight is back up now");

    await userEvent.setup().click(screen.getByRole("button", { name: "Save" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't record your choice");
  });
});

describe("MakeDurableSection voice capture", () => {
  it("hides the voice control when capture is unsupported (typed box remains)", async () => {
    render(<MakeDurableSection capture={fakeVoice({ supported: false })} />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalled());

    expect(screen.queryByRole("button", { name: "Tap to talk" })).toBeNull();
    expect(screen.getByLabelText("Quick capture text")).toBeTruthy();
  });

  it("records, transcribes, and submits the transcript as a voice capture", async () => {
    mockedTranscribe.mockResolvedValue({ transcript: "WorkInsight is back up now", words: [] });
    mockedSubmit.mockResolvedValue(captureResult(card));
    render(<MakeDurableSection capture={fakeVoice()} />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalled());
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Tap to talk" }));
    await user.click(await screen.findByRole("button", { name: "Stop & save" }));

    expect(mockedTranscribe).toHaveBeenCalled();
    expect(mockedSubmit).toHaveBeenCalledWith("WorkInsight is back up now", "voice");
    expect(await screen.findByText("WorkInsight is back up now")).toBeTruthy();
  });

  it("shows a calm retry and submits nothing when no speech is caught", async () => {
    mockedTranscribe.mockResolvedValue({ transcript: "   ", words: [] });
    render(<MakeDurableSection capture={fakeVoice()} />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalled());
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Tap to talk" }));
    await user.click(await screen.findByRole("button", { name: "Stop & save" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Didn't catch any speech");
    expect(mockedSubmit).not.toHaveBeenCalled();
  });

  it("shows the no-speech retry (not the save error) when the capture is empty audio (#465)", async () => {
    // The adapter settles empty audio on a no-utterance stop; the section must NOT post it to
    // /transcribe (which 400s) — it takes the calm retry path without ever calling transcribe.
    const start = vi.fn(async () => ({ stop: async () => new Blob() }));
    render(<MakeDurableSection capture={fakeVoice({ start })} />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalled());
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Tap to talk" }));
    await user.click(await screen.findByRole("button", { name: "Stop & save" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Didn't catch any speech");
    expect(mockedTranscribe).not.toHaveBeenCalled();
    expect(mockedSubmit).not.toHaveBeenCalled();
    // The control returns to idle so the learner can retry or type.
    expect(screen.getByRole("button", { name: "Tap to talk" })).toBeTruthy();
  });

  it("falls back to typing when the microphone can't be reached", async () => {
    const start = vi.fn().mockRejectedValue(new Error("denied"));
    render(<MakeDurableSection capture={fakeVoice({ start })} />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalled());

    await userEvent.setup().click(screen.getByRole("button", { name: "Tap to talk" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't reach the microphone");
    expect(screen.getByLabelText("Quick capture text")).toBeTruthy();
  });

  it("surfaces a quiet error when transcription or saving fails", async () => {
    mockedTranscribe.mockRejectedValue(new Error("stt down"));
    render(<MakeDurableSection capture={fakeVoice()} />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalled());
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Tap to talk" }));
    await user.click(await screen.findByRole("button", { name: "Stop & save" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't save your capture");
    expect(mockedSubmit).not.toHaveBeenCalled();
  });
});
