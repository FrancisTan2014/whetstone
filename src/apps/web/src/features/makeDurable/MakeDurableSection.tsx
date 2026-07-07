import { useEffect, useState } from "react";

import {
  recallCategories,
  type CaptureInputMode,
  type MakeDurableCardDto,
  type ProposalPayload,
  type RecallCategory
} from "@whetstone/contracts";

import { Button } from "../../shared/ui/Button";
import { transcribe } from "../session/sessionApi";
import { createQuickCaptureVoice } from "./makeDurableCapture";
import {
  fetchMakeDurableCards,
  reviewMakeDurableCard,
  submitQuickCapture,
  type ReviewCardInput
} from "./makeDurableApi";

// One tap-and-talk recording: stop finalizes the audio and hands it back for STT. The browser audio
// boundary (createQuickCaptureVoice in makeDurableCapture.ts) is injected so the section tests with a
// deterministic fake, exactly as the diary page injects its live capture.
export type VoiceRecording = Readonly<{ stop: () => Promise<Blob> }>;

export type QuickCaptureVoiceDependencies = Readonly<{
  start: () => Promise<VoiceRecording>;
  // Feature-detected from `isVoiceCaptureSupported`: false on a non-secure context or no mic device, so
  // the record button is hidden and capture falls back to the always-present typed box — never a dead end.
  supported: boolean;
}>;

// Where the voice pipeline is: idle, recording (mic open), or transcribing (STT). Saving is shown on
// the buttons via `busy`; a typed capture never leaves `idle`.
type VoicePhase = "idle" | "recording" | "transcribing";

const voicePhaseLabels: Readonly<Record<VoicePhase, string>> = {
  idle: "",
  recording: "Listening…",
  transcribing: "Transcribing…"
};

// The Make Durable Quick Capture surface on Today (#452, #455): a typed capture box and — when the
// browser supports it — a tap-and-talk voice capture, plus at most one calm review card when the local
// model proposes something worth keeping. A voice capture records → transcribes with the shared STT seam
// → submits the transcript exactly like a typed capture (`inputMode = "voice"`), so both follow the same
// gate/dedup/Today-card path. Capture is an invitation — the entry is always saved server-side; the card
// only appears when a proposal passed the gate. Load/model/mic failures degrade quietly so this never
// blanks Today.
export function MakeDurableSection({
  capture = createQuickCaptureVoice(),
  onDurableSaved
}: Readonly<{
  capture?: QuickCaptureVoiceDependencies;
  // Fired after a review creates a recall item (Save / Edit + Save). Today uses it to refresh its
  // Recall card so the newly due item shows at once instead of going stale (#509). The negative
  // outcomes create no recall item, so this never fires for them.
  onDurableSaved?: () => void;
}>): React.JSX.Element {
  const [cards, setCards] = useState<ReadonlyArray<MakeDurableCardDto>>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [recording, setRecording] = useState<VoiceRecording | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchMakeDurableCards().then(
      (loaded) => setCards(loaded),
      () => undefined
    );
  }, []);

  function removeCard(id: string): void {
    setCards((current) => current.filter((card) => card.proposalCandidateId !== id));
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
      const result = await submitQuickCapture(trimmed, inputMode);
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
      setPhase("recording");
    } catch {
      setError("Couldn't reach the microphone. You can type instead.");
    }
  }

  async function stopRecording(handle: VoiceRecording): Promise<void> {
    setError(null);
    setRecording(null);
    setPhase("transcribing");
    try {
      const audio = await handle.stop();
      // The voice adapter settles with empty audio when no utterance was confirmed (tap → silence →
      // stop). Posting that to /transcribe would 400; instead take the calm no-speech retry directly
      // (#465), never the generic save error.
      if (audio.size === 0) {
        setPhase("idle");
        setError("Didn't catch any speech — try again.");
        return;
      }
      const { transcript } = await transcribe(audio);
      setPhase("idle");
      if (transcript.trim().length === 0) {
        setError("Didn't catch any speech — try again.");
        return;
      }
      await runCapture(transcript, "voice");
    } catch {
      setPhase("idle");
      setError("Couldn't save your capture. Please try again.");
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

  const transcribing = phase === "transcribing";

  return (
    <section
      aria-label="Make a note durable"
      className="rounded border border-border bg-surface p-4"
    >
      <h2 className="text-lg font-medium text-text">Make a note durable</h2>
      <p className="mt-1 text-text-muted">
        Jot — or say — a phrase you reached for, or a moment you couldn&rsquo;t say in English.
      </p>

      {capture.supported ? (
        <div className="mt-3 flex flex-col gap-2">
          {recording === null ? (
            <Button
              disabled={busy || transcribing}
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
          {phase === "idle" ? null : (
            <p className="text-sm font-medium text-text" role="status">
              {voicePhaseLabels[phase]}
            </p>
          )}
        </div>
      ) : null}

      <form className="mt-3 flex flex-col gap-2" onSubmit={captureTyped}>
        <label className="sr-only" htmlFor="quick-capture">
          Quick capture text
        </label>
        <textarea
          className="min-h-20 rounded border border-border bg-bg p-2 text-text"
          id="quick-capture"
          onChange={(event) => setText(event.target.value)}
          placeholder="e.g. I wanted to say the deploy is rolling back, but I couldn't."
          value={text}
        />
        <div>
          <Button
            disabled={busy || transcribing || text.trim().length === 0}
            type="submit"
            variant="primary"
          >
            {busy ? "Saving…" : "Capture"}
          </Button>
        </div>
      </form>

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
