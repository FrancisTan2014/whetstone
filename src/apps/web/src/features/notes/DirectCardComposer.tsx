import { useState } from "react";

import type { DirectCardResultDto } from "@whetstone/contracts";
import { type DocumentNodeJSON } from "@whetstone/document";

import {
  RetrievalContractEditor,
  gradingTargetFor,
  isDocumentBlank,
  type SuccessCheckState
} from "./RetrievalContractEditor";
import {
  CreateDirectCardError,
  createDirectCard,
  type CreateDirectCardErrorKind
} from "../notesReview/notesReviewApi";
import { RichContentEditor } from "../../shared/editor/index.js";
import { createEmptyDocument } from "../../shared/editor/editorDocument.js";
import { Button } from "../../shared/ui/Button";
import { Sheet } from "../../shared/ui/Sheet";

type DirectCardComposerProps = Readonly<{
  onClose: () => void;
  onCreated: (result: DirectCardResultDto) => void;
}>;

// The failure copy for each recoverable outcome. Every case keeps the learner's drafts on screen; the
// message only tells them whether to retry as-is (`network`) or that the drafts must change (`conflict`,
// `gone`, `invalid`). Kept exhaustive so a new error kind is a type error, not a silent blank.
const failureMessages: Readonly<Record<CreateDirectCardErrorKind, string>> = {
  conflict: "This card was already started with different wording. Edit a field and try again.",
  gone: "That draft can no longer be used. Edit a field to start a fresh card.",
  invalid: "Whetstone could not accept this card. Check the question and answer, then try again.",
  network: "Could not create the card. Please try again."
};

// The direct-card composer (#690): the primary Notes-home action opens this wide sheet to mint one recurring
// review card straight from an authored Question/Answer pair — no saved note required first. It owns every
// draft (Answer, Question, Success check) plus the stable `submissionId`, minted once when the sheet opens
// and retained across recoverable failures so a retry is idempotent and never double-creates. The Answer is
// the workspace the reusable `RetrievalContractEditor` frames; the target-first order (Answer, then
// Question, then the optional Success check) matches the review it produces. A blank required field blocks
// creation inline; a failed create keeps everything on screen; a pending create prevents dismissal and a
// repeat submit. On success the parent closes, refreshes, and announces the new card.
export function DirectCardComposer({
  onClose,
  onCreated
}: DirectCardComposerProps): React.JSX.Element {
  // The stable retry identity: minted once for this composer instance so every attempt — including retries
  // after a recoverable failure — carries the same id and the server replays one creation, never two.
  const [submissionId] = useState(() => crypto.randomUUID());
  const [answerDoc, setAnswerDoc] = useState<DocumentNodeJSON>(() => createEmptyDocument());
  const [questionDoc, setQuestionDoc] = useState<DocumentNodeJSON>(() => createEmptyDocument());
  const [successCheck, setSuccessCheck] = useState<SuccessCheckState>({ open: false });
  const [answerInvalid, setAnswerInvalid] = useState(false);
  const [questionInvalid, setQuestionInvalid] = useState(false);
  const [successCheckInvalid, setSuccessCheckInvalid] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<CreateDirectCardErrorKind | null>(null);

  const answerBlank = isDocumentBlank(answerDoc);

  function requestClose(): void {
    // A create in flight owns the sheet: dismissing mid-request could strand a card the retry-safe id would
    // otherwise recover, so the close is ignored until it settles.
    if (pending) {
      return;
    }
    onClose();
  }

  async function create(): Promise<void> {
    const questionBlank = isDocumentBlank(questionDoc);
    const successCheckBlank = successCheck.open ? isDocumentBlank(successCheck.doc) : false;
    // Validate every required field at once so all inline messages surface together, then stop before a
    // request that the server would only reject.
    setAnswerInvalid(answerBlank);
    setQuestionInvalid(questionBlank);
    setSuccessCheckInvalid(successCheckBlank);
    if (answerBlank || questionBlank || successCheckBlank) {
      return;
    }

    setFailure(null);
    setPending(true);
    let result: DirectCardResultDto;
    try {
      result = await createDirectCard({
        answerDoc,
        questionDoc,
        submissionId,
        target: gradingTargetFor(successCheck)
      });
    } catch (error) {
      // Keep every draft and the submission id; only surface why so the learner can retry as-is or edit.
      setFailure(error instanceof CreateDirectCardError ? error.kind : "network");
      return;
    } finally {
      setPending(false);
    }
    onCreated(result);
  }

  return (
    <Sheet onOpenChange={requestClose} open size="wide" title="New card">
      <RetrievalContractEditor
        actions={
          <>
            <Button onClick={() => void create()} pending={pending} type="button">
              Create card
            </Button>
            <Button disabled={pending} onClick={requestClose} type="button" variant="secondary">
              Cancel
            </Button>
          </>
        }
        answerLabel="What do you want to be able to recall or do?"
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
          <>
            <RichContentEditor
              ariaLabel="Answer"
              document={answerDoc}
              onChange={(doc) => {
                setAnswerDoc(doc);
                setAnswerInvalid(false);
              }}
              presentation="workspace"
            />
            {answerInvalid ? (
              <p className="text-danger" role="alert">
                Write what you want to be able to recall or do.
              </p>
            ) : null}
          </>
        }
        workspaceBlank={answerBlank}
        workspaceDoc={answerDoc}
      />

      <p className="directCardGuidance text-text-muted">Adds one recurring review.</p>

      {failure !== null ? (
        <p className="text-danger" role="alert">
          {failureMessages[failure]}
        </p>
      ) : null}
    </Sheet>
  );
}
