import { useCallback, useEffect, useState } from "react";

import {
  type DiaryEntryDto,
  recallCategories,
  type CaptureLanguage,
  type CaptureInputMode,
  type MakeDurableCardDto,
  type ProposalPayload,
  type RecallCategory,
  type VoiceCaptureStatusDto
} from "@whetstone/contracts";

import { Button } from "../../shared/ui/Button";
import { submitDiaryCapture } from "../diary/diaryApi";
import {
  fetchMakeDurableCards,
  reviewMakeDurableCard,
  runMakeDurableBackfill,
  type ReviewCardInput
} from "../makeDurable/makeDurableApi";
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

// The unified capture surface used by Today and Diary: a typed box and — when the browser supports it —
// tap-and-talk voice capture. Every capture saves a diary entry first; then the shared Make Durable
// proposal gate may surface at most one review card. Load/model/mic failures degrade quietly so this
// never blanks Today or the Diary timeline.
export function CaptureCard({
  capture = createCaptureVoice(),
  onCaptured,
  onDurableSaved
}: Readonly<{
  capture?: CaptureVoiceDependencies;
  onCaptured?: (entry: DiaryEntryDto) => void;
  // Fired after a review creates a recall item (Save / Edit + Save). Today uses it to refresh its
  // Recall card so the newly due item shows at once instead of going stale (#509). The negative
  // outcomes create no recall item, so this never fires for them.
  onDurableSaved?: () => void;
}>): React.JSX.Element {
  const [cards, setCards] = useState<ReadonlyArray<MakeDurableCardDto>>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [savingVoice, setSavingVoice] = useState(false);
  const [recording, setRecording] = useState<VoiceRecording | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [backfilling, setBackfilling] = useState(false);
  const [backfillNote, setBackfillNote] = useState<string | null>(null);
  const [language, setLanguage] = useState<CaptureLanguage>(readInitialCaptureLanguage);

  useEffect(() => {
    fetchMakeDurableCards().then(
      (loaded) => setCards(loaded),
      () => undefined
    );
  }, []);

  // A background voice capture just became ready (#566): it now has its tidied text and is a real diary
  // entry, so hand it to the Timeline (Diary inserts it in capture order) and drop it from the pending
  // rows. A ready capture may also have produced a Make Durable card server-side, so refresh cards — the
  // one-card cap is still enforced by the server and the slice(0, 1) render below.
  const handleVoiceReady = useCallback(
    (ready: VoiceCaptureStatusDto): void => {
      if (ready.text !== null) {
        onCaptured?.({
          createdAt: ready.createdAt,
          entryDate: ready.entryDate,
          id: ready.id,
          language: ready.language,
          text: ready.text
        });
      }
      fetchMakeDurableCards().then(
        (loaded) => setCards(loaded),
        () => undefined
      );
    },
    [onCaptured]
  );

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

  function removeCard(id: string): void {
    setCards((current) => current.filter((card) => card.proposalCandidateId !== id));
  }

  function chooseLanguage(nextLanguage: CaptureLanguage): void {
    setLanguage(nextLanguage);
    window.localStorage.setItem(captureLanguageStorageKey, nextLanguage);
  }

  // The single path both typed and voice capture funnel through: the Timeline entry is always saved,
  // and a returned review card (if any) is prepended. Returns whether the submit succeeded so the caller
  // can clear its input only on success.
  async function runCapture(rawText: string, inputMode: CaptureInputMode): Promise<boolean> {
    const trimmed = rawText.trim();
    if (trimmed.length === 0) {
      return false;
    }

    setBusy(true);
    setError(null);
    try {
      const result = await submitDiaryCapture(trimmed, inputMode, language);
      onCaptured?.(result.entry);
      const card = result.card;
      if (card !== null) {
        setCards((current) => [card, ...current]);
      }
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

  async function act(id: string, input: ReviewCardInput): Promise<void> {
    setError(null);
    try {
      const recallItem = await reviewMakeDurableCard(id, input);
      removeCard(id);
      // Save / Edit + Save create a recall item (the negative outcomes return null); tell Today so
      // its Recall card reflects the newly due item rather than staying stale (#509).
      if (recallItem !== null) {
        onDurableSaved?.();
      }
    } catch {
      setError("Couldn't record your choice. Please try again.");
    }
  }

  // Mine the learner's Timeline history for one high-value proposal (#456). The server surfaces at most
  // one card per run; if it returns one, prepend it, otherwise show a calm "nothing found" note. A
  // failure degrades to the same generic error and never blanks the section.
  async function mineHistory(): Promise<void> {
    setError(null);
    setBackfillNote(null);
    setBackfilling(true);
    try {
      const result = await runMakeDurableBackfill();
      if (result.card !== null) {
        const card = result.card;
        setCards((current) => [card, ...current]);
      } else {
        setBackfillNote("No new suggestions from your history yet.");
      }
    } catch {
      setError("Couldn't scan your history. Please try again.");
    } finally {
      setBackfilling(false);
    }
  }

  const voiceBusy = busy || savingVoice;

  return (
    <section aria-label="Capture today" className="rounded border border-border bg-surface p-4">
      <h2 className="text-lg font-medium text-text">Capture today</h2>
      <p className="mt-1 text-text-muted">
        Tap and talk — or write it down. It lands in your diary, then one useful note may be
        proposed.
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

      <div className="mt-3 flex flex-col gap-1">
        <div>
          <Button
            disabled={voiceBusy || backfilling}
            onClick={() => void mineHistory()}
            type="button"
            variant="secondary"
          >
            {backfilling ? "Scanning…" : "Mine my history"}
          </Button>
        </div>
        {backfillNote === null ? null : (
          <p className="text-sm text-text-muted" role="status">
            {backfillNote}
          </p>
        )}
      </div>

      {error === null ? null : (
        <p className="mt-2 text-text-muted" role="alert">
          {error}
        </p>
      )}

      {cards.length === 0 ? null : (
        <div className="mt-4 flex flex-col gap-3">
          {/* Today shows at most one Make Durable card (never an inbox). The server enforces this
              (a second gated proposal is held, not surfaced); rendering only the first card is a
              defensive client-side guarantee of the same rule. */}
          {cards.slice(0, 1).map((card) => (
            <MakeDurableReviewCard card={card} key={card.proposalCandidateId} onAct={act} />
          ))}
        </div>
      )}
    </section>
  );
}

// One review card. Reads as "Make this durable?" with the proposed cue/target/context, and offers the
// four outcomes. Edit opens an inline form to correct the target/cue/context/category before saving.
function MakeDurableReviewCard({
  card,
  onAct
}: Readonly<{
  card: MakeDurableCardDto;
  onAct: (id: string, input: ReviewCardInput) => void;
}>): React.JSX.Element {
  const [editing, setEditing] = useState(false);

  return (
    <article
      aria-label={`Make durable: ${card.target}`}
      className="rounded border border-border bg-bg p-3"
    >
      <p className="text-sm font-medium text-text-muted">Make this durable?</p>
      <dl className="mt-2 flex flex-col gap-1 text-text">
        <div>
          <dt className="text-xs uppercase text-text-muted">Target</dt>
          <dd className="text-lg">{card.target}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase text-text-muted">Cue</dt>
          <dd>{card.cue}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase text-text-muted">When to use it</dt>
          <dd>{card.useContext}</dd>
        </div>
      </dl>
      <p className="mt-2 text-sm text-text-muted">{card.reason}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="rounded bg-surface px-2 py-0.5 text-xs text-text-muted">
          {card.category}
        </span>
        {card.tags.map((tag) => (
          <span className="rounded bg-surface px-2 py-0.5 text-xs text-text-muted" key={tag}>
            {tag}
          </span>
        ))}
      </div>

      {editing ? (
        <EditForm
          card={card}
          onCancel={() => setEditing(false)}
          onSave={(editedPayload) =>
            onAct(card.proposalCandidateId, { editedPayload, outcome: "edited_saved" })
          }
        />
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            onClick={() => onAct(card.proposalCandidateId, { outcome: "saved" })}
            type="button"
            variant="primary"
          >
            Save
          </Button>
          <Button onClick={() => setEditing(true)} type="button" variant="secondary">
            Edit
          </Button>
          <Button
            onClick={() => onAct(card.proposalCandidateId, { outcome: "not_useful_now" })}
            type="button"
            variant="secondary"
          >
            Not useful now
          </Button>
          <Button
            onClick={() => onAct(card.proposalCandidateId, { outcome: "wrong_hallucinated" })}
            type="button"
            variant="secondary"
          >
            Wrong
          </Button>
        </div>
      )}
    </article>
  );
}

// The inline edit form: correct the target/cue/context/category, then Save. Tags carry over unchanged
// (v0 keeps tag editing out of scope).
function EditForm({
  card,
  onCancel,
  onSave
}: Readonly<{
  card: MakeDurableCardDto;
  onCancel: () => void;
  onSave: (payload: ProposalPayload) => void;
}>): React.JSX.Element {
  const [target, setTarget] = useState(card.target);
  const [cue, setCue] = useState(card.cue);
  const [useContext, setUseContext] = useState(card.useContext);
  const [category, setCategory] = useState<RecallCategory>(card.category);

  function submit(event: React.FormEvent): void {
    event.preventDefault();
    if (target.trim().length === 0 || cue.trim().length === 0 || useContext.trim().length === 0) {
      return;
    }
    onSave({
      target: target.trim(),
      cue: cue.trim(),
      useContext: useContext.trim(),
      category,
      tags: card.tags
    });
  }

  return (
    <form className="mt-3 flex flex-col gap-2" onSubmit={submit}>
      <label className="flex flex-col gap-1 text-sm text-text-muted">
        Target
        <input
          className="rounded border border-border bg-bg p-2 text-text"
          onChange={(event) => setTarget(event.target.value)}
          value={target}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm text-text-muted">
        Cue
        <input
          className="rounded border border-border bg-bg p-2 text-text"
          onChange={(event) => setCue(event.target.value)}
          value={cue}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm text-text-muted">
        When to use it
        <input
          className="rounded border border-border bg-bg p-2 text-text"
          onChange={(event) => setUseContext(event.target.value)}
          value={useContext}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm text-text-muted">
        Category
        <select
          className="rounded border border-border bg-bg p-2 text-text"
          onChange={(event) => setCategory(event.target.value as RecallCategory)}
          value={category}
        >
          {recallCategories.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
      <div className="flex gap-2">
        <Button type="submit" variant="primary">
          Save changes
        </Button>
        <Button onClick={onCancel} type="button" variant="secondary">
          Cancel
        </Button>
      </div>
    </form>
  );
}
