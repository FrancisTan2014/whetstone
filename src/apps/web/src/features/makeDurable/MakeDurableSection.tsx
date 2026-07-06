import { useEffect, useState } from "react";

import {
  recallCategories,
  type MakeDurableCardDto,
  type ProposalPayload,
  type RecallCategory
} from "@whetstone/contracts";

import { Button } from "../../shared/ui/Button";
import {
  fetchMakeDurableCards,
  reviewMakeDurableCard,
  submitQuickCapture,
  type ReviewCardInput
} from "./makeDurableApi";

// The Make Durable Quick Capture surface on Today (#452): a typed capture box plus, when the local
// model proposes something worth keeping, at most one calm review card. Capture is an invitation — the
// entry is always saved server-side; the card only appears when a proposal passed the gate. Reviewing a
// card (Save / Edit + Save / Not useful now / Wrong) removes it. Load/model failures degrade quietly so
// this never blanks Today.
export function MakeDurableSection(): React.JSX.Element {
  const [cards, setCards] = useState<ReadonlyArray<MakeDurableCardDto>>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
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

  async function capture(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const result = await submitQuickCapture(trimmed);
      setText("");
      const card = result.card;
      if (card !== null) {
        setCards((current) => [card, ...current]);
      }
    } catch {
      setError("Couldn't save your capture. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function act(id: string, input: ReviewCardInput): Promise<void> {
    setError(null);
    try {
      await reviewMakeDurableCard(id, input);
      removeCard(id);
    } catch {
      setError("Couldn't record your choice. Please try again.");
    }
  }

  return (
    <section
      aria-label="Make a note durable"
      className="rounded border border-border bg-surface p-4"
    >
      <h2 className="text-lg font-medium text-text">Make a note durable</h2>
      <p className="mt-1 text-text-muted">
        Jot a phrase you reached for, or a moment you couldn&rsquo;t say in English.
      </p>

      <form className="mt-3 flex flex-col gap-2" onSubmit={capture}>
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
          <Button disabled={busy || text.trim().length === 0} type="submit" variant="primary">
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
          {cards.map((card) => (
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
