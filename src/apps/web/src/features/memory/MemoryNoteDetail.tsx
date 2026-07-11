import { useCallback, useEffect, useState } from "react";

import type { MemoryNoteDetailDto } from "@whetstone/contracts";

import { Button } from "../../shared/ui/Button";
import { LoadingIndicator } from "../../shared/ui/LoadingIndicator";
import { deleteMemoryNote, editMemoryNote, getMemoryNote } from "./memoryApi";
import { MemoryAddDirection } from "./MemoryAddDirection";
import { MemoryPromptRow } from "./MemoryPromptRow";

type MemoryNoteDetailProps = Readonly<{
  noteId: string;
  onClose: () => void;
}>;

type DetailState =
  | Readonly<{ detail: MemoryNoteDetailDto; status: "ready" }>
  | Readonly<{ status: "error" }>
  | Readonly<{ status: "loading" }>;

// One note's detail: the durable body, editable inline, its prompts (each editable), an add-a-direction
// form, and delete. Editing the body or a prompt reloads this detail so the counts and lifecycle labels
// stay honest; deleting closes back to the list. Review scheduling is untouched here — the reader stays
// calm and the actual review flow lives at /recall.
export function MemoryNoteDetail({ noteId, onClose }: MemoryNoteDetailProps): React.JSX.Element {
  const [state, setState] = useState<DetailState>({ status: "loading" });
  const [bodyDraft, setBodyDraft] = useState("");
  const [bodyPending, setBodyPending] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const result = await getMemoryNote(noteId);
      setState({ detail: result, status: "ready" });
      setBodyDraft(result.note.bodyText);
    } catch {
      setState({ status: "error" });
    }
  }, [noteId]);

  useEffect(() => {
    void load();
  }, [load]);

  function reload(): void {
    void load();
  }

  function saveBody(): void {
    setBodyPending(true);
    setActionFailed(false);
    void editMemoryNote(noteId, { noteText: bodyDraft })
      .then(
        (updated) => {
          setState({ detail: updated, status: "ready" });
          setBodyDraft(updated.note.bodyText);
        },
        () => setActionFailed(true)
      )
      .finally(() => setBodyPending(false));
  }

  function remove(): void {
    setActionFailed(false);
    void deleteMemoryNote(noteId).then(
      () => onClose(),
      () => setActionFailed(true)
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Button onClick={onClose} size="sm" variant="ghost">
        Back to memory
      </Button>
      {renderBody(
        state,
        bodyDraft,
        bodyPending,
        actionFailed,
        setBodyDraft,
        saveBody,
        remove,
        reload
      )}
    </div>
  );
}

function renderBody(
  state: DetailState,
  bodyDraft: string,
  bodyPending: boolean,
  actionFailed: boolean,
  setBodyDraft: (value: string) => void,
  saveBody: () => void,
  remove: () => void,
  reload: () => void
): React.JSX.Element {
  if (state.status === "loading") {
    return <LoadingIndicator label="Opening this memory…" />;
  }

  if (state.status === "error") {
    return (
      <p className="text-danger" role="alert">
        Could not open this memory. Please try again.
      </p>
    );
  }

  const { detail } = state;

  return (
    <section aria-label="Memory detail" className="flex flex-col gap-4">
      <label className="flex flex-col gap-1 text-sm text-text">
        Fragment
        <textarea
          className="rounded border border-border bg-bg px-2 py-1 text-text"
          onChange={(event) => setBodyDraft(event.target.value)}
          value={bodyDraft}
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={bodyDraft.trim().length === 0} onClick={saveBody} pending={bodyPending}>
          Save fragment
        </Button>
        <Button onClick={remove} variant="secondary">
          Delete
        </Button>
      </div>
      {actionFailed ? (
        <p className="text-danger" role="alert">
          That change did not go through. Please try again.
        </p>
      ) : null}

      <ul aria-label="Directions" className="flex flex-col gap-3">
        {detail.prompts.map((prompt) => (
          <MemoryPromptRow key={prompt.promptId} onSaved={reload} prompt={prompt} />
        ))}
      </ul>

      <MemoryAddDirection noteId={detail.note.noteId} onAdded={reload} />
    </section>
  );
}
