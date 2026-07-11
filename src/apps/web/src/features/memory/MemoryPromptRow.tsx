import { useState } from "react";

import type { MemoryPromptDto } from "@whetstone/contracts";

import { Button } from "../../shared/ui/Button";
import { editMemoryPrompt } from "./memoryApi";

type MemoryPromptRowProps = Readonly<{ onSaved: () => void; prompt: MemoryPromptDto }>;

// One retrieval direction under a note, editable in place. A draft (no answer) and a scheduled prompt
// look the same to edit — the lifecycle is shown as a plain word, not FSRS jargon. Clearing the answer
// sends an explicit null so the server can revert a scheduled prompt to a draft; giving an answerless
// draft an answer schedules it. Editing content never resets review history — that reconciliation is
// the server's job, so this row just PATCHes and asks the detail to reload.
export function MemoryPromptRow({ onSaved, prompt }: MemoryPromptRowProps): React.JSX.Element {
  const [cue, setCue] = useState(prompt.cueText);
  const [answer, setAnswer] = useState(prompt.answerText ?? "");
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  function save(): void {
    const trimmedAnswer = answer.trim();
    const request =
      trimmedAnswer.length === 0
        ? { answerText: null, cueText: cue.trim() }
        : { answerText: trimmedAnswer, cueText: cue.trim() };
    setPending(true);
    setFailed(false);
    void editMemoryPrompt(prompt.promptId, request)
      .then(
        () => onSaved(),
        () => setFailed(true)
      )
      .finally(() => setPending(false));
  }

  return (
    <li className="flex flex-col gap-2 rounded border border-border p-3">
      <p className="text-xs uppercase tracking-wide text-text-muted">
        {prompt.lifecycle === "scheduled" ? "Scheduled" : "Draft"}
      </p>
      <label className="flex flex-col gap-1 text-sm text-text">
        Cue
        <input
          className="rounded border border-border bg-bg px-2 py-1 text-text"
          onChange={(event) => setCue(event.target.value)}
          value={cue}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm text-text">
        Answer
        <input
          className="rounded border border-border bg-bg px-2 py-1 text-text"
          onChange={(event) => setAnswer(event.target.value)}
          value={answer}
        />
      </label>
      <div>
        <Button
          disabled={cue.trim().length === 0}
          onClick={save}
          pending={pending}
          size="sm"
          type="button"
        >
          Save prompt
        </Button>
      </div>
      {failed ? (
        <p className="text-danger" role="alert">
          Could not save that prompt. Please try again.
        </p>
      ) : null}
    </li>
  );
}
