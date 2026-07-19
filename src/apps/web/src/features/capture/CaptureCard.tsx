import { useEffect, useState } from "react";

import { type DiaryEntryDto, type VoiceCaptureStatusDto } from "@whetstone/contracts";
import {
  createTextDocument,
  documentReadableText,
  type DocumentNodeJSON
} from "@whetstone/document";

import {
  RichContentEditor,
  createEmptyDocument,
  type RichContentEditorPresentation
} from "../../shared/editor";
import { Button } from "../../shared/ui/Button";
import { submitDiaryCapture } from "../diary/diaryApi";
import { createCaptureVoice } from "./captureVoice";
import { useVoiceCaptures } from "./useVoiceCaptures";
import { voiceCaptureFailureCopy, voiceCaptureStatusLabels } from "./voiceCaptureLabels.tokens";

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

// Build the DiaryEntryDto a just-ready voice capture becomes, so the Timeline can insert it in place
// without a refetch (#566). The status carries the tidied text + occurred instant; the durable body is
// the same single-paragraph document the server built from that text (`createTextDocument`), so the
// entry is immediately rich-editable.
function readyVoiceEntry(ready: VoiceCaptureStatusDto, text: string): DiaryEntryDto {
  return {
    bodyDoc: createTextDocument(text),
    bodyText: text,
    createdAt: ready.occurredAt,
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
  onCaptured,
  onVoiceAccepted,
  presentation = "workspace"
}: Readonly<{
  capture?: CaptureVoiceDependencies;
  onCaptured?: (entry: DiaryEntryDto) => void;
  // Fired the moment a recorded clip is accepted (saved server-side) — before background transcription
  // finishes — so a host surface (Today's compact capture, #639) can collapse to its confirmation state.
  onVoiceAccepted?: () => void;
  // How the typed composer presents itself (#678): Diary gives it a full "workspace" writing surface,
  // while Today's activated capture stays "compact" so the restrained collapsed card doesn't balloon.
  presentation?: RichContentEditorPresentation;
}>): React.JSX.Element {
  // The typed composer is the shared rich editor. `seed` is the authoritative document handed to the
  // editor (it resets the surface whenever its identity changes); `draft` tracks live edits. Keeping the
  // seed stable across a failed save preserves the learner's in-progress rich content (#678); a
  // successful save swaps in a fresh empty document to clear the surface.
  const [seed, setSeed] = useState<DocumentNodeJSON>(() => createEmptyDocument());
  const [draft, setDraft] = useState<DocumentNodeJSON>(seed);
  const [busy, setBusy] = useState(false);
  const [savingVoice, setSavingVoice] = useState(false);
  const [recording, setRecording] = useState<VoiceRecording | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Which failed capture is awaiting removal confirmation (inline two-step confirm): the id whose Remove
  // button was tapped, or null when none is pending. A confirm step guards the irreversible discard
  // without a modal dialog (#675).
  const [confirmingRemoval, setConfirmingRemoval] = useState<string | null>(null);

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

  // The single path both typed and voice capture funnel through: save the diary Entry, then hand it to
  // the Timeline. Returns whether the submit succeeded so the caller can clear its input only on success.
  // The canonical rich document crosses the boundary intact (#678); blank is judged by readable text so a
  // document of only empty structural nodes cannot be saved.
  async function runCapture(bodyDoc: DocumentNodeJSON): Promise<boolean> {
    if (documentReadableText(bodyDoc).trim().length === 0) {
      return false;
    }

    setBusy(true);
    setError(null);
    try {
      const entry = await submitDiaryCapture(bodyDoc);
      onCaptured?.(entry);
      return true;
    } catch {
      setError("Couldn't save your capture. Please try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function captureTyped(bodyDoc: DocumentNodeJSON = draft): Promise<void> {
    // The shared editor hands its own live transaction document to `onSave` on Ctrl/Cmd+S; route that
    // exact document through the capture path so a keyboard save persists what the editor shows, not a
    // possibly-staler React `draft` snapshot. The Capture button, which has no editor payload, falls
    // back to `draft` (the default) — the value its disabled/enabled state is already computed from.
    if (await runCapture(bodyDoc)) {
      // Reset the surface only after the server has the entry: a fresh empty document changes the seed
      // identity, so the editor clears; a failed save leaves the seed (and the learner's content) intact.
      const empty = createEmptyDocument();
      setSeed(empty);
      setDraft(empty);
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
      const saved = await voice.submit(audio);
      if (!saved) {
        setError("Couldn't save your capture. Please try again.");
      } else {
        onVoiceAccepted?.();
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

  // Discard a failed capture after the inline confirm (#675): remove the saved recording and its rows.
  // The hook drops it from the list; on failure the row stays so it can be retried or removed again.
  async function removeVoice(id: string): Promise<void> {
    setError(null);
    setConfirmingRemoval(null);
    const ok = await voice.remove(id);
    if (!ok) {
      setError("Couldn't remove that capture. Please try again.");
    }
  }

  const voiceBusy = busy || savingVoice;

  return (
    <section aria-label="Capture today" className="rounded border border-border bg-surface p-4">
      <h2 className="text-lg font-medium text-text">Capture today</h2>
      <p className="mt-1 text-text-muted">
        Tap and talk — or write it down. It lands in your diary.
      </p>

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
              {pending.failure !== null ? (
                <div className="flex flex-col gap-2" role="alert">
                  <span className="text-sm text-text-muted">
                    {voiceCaptureFailureCopy[pending.failure.code]}
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {pending.failure.retryable ? (
                      <Button
                        onClick={() => void retryVoice(pending.id)}
                        size="sm"
                        type="button"
                        variant="secondary"
                      >
                        Retry transcription
                      </Button>
                    ) : null}
                    {confirmingRemoval === pending.id ? (
                      <>
                        <Button
                          onClick={() => void removeVoice(pending.id)}
                          size="sm"
                          type="button"
                          variant="secondary"
                        >
                          Remove
                        </Button>
                        <Button
                          onClick={() => setConfirmingRemoval(null)}
                          size="sm"
                          type="button"
                          variant="ghost"
                        >
                          Keep
                        </Button>
                      </>
                    ) : (
                      <Button
                        onClick={() => setConfirmingRemoval(pending.id)}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        Remove failed capture
                      </Button>
                    )}
                  </div>
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

      <div className="mt-3 flex flex-col gap-2">
        <RichContentEditor
          ariaLabel="Capture text"
          document={seed}
          onChange={setDraft}
          onSave={(bodyDoc) => void captureTyped(bodyDoc)}
          presentation={presentation}
        />
        <div>
          <Button
            disabled={voiceBusy || documentReadableText(draft).trim().length === 0}
            onClick={() => void captureTyped()}
            type="button"
            variant="primary"
          >
            {busy ? "Saving…" : "Capture"}
          </Button>
        </div>
      </div>

      {error === null ? null : (
        <p className="mt-2 text-text-muted" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
