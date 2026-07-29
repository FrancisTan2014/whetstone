// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as SharedEditor from "../../shared/editor";

vi.mock("../diary/diaryApi", () => ({
  submitDiaryCapture: vi.fn()
}));

vi.mock("./voiceCaptureApi", () => ({
  submitVoiceCapture: vi.fn(),
  fetchActiveVoiceCaptures: vi.fn(),
  fetchVoiceCaptureStatus: vi.fn(),
  retryVoiceCapture: vi.fn(),
  removeVoiceCapture: vi.fn()
}));

// The shared rich editor is mocked as a controlled <textarea> (the real Tiptap surface is not
// exercisable in jsdom): typing emits a single-paragraph document via `createTextDocument`, and the
// authoritative `document` prop resets the field whenever its identity changes — so a fresh empty seed
// after a successful save clears the box, while an unchanged seed after a failed save keeps the text.
// `presentation` is surfaced as a data attribute so a test can assert which surface each host requests.
vi.mock("../../shared/editor", async (importOriginal) => {
  const actual = await importOriginal<typeof SharedEditor>();
  const { createTextDocument, documentText } = await import("@whetstone/document");
  const React = await import("react");
  const MockEditor = ({
    ariaLabel,
    document,
    onChange,
    onSave,
    presentation
  }: {
    ariaLabel?: string;
    document: unknown;
    onChange: (document: unknown) => void;
    onSave?: (document: unknown) => void;
    presentation?: string;
  }): React.JSX.Element => {
    const [value, setValue] = React.useState(() => documentText(document as never));
    // The real shared editor hands `onSave` its own live transaction document (`view.state.doc`), which
    // updates synchronously on each keystroke — while the onChange-synced React `draft` only catches up on
    // a later commit. `liveRef` models that authoritative live document so a save can legitimately carry a
    // character the draft has not yet received, proving the component forwards the payload, not its draft.
    const liveRef = React.useRef(value);
    React.useEffect(() => {
      const text = documentText(document as never);
      setValue(text);
      liveRef.current = text;
    }, [document]);
    return React.createElement("textarea", {
      "aria-label": ariaLabel,
      "data-presentation": presentation,
      onChange: (event: { target: { value: string } }) => {
        liveRef.current = event.target.value;
        setValue(event.target.value);
        onChange(createTextDocument(event.target.value));
      },
      onKeyDown: (event: {
        key: string;
        metaKey: boolean;
        ctrlKey: boolean;
        altKey?: boolean;
        preventDefault?: () => void;
      }) => {
        if (onSave && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
          event.preventDefault?.();
          onSave(createTextDocument(liveRef.current));
          return;
        }
        // A printable keystroke advances the editor's live document immediately; the draft lags until the
        // next input event. Tests use this one-keystroke lead to distinguish the live payload from draft.
        if (!event.metaKey && !event.ctrlKey && event.altKey !== true && event.key.length === 1) {
          liveRef.current += event.key;
        }
      },
      value
    });
  };
  return { ...actual, RichContentEditor: MockEditor };
});

import type {
  DiaryEntryDto,
  VoiceCaptureFailureCode,
  VoiceCaptureStatusDto
} from "@whetstone/contracts";
import { createTextDocument, documentText } from "@whetstone/document";

import {
  fetchActiveVoiceCaptures,
  fetchVoiceCaptureStatus,
  removeVoiceCapture,
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
const mockedVoiceRemove = vi.mocked(removeVoiceCapture);

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
    hasAudio: false,
    id: "entry-1",
    inputMode: "typed",
    language: "en",
    occurredAt: "2026-07-06T09:30:00.000Z",
    processingStatus: null,
    transcript: null,
    updatedAt: "2026-07-06T09:30:00.000Z",
    ...overrides
  };
}

function voiceStatus(overrides: Partial<VoiceCaptureStatusDto> = {}): VoiceCaptureStatusDto {
  return {
    failure: null,
    id: "vc-1",
    language: "en",
    occurredAt: "2026-07-06T09:30:00.000Z",
    status: "queued",
    text: null,
    ...overrides
  };
}

// A failed capture in a given category. `failed` status always carries a failure object (retryable
// derived from the code), so tests render the real failed-row affordances.
function failedStatus(
  code: VoiceCaptureFailureCode,
  retryable: boolean,
  overrides: Partial<VoiceCaptureStatusDto> = {}
): VoiceCaptureStatusDto {
  return voiceStatus({ failure: { code, retryable }, status: "failed", text: null, ...overrides });
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

  it("offers no capture-language switch or stored preference (#647)", () => {
    window.localStorage.setItem("whetstone.capture.language", "zh");

    render(<CaptureCard />);

    // The 中文/EN toggle and its local-storage preference are gone: Whisper auto-detects speech and typed
    // capture needs no language choice.
    expect(screen.queryByRole("button", { name: "中文" })).toBeNull();
    expect(screen.queryByRole("button", { name: "EN" })).toBeNull();
  });

  it("saves a typed capture and hands the diary Entry to the parent (#571)", async () => {
    const entry = diaryEntry("I couldn't say it");
    mockedSubmit.mockResolvedValue(entry);
    const onCaptured = vi.fn();
    render(<CaptureCard onCaptured={onCaptured} />);

    await typeCapture("I couldn't say it");

    expect(mockedSubmit).toHaveBeenCalledWith(createTextDocument("I couldn't say it"));
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

  it("surfaces a quiet error when the capture fails and keeps the composed text (#678)", async () => {
    mockedSubmit.mockRejectedValue(new Error("boom"));
    render(<CaptureCard />);

    await typeCapture("try me");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't save your capture");
    // The rich content survives a failed save so the learner can retry without retyping.
    expect((screen.getByLabelText("Capture text") as HTMLTextAreaElement).value).toBe("try me");
  });

  it("does not submit when the document has no readable text (#678)", () => {
    render(<CaptureCard />);

    const button = screen.getByRole("button", { name: "Capture" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);

    expect(mockedSubmit).not.toHaveBeenCalled();
  });

  it("saves via the editor's Ctrl/Cmd+S shortcut, persisting the editor's live document not a stale draft (#678)", async () => {
    const entry = diaryEntry("saved by shortcut!");
    mockedSubmit.mockResolvedValue(entry);
    const onCaptured = vi.fn();
    render(<CaptureCard onCaptured={onCaptured} />);

    const editor = screen.getByLabelText("Capture text");
    await userEvent.setup().type(editor, "saved by shortcut");
    // A final live keystroke the editor captures on keydown but React's draft has not flushed yet, so the
    // editor's live document ("saved by shortcut!") leads the draft ("saved by shortcut") by one char.
    fireEvent.keyDown(editor, { key: "!" });
    // Ctrl+S must persist that live document verbatim — not the laggy draft.
    fireEvent.keyDown(editor, { key: "s", ctrlKey: true });

    await waitFor(() =>
      expect(mockedSubmit).toHaveBeenCalledWith(createTextDocument("saved by shortcut!"))
    );
    expect(onCaptured).toHaveBeenCalledWith(entry);
  });

  it("does not save via the keyboard shortcut when the document has no readable text (#678)", () => {
    render(<CaptureCard />);

    fireEvent.keyDown(screen.getByLabelText("Capture text"), { key: "s", ctrlKey: true });

    expect(mockedSubmit).not.toHaveBeenCalled();
  });

  it("gives Diary a workspace surface and Today's capture a compact one (#678)", () => {
    const { unmount } = render(<CaptureCard presentation="workspace" />);
    expect(screen.getByLabelText("Capture text").getAttribute("data-presentation")).toBe(
      "workspace"
    );
    unmount();

    render(<CaptureCard presentation="compact" />);
    expect(screen.getByLabelText("Capture text").getAttribute("data-presentation")).toBe("compact");
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

    expect(mockedVoiceSubmit).toHaveBeenCalledWith(expect.any(Blob));
    expect(await screen.findByText("Saved — waiting to transcribe…")).toBeTruthy();
  });

  it("signals an accepted voice clip so a host can collapse to its confirmation (#639)", async () => {
    mockedVoiceSubmit.mockResolvedValue({ id: "vc-1", status: "queued" });
    mockedVoiceActive.mockResolvedValueOnce([]).mockResolvedValue([voiceStatus()]);
    const onVoiceAccepted = vi.fn();
    render(<CaptureCard capture={fakeVoice()} onVoiceAccepted={onVoiceAccepted} />);
    await waitFor(() => expect(mockedVoiceActive).toHaveBeenCalled());
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Tap to talk" }));
    await user.click(await screen.findByRole("button", { name: "Stop & save" }));

    await waitFor(() => expect(onVoiceAccepted).toHaveBeenCalledTimes(1));
  });

  it("does not signal acceptance when saving the voice clip fails (#639)", async () => {
    mockedVoiceSubmit.mockRejectedValue(new Error("save down"));
    const onVoiceAccepted = vi.fn();
    render(<CaptureCard capture={fakeVoice()} onVoiceAccepted={onVoiceAccepted} />);
    await waitFor(() => expect(mockedVoiceActive).toHaveBeenCalled());
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Tap to talk" }));
    await user.click(await screen.findByRole("button", { name: "Stop & save" }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(onVoiceAccepted).not.toHaveBeenCalled();
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

  it("shows a retryable failure's category copy and re-queues it via Retry transcription", async () => {
    mockedVoiceActive.mockResolvedValue([failedStatus("transcription_failed", true)]);
    mockedVoiceRetry.mockResolvedValue(voiceStatus({ id: "vc-1", status: "queued" }));
    render(<CaptureCard capture={fakeVoice()} />);

    expect(
      await screen.findByText(
        "Transcription failed. Your recording is safe. Run `pnpm setup:doctor`, then retry transcription."
      )
    ).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry transcription" }));

    expect(mockedVoiceRetry).toHaveBeenCalledWith("vc-1");
    expect(await screen.findByText("Saved — waiting to transcribe…")).toBeTruthy();
  });

  it("surfaces a quiet error when a retry fails", async () => {
    mockedVoiceActive.mockResolvedValue([failedStatus("voice_setup_required", true)]);
    mockedVoiceRetry.mockRejectedValue(new Error("nope"));
    render(<CaptureCard capture={fakeVoice()} />);

    await screen.findByRole("button", { name: "Retry transcription" });
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry transcription" }));

    expect(await screen.findByText("Couldn't retry that capture. Please try again.")).toBeTruthy();
  });

  it("shows setup-required copy with a retry for a voice_setup_required failure", async () => {
    mockedVoiceActive.mockResolvedValue([failedStatus("voice_setup_required", true)]);
    render(<CaptureCard capture={fakeVoice()} />);

    expect(
      await screen.findByText(
        "Voice transcription isn't set up. Run `pnpm setup:voice`, then retry transcription."
      )
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry transcription" })).toBeTruthy();
  });

  it("offers no retry for a non-retryable failure (no_speech), only removal", async () => {
    mockedVoiceActive.mockResolvedValue([failedStatus("no_speech", false)]);
    render(<CaptureCard capture={fakeVoice()} />);

    expect(
      await screen.findByText(
        "No speech was detected. Check your microphone and record the entry again."
      )
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry transcription" })).toBeNull();
    expect(screen.getByRole("button", { name: "Remove failed capture" })).toBeTruthy();
  });

  it("shows recording-missing copy with no retry", async () => {
    mockedVoiceActive.mockResolvedValue([failedStatus("recording_missing", false)]);
    render(<CaptureCard capture={fakeVoice()} />);

    expect(
      await screen.findByText("The saved recording could not be found. Record this entry again.")
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry transcription" })).toBeNull();
  });

  it("removes a failed capture only after the inline confirm", async () => {
    mockedVoiceActive.mockResolvedValue([failedStatus("no_speech", false)]);
    mockedVoiceRemove.mockResolvedValue(undefined);
    render(<CaptureCard capture={fakeVoice()} />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Remove failed capture" }));
    // The first tap only reveals the confirm — nothing is removed yet.
    expect(mockedVoiceRemove).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Remove" }));

    expect(mockedVoiceRemove).toHaveBeenCalledWith("vc-1");
    await waitFor(() =>
      expect(
        screen.queryByText(
          "No speech was detected. Check your microphone and record the entry again."
        )
      ).toBeNull()
    );
  });

  it("keeps the capture when the removal confirm is dismissed", async () => {
    mockedVoiceActive.mockResolvedValue([failedStatus("no_speech", false)]);
    render(<CaptureCard capture={fakeVoice()} />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Remove failed capture" }));
    await user.click(screen.getByRole("button", { name: "Keep" }));

    expect(mockedVoiceRemove).not.toHaveBeenCalled();
    // Back to the single Remove trigger, capture still shown.
    expect(screen.getByRole("button", { name: "Remove failed capture" })).toBeTruthy();
  });

  it("surfaces a quiet error when removing a failed capture fails", async () => {
    mockedVoiceActive.mockResolvedValue([failedStatus("no_speech", false)]);
    mockedVoiceRemove.mockRejectedValue(new Error("server down"));
    render(<CaptureCard capture={fakeVoice()} />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Remove failed capture" }));
    await user.click(screen.getByRole("button", { name: "Remove" }));

    expect(await screen.findByText("Couldn't remove that capture. Please try again.")).toBeTruthy();
  });
});
