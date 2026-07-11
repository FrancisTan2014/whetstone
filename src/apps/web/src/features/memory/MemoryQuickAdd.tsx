import { useState } from "react";

import type { MemoryPromptInput } from "@whetstone/contracts";

import { Button } from "../../shared/ui/Button";
import { createMemory, suggestGloss } from "./memoryApi";

type MemoryQuickAddProps = Readonly<{ onCreated: () => void }>;

type Confirm = Readonly<{ suggestion: string; term: string }>;

type Direction = Readonly<{ answer: string; cue: string }>;

const emptyDirection: Direction = { answer: "", cue: "" };

const requestFailedMessage = "Could not save that. Please try again.";

// Quick Add is progressive disclosure: it opens compact — one field for a bare term — and only reveals
// the multi-direction form on demand. A bare term is looked up in the offline dictionary: a hit reveals
// a confirm row (edit the suggested answer, save scheduled, or save as a draft); a miss saves straight
// away as an unscheduled draft so an unknown word is never blocked. The expanded form captures a cue,
// an optional answer, an optional context/example, and any number of extra directions. Every path saves
// a `manual` capture and, on success, clears the form and asks the page to reload.
export function MemoryQuickAdd({ onCreated }: MemoryQuickAddProps): React.JSX.Element {
  const [term, setTerm] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [answer, setAnswer] = useState("");
  const [directions, setDirections] = useState<ReadonlyArray<Direction>>([emptyDirection]);
  const [context, setContext] = useState("");
  const [pending, setPending] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function resetAfterCreate(): void {
    setTerm("");
    setConfirm(null);
    setAnswer("");
    setDirections([emptyDirection]);
    setContext("");
    setDetailsOpen(false);
    setInfo(null);
    onCreated();
  }

  async function runDeposit(prompts: MemoryPromptInput[], noteText: string): Promise<void> {
    setPending(true);
    setError(null);
    try {
      await createMemory({ captureSource: "manual", noteText, prompts });
      resetAfterCreate();
    } catch {
      setError(requestFailedMessage);
    } finally {
      setPending(false);
    }
  }

  async function submitCompact(): Promise<void> {
    const trimmed = term.trim();
    if (trimmed.length === 0) {
      return;
    }

    setPending(true);
    setError(null);
    setInfo(null);
    try {
      const result = await suggestGloss(trimmed);
      if (result.suggestion !== null) {
        setConfirm({ suggestion: result.suggestion, term: trimmed });
        setAnswer(result.suggestion);
        return;
      }

      await createMemory({
        captureSource: "manual",
        noteText: trimmed,
        prompts: [{ cueText: trimmed }]
      });
      setTerm("");
      setInfo(`Saved \u201c${trimmed}\u201d as a draft \u2014 add an answer later to schedule it.`);
      onCreated();
    } catch {
      setError(requestFailedMessage);
    } finally {
      setPending(false);
    }
  }

  function confirmSave(confirmedTerm: string, scheduled: boolean): void {
    const prompts: MemoryPromptInput[] = scheduled
      ? [{ answerText: answer.trim(), cueText: confirmedTerm }]
      : [{ cueText: confirmedTerm }];
    void runDeposit(prompts, confirmedTerm);
  }

  function submitDetails(): void {
    const prompts: MemoryPromptInput[] = [];
    let firstCue = "";
    for (const direction of directions) {
      const cue = direction.cue.trim();
      if (cue.length === 0) {
        continue;
      }
      if (firstCue.length === 0) {
        firstCue = cue;
      }
      const trimmedAnswer = direction.answer.trim();
      prompts.push(
        trimmedAnswer.length === 0 ? { cueText: cue } : { answerText: trimmedAnswer, cueText: cue }
      );
    }

    if (prompts.length === 0) {
      setError("Add at least one cue to save.");
      return;
    }

    const trimmedContext = context.trim();
    const noteText = trimmedContext.length === 0 ? firstCue : `${firstCue}\n\n${trimmedContext}`;
    void runDeposit(prompts, noteText);
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (detailsOpen) {
      submitDetails();
    } else {
      void submitCompact();
    }
  }

  function updateDirection(index: number, patch: Partial<Direction>): void {
    setDirections((current) =>
      current.map((direction, position) =>
        position === index ? { ...direction, ...patch } : direction
      )
    );
  }

  return (
    <section
      aria-label="Quick add to memory"
      className="rounded border border-border bg-surface p-4"
    >
      <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
        {detailsOpen ? (
          <div className="flex flex-col gap-3">
            {directions.map((direction, index) => (
              <div className="flex flex-col gap-2" key={index}>
                <label className="flex flex-col gap-1 text-sm text-text">
                  Cue
                  <input
                    className="rounded border border-border bg-bg px-2 py-1 text-text"
                    onChange={(event) => updateDirection(index, { cue: event.target.value })}
                    value={direction.cue}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm text-text">
                  Answer
                  <input
                    className="rounded border border-border bg-bg px-2 py-1 text-text"
                    onChange={(event) => updateDirection(index, { answer: event.target.value })}
                    value={direction.answer}
                  />
                </label>
              </div>
            ))}
            <label className="flex flex-col gap-1 text-sm text-text">
              Context or example
              <textarea
                className="rounded border border-border bg-bg px-2 py-1 text-text"
                onChange={(event) => setContext(event.target.value)}
                value={context}
              />
            </label>
            <Button
              onClick={() => setDirections((current) => [...current, emptyDirection])}
              size="sm"
              type="button"
              variant="ghost"
            >
              Add another direction
            </Button>
          </div>
        ) : (
          <label className="flex flex-col gap-1 text-sm text-text">
            Add to Memory
            <input
              className="rounded border border-border bg-bg px-2 py-1 text-text"
              onChange={(event) => setTerm(event.target.value)}
              placeholder="a word, phrase, or idea"
              value={term}
            />
          </label>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button pending={pending} type="submit">
            Add
          </Button>
          <Button onClick={() => setDetailsOpen((open) => !open)} type="button" variant="ghost">
            {detailsOpen ? "Hide details" : "Add details"}
          </Button>
        </div>
      </form>

      {!detailsOpen && confirm !== null ? (
        <div className="mt-3 flex flex-col gap-2 border-t border-border pt-3">
          <label className="flex flex-col gap-1 text-sm text-text">
            Answer
            <input
              className="rounded border border-border bg-bg px-2 py-1 text-text"
              onChange={(event) => setAnswer(event.target.value)}
              value={answer}
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              disabled={answer.trim().length === 0}
              onClick={() => confirmSave(confirm.term, true)}
              pending={pending}
              type="button"
            >
              Save
            </Button>
            <Button
              onClick={() => confirmSave(confirm.term, false)}
              pending={pending}
              type="button"
              variant="secondary"
            >
              Save as draft
            </Button>
          </div>
        </div>
      ) : null}

      {info !== null ? <p className="mt-3 text-text-muted">{info}</p> : null}
      {error !== null ? (
        <p className="mt-3 text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
