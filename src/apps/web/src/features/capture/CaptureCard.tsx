import { useEffect, useState } from "react";

import {
  type DiaryEntryDto,
  type CaptureLanguage,
  type CaptureInputMode,
  type VoiceCaptureStatusDto
} from "@whetstone/contracts";
import { createTextDocument } from "@whetstone/document";

import { Button } from "../../shared/ui/Button";
import { submitDiaryCapture } from "../diary/diaryApi";
import { createCaptureVoice } from "./captureVoice";
import { useVoiceCaptures } from "./useVoiceCaptures";
import { voiceCaptureStatusLabels } from "./voiceCaptureLabels.tokens";

// One tap-and-talk recording: stop finalizes the audio and hands it back for STT. The browser audio
// boundary (createCaptureVoice in captureVoice.ts) is injected so the card tests with a
// deterministic fake, exactly as the diary page injects its live capture.
export type VoiceRecording = Readonly<{ stop: () => Promise<Blob> }>;

export type CaptureVoiceDependencies = Readonly<{
  start: () => Promise<VoiceRecording>;
  // Feature-detected from `isVoiceCaptureSupported`: false on a non-secure context or no mic device, so
  // the record button is hidden and capture falls back to the always-present typed box — never a dead end.
  supported: boolean;
}>;

const captureLanguageStorageKey = "whetstone.capture.language";

const captureLanguageOptions: ReadonlyArray<Readonly<{ label: string; value: CaptureLanguage }>> = [
  { label: "中文", value: "zh" },
  { label: "EN", value: "en" }
];

function readInitialCaptureLanguage(): CaptureLanguage {
  const stored = window.localStorage.getItem(captureLanguageStorageKey);
  return stored === "zh" || stored === "en" ? stored : "en";
}

// Build the DiaryEntryDto a just-ready voice capture becomes, so the Timeline can insert it in place
// without a refetch (#566). The status carries the tidied text + occurred instant; the durable body is
// the same single-paragraph document the server built from that text (`createTextDocument`), so the
// entry is immediately rich-editable.
function readyVoiceEntry(ready: VoiceCaptureStatusDto, text: string): DiaryEntryDto {
  return {
    bodyDoc: createTextDocument(text),
    bodyText: text,
    createdAt: ready.occurredAt,
    failureReason: null,
    id: ready.id,
    inputMode: "voice",
    language: ready.language,
    occurredAt: ready.occurredAt,
    processingStatus: "ready",
    updatedAt: ready.occurredAt
  };
}

// The unified capture surface used by Today and Diary: a typed box and — when the browser supports it —
// tap-and-talk voice capture. A diary capture journals only (#571): every capture saves a diary Entry
// first and nothing else — no proposal or Make Durable step blocks or slows it. Load/mic failures
// degrade quietly so this never blanks Today or the Diary timeline.
export function CaptureCard({
  capture = createCaptureVoice(),
  onCaptured
}: Readonly<{
  capture?: CaptureVoiceDependencies;
  onCaptured?: (entry: DiaryEntryDto) => void;
}>): React.JSX.Element {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [savingVoice, setSavingVoice] = useState(false);
  const [recording, setRecording] = useState<VoiceRecording | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [language, setLanguage] = useState<CaptureLanguage>(readInitialCaptureLanguage);

  // A background voice capture just became ready (#566): it now has its tidied text and is a real diary
  // Entry, so hand it to the Timeline (Diary inserts it in capture order). The hook drops it from the
  // pending rows.
  const handleVoiceReady = (ready: VoiceCaptureStatusDto): void => {
    if (ready.text !== null) {
      onCaptured?.(readyVoiceEntry(ready, ready.text));
    }
  };

  const voice = useVoiceCaptures({ onReady: handleVoiceReady });

  // Protect the only lossy window (#566): while recording OR the pre-acknowledgement save is in flight, a
  // refresh/navigation would drop audio the server has not accepted yet, so install the native browser
  // confirmation. It is removed the moment the save resolves — queued/background processing never nags.
  const guardNavigation = recording !== null || savingVoice;
  useEffect(() => {
    if (!guardNavigation) {
      return;
    }
    const handleBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [guardNavigation]);

  function chooseLanguage(nextLanguage: CaptureLanguage): void {
    setLanguage(nextLanguage);
    window.localStorage.setItem(captureLanguageStorageKey, nextLanguage);
  }

  // The single path both typed and voice capture funnel through: save the diary Entry, then hand it to
  // the Timeline. Returns whether the submit succeeded so the caller can clear its input only on success.
  async function runCapture(rawText: string, inputMode: CaptureInputMode): Promise<boolean> {
    const trimmed = rawText.trim();
    if (trimmed.length === 0) {
      return false;
    }

    setBusy(true);
    setError(null);
    try {
      const entry = await submitDiaryCapture(trimmed, inputMode, language);
      onCaptured?.(entry);
      return true;
    } catch {
      setError("Couldn't save your capture. Please try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function captureTyped(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (await runCapture(text, "typed")) {
      setText("");
    }
  }

  async function startRecording(): Promise<void> {
    setError(null);
    try {
      const handle = await capture.start();
      setRecording(handle);
    } catch {
      setError("Couldn't reach the microphone. You can type instead.");
    }
  }

  // Saved-first stop (#566): finalize the audio and submit it. An empty clip (no confirmed utterance) is
  // the calm no-speech retry and is never saved as a pending job. Otherwise the clip is saved immediately
  // and the card returns to a usable state — transcription/tidy run in the background as a pending row.
  async function stopRecording(handle: VoiceRecording): Promise<void> {
    setError(null);
    setRecording(null);
    setSavingVoice(true);
    try {
      const audio = await handle.stop();
      if (audio.size === 0) {
        setError("Didn't catch any speech — try again.");
        return;
      }
      const saved = await voice.submit(audio, language);
      if (!saved) {
        setError("Couldn't save your capture. Please try again.");
      }
    } catch {
      setError("Couldn't save your capture. Please try again.");
    } finally {
      setSavingVoice(false);
    }
  }

  // Retry a failed capture from its saved audio (#566): the raw clip was never lost, so this re-queues the
  // same recording. The hook re-queues it in place and resumes polling.
  async function retryVoice(id: string): Promise<void> {
    setError(null);
    const ok = await voice.retry(id);
    if (!ok) {
      setError("Couldn't retry that capture. Please try again.");
    }
  }

  const voiceBusy = busy || savingVoice;

  return (
    <section aria-label="Capture today" className="rounded border border-border bg-surface p-4">
      <h2 className="text-lg font-medium text-text">Capture today</h2>
      <p className="mt-1 text-text-muted">
        Tap and talk — or write it down. It lands in your diary.
      </p>

      <div className="mt-3" role="group" aria-labelledby="capture-language-label">
        <p className="text-sm font-medium text-text" id="capture-language-label">
          Capture language
        </p>
        <div className="mt-1 inline-flex rounded border border-border bg-bg p-1">
          {captureLanguageOptions.map((option) => {
            const selected = option.value === language;
            return (
              <button
                aria-pressed={selected}
                className={
                  selected
                    ? "min-h-11 min-w-11 rounded bg-accent px-3 text-sm font-medium text-accent-fg"
                    : "min-h-11 min-w-11 rounded px-3 text-sm font-medium text-text-muted hover:bg-surface hover:text-text"
                }
                key={option.value}
                onClick={() => chooseLanguage(option.value)}
                type="button"
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>

      {capture.supported ? (
        <div className="mt-3 flex flex-col gap-2">
          {recording === null ? (
            <Button
              disabled={voiceBusy}
              onClick={() => void startRecording()}
              type="button"
              variant="primary"
            >
              Tap to talk
            </Button>
          ) : (
            <Button onClick={() => void stopRecording(recording)} type="button" variant="secondary">
              Stop &amp; save
            </Button>
          )}
          {recording !== null ? (
            <p className="text-sm font-medium text-text" role="status">
              Listening…
            </p>
          ) : savingVoice ? (
            <p className="text-sm font-medium text-text" role="status">
              Saving…
            </p>
          ) : null}
        </div>
      ) : null}

      {voice.captures.length === 0 ? null : (
        <ul aria-label="Voice captures in progress" className="mt-3 flex flex-col gap-2">
          {voice.captures.map((pending) => (
            <li className="rounded border border-border bg-bg p-3" key={pending.id}>
              {pending.status === "failed" ? (
                <div className="flex flex-wrap items-center justify-between gap-2" role="alert">
                  <span className="text-sm text-text-muted">{voiceCaptureStatusLabels.failed}</span>
                  <Button
                    onClick={() => void retryVoice(pending.id)}
                    size="sm"
                    type="button"
                    variant="secondary"
                  >
                    Retry
                  </Button>
                </div>
              ) : (
                <p className="text-sm text-text-muted" role="status">
                  {voiceCaptureStatusLabels[pending.status]}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      <form className="mt-3 flex flex-col gap-2" onSubmit={captureTyped}>
        <label className="sr-only" htmlFor="quick-capture">
          Capture text
        </label>
        <textarea
          className="min-h-20 rounded border border-border bg-bg p-2 text-text"
          id="quick-capture"
          onChange={(event) => setText(event.target.value)}
          placeholder="e.g. I wanted to say the deploy is rolling back, but I couldn't."
          value={text}
        />
        <div>
          <Button disabled={voiceBusy || text.trim().length === 0} type="submit" variant="primary">
            {busy ? "Saving…" : "Capture"}
          </Button>
        </div>
      </form>

      {error === null ? null : (
        <p className="mt-2 text-text-muted" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
