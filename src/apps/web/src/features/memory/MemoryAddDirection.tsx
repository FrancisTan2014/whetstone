import { useState } from "react";

import { Button } from "../../shared/ui/Button";
import { addPromptToNote } from "./memoryApi";

type MemoryAddDirectionProps = Readonly<{ noteId: string; onAdded: () => void }>;

// The "add a direction" form on a note's detail: one more retrieval prompt for an existing memory. A
// cue is required; an answerless direction saves as a draft, an answered one schedules. On success it
// clears itself and asks the detail to reload.
export function MemoryAddDirection({
  noteId,
  onAdded
}: MemoryAddDirectionProps): React.JSX.Element {
  const [cue, setCue] = useState("");
  const [answer, setAnswer] = useState("");
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  function submit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmedCue = cue.trim();
    if (trimmedCue.length === 0) {
      return;
    }

    const trimmedAnswer = answer.trim();
    const request =
      trimmedAnswer.length === 0
        ? { cueText: trimmedCue }
        : { answerText: trimmedAnswer, cueText: trimmedCue };
    setPending(true);
    setFailed(false);
    void addPromptToNote(noteId, request)
      .then(
        () => {
          setCue("");
          setAnswer("");
          onAdded();
        },
        () => setFailed(true)
      )
      .finally(() => setPending(false));
  }

  return (
    <form
      className="flex flex-col gap-2 rounded border border-dashed border-border p-3"
      onSubmit={submit}
    >
      <p className="text-sm font-medium text-text">Add a direction</p>
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
        <Button pending={pending} size="sm" type="submit">
          Add direction
        </Button>
      </div>
      {failed ? (
        <p className="text-danger" role="alert">
          Could not add that direction. Please try again.
        </p>
      ) : null}
    </form>
  );
}
