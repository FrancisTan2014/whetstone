import { useState } from "react";

import type { DirectCardResultDto } from "@whetstone/contracts";
import { type DocumentNodeJSON } from "@whetstone/document";

import { PmDocument } from "../reader/PmDocument.js";
import {
  RetrievalContractEditor,
  gradingTargetFor,
  isDocumentBlank,
  type SuccessCheckState
} from "./RetrievalContractEditor";
import {
  AuthorNoteCardError,
  authorNoteCard,
  type AuthorNoteCardErrorKind
} from "../notesReview/notesReviewApi";
import { createEmptyDocument } from "../../shared/editor/editorDocument.js";
import { Button } from "../../shared/ui/Button";

type SavedNoteCardComposerProps = Readonly<{
  noteEntryId: string;
  // The saved note body, framed as the read-only Answer/Reference the first card grades against. Never
  // mutated here — the canonical note write stays in the Note tab (#700).
  noteBodyDoc: DocumentNodeJSON;
  // An anchored Reader note's exact selected source, shown verbatim as Reference context. `null` for a
  // standalone note. The selection never silently becomes the Question, the Answer direction, or the card
  // type — the learner always authors the Question from blank.
  sourceSnapshot: string | null;
  onCancel: () => void;
  onCreated: (result: DirectCardResultDto) => void;
}>;

// The failure copy for each recoverable outcome. Every case keeps the learner's rich drafts on screen; the
// message only says whether to retry as-is (`network`), that the drafts must change (`conflict`, `invalid`),
// or that the note can no longer take a first card here (`already_authored`, `gone`, `not_found`) so Back is
// the right move. Kept exhaustive so a new error kind is a type error, not a silent blank.
const failureMessages: Readonly<Record<AuthorNoteCardErrorKind, string>> = {
  already_authored: "This note already has a card. Go back to manage it.",
  conflict: "This card was already started with different wording. Edit a field and try again.",
  gone: "This note is no longer available. Go back to the cards list.",
  invalid: "Whetstone could not accept this card. Check the question, then try again.",
  network: "Could not create the card. Please try again.",
  not_found: "This note is no longer available. Go back to the cards list."
};

// The saved-note first-card composer (#687): opened from the Cards list of a non-Mark note that has no
// authored prompt, it authors ONE rich retrieval card over the EXISTING note in place — never a second
// editor, never copying or rewriting the note. It reuses #690's `RetrievalContractEditor` with the persisted
// note as the read-only Answer/Reference, a blank Question, and the optional Success check + Try preview. It
// owns every rich draft (Question, Success check) plus a `submissionId`, minted on open and kept across a
// lost-response (`network`) retry so authoring is idempotent and never double-creates, but refreshed after a
// `conflict`/`gone` outcome whose server receipt is already burned. A blank required field blocks creation
// inline; a failed create keeps every draft; a pending create prevents dismissal and a repeat submit. On
// success the parent returns to the list, focuses the new row, and announces it.
export function SavedNoteCardComposer({
  noteEntryId,
  noteBodyDoc,
  sourceSnapshot,
  onCancel,
  onCreated
}: SavedNoteCardComposerProps): React.JSX.Element {
  const [submissionId, setSubmissionId] = useState(() => crypto.randomUUID());
  const [questionDoc, setQuestionDoc] = useState<DocumentNodeJSON>(() => createEmptyDocument());
  const [successCheck, setSuccessCheck] = useState<SuccessCheckState>({ open: false });
  const [questionInvalid, setQuestionInvalid] = useState(false);
  const [successCheckInvalid, setSuccessCheckInvalid] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<AuthorNoteCardErrorKind | null>(null);

  const workspaceBlank = isDocumentBlank(noteBodyDoc);

  async function create(): Promise<void> {
    const questionBlank = isDocumentBlank(questionDoc);
    const successCheckBlank = successCheck.open ? isDocumentBlank(successCheck.doc) : false;
    setQuestionInvalid(questionBlank);
    setSuccessCheckInvalid(successCheckBlank);
    if (questionBlank || successCheckBlank) {
      return;
    }

    setFailure(null);
    setPending(true);
    let result: DirectCardResultDto;
    try {
      result = await authorNoteCard({
        noteEntryId,
        questionDoc,
        submissionId,
        target: gradingTargetFor(successCheck)
      });
    } catch (error) {
      // Keep every draft on screen; only surface why. A `network` failure is retry-safe with the same id; a
      // `conflict`/`gone` receipt is already burned server-side, so mint a fresh id or the suggested
      // edit-and-retry would loop forever against the same rejected receipt.
      const kind = error instanceof AuthorNoteCardError ? error.kind : "network";
      if (kind === "conflict" || kind === "gone") {
        setSubmissionId(crypto.randomUUID());
      }
      setFailure(kind);
      return;
    } finally {
      setPending(false);
    }
    onCreated(result);
  }

  return (
    <div className="savedNoteCardComposer">
      <RetrievalContractEditor
        actions={
          <>
            <Button onClick={() => void create()} pending={pending} type="button">
              Add card
            </Button>
            {/* disabled while a create is in flight so the composer can't be dismissed mid-request and
                strand a card the retry-safe id would recover. */}
            <Button disabled={pending} onClick={onCancel} type="button" variant="secondary">
              Cancel
            </Button>
          </>
        }
        answerLabel="Answer"
        onQuestionChange={(doc) => {
          setQuestionDoc(doc);
          setQuestionInvalid(false);
        }}
        onSuccessCheckChange={(next) => {
          setSuccessCheck(next);
          setSuccessCheckInvalid(false);
        }}
        questionDoc={questionDoc}
        questionInvalid={questionInvalid}
        referenceLabel="Reference"
        successCheck={successCheck}
        successCheckInvalid={successCheckInvalid}
        workspace={
          <div className="savedNoteCardComposerReference">
            {sourceSnapshot !== null ? (
              <p className="savedNoteCardComposerSource text-text-muted">{sourceSnapshot}</p>
            ) : null}
            <PmDocument document={noteBodyDoc} />
          </div>
        }
        workspaceBlank={workspaceBlank}
        workspaceDoc={noteBodyDoc}
      />

      <p className="directCardGuidance text-text-muted">Adds one recurring review.</p>

      {failure !== null ? (
        <p className="text-danger" role="alert">
          {failureMessages[failure]}
        </p>
      ) : null}
    </div>
  );
}
