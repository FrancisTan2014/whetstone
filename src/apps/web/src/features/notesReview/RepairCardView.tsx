import { useEffect, useRef, useState } from "react";

import type { NoteGradingTarget, NotePromptSettingsDto } from "@whetstone/contracts";
import { type DocumentNodeJSON } from "@whetstone/document";

import { Button } from "../../shared/ui/Button";
import { LoadingIndicator } from "../../shared/ui/LoadingIndicator";
import { RichContentEditor } from "../../shared/editor/index.js";
import { PmDocument } from "../reader/PmDocument.js";
import {
  genericGradingFailure,
  gradingFailureMessages,
  questionFailureMessages,
  sameGradingTarget,
  seedSuccessCheck
} from "../notes/gradingTarget";
import {
  RetrievalContractEditor,
  gradingTargetFor,
  isDocumentBlank,
  type SuccessCheckState
} from "../notes/RetrievalContractEditor";
import {
  EditNotePromptQuestionError,
  SetNoteGradingTargetError,
  editNotePromptQuestion,
  fetchNoteReveal,
  fetchNotePromptSettings,
  setNoteGradingTarget
} from "./notesReviewApi";

type RepairCardViewProps = Readonly<{
  // The prompt being repaired and the note it reviews — the only identity the review session holds.
  promptId: string;
  noteId: string;
  // Abandon the repair and return to the exact prior review step (question or revealed). No write happens.
  onCancel: () => void;
  // A committed repair: the refreshed settings row flows up so the session re-attempts the same prompt from
  // a fresh Question phase. No rating event is ever appended by this view.
  onRepaired: (refreshed: NotePromptSettingsDto) => void;
  // Edit the shared note body in the existing editor (the Reference is read-only here because siblings may
  // share it). The session navigates to the note; this view never mutates the body.
  onOpenNote: (noteId: string) => void;
}>;

// A stable empty document for a Try preview / edit against a note whose body renders blank.
const emptyDocument: DocumentNodeJSON = { content: [{ type: "paragraph" }], type: "doc" };

// What a successful load resolved, discriminated by whether the reveal's grading target is editable. A
// `contract` reveal (current note / expected response) carries the live note body as the read-only
// Reference and edits both Question and grading target; a `legacy` reveal preserves its own custom answer
// and edits the Question only (a legacy reveal is never converted, #657). `siblingCount` lets a shared-note
// edit be truthfully flagged.
type RepairData =
  | Readonly<{
      kind: "contract";
      prompt: NotePromptSettingsDto;
      referenceDoc: DocumentNodeJSON;
      siblingCount: number;
    }>
  | Readonly<{ kind: "legacy"; prompt: NotePromptSettingsDto; siblingCount: number }>;

type LoadState =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "error" }>
  | Readonly<{ status: "ready"; data: RepairData }>;

// Repair an unclear card before rating (#691): a no-rating path opened from either review phase to fix a
// confusing Question or grading target in place. It reuses the Cards retrieval-contract editor with the live
// note as a READ-ONLY Reference (a sibling card may share it — editing the body happens in the note editor,
// reachable via Open note), and reuses #686's explicit Keep-schedule / Restart contract when the grading
// target changes on a card that already has a schedule. Entering, cancelling, failing, and saving never
// append a rating event and never touch the due date; a Question-only edit keeps the schedule outright.
// On save the refreshed prompt flows up so the learner re-attempts the clarified card from a fresh Question
// phase before grading it.
export function RepairCardView({
  promptId,
  noteId,
  onCancel,
  onRepaired,
  onOpenNote
}: RepairCardViewProps): React.JSX.Element {
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  // The editable drafts, seeded on each successful (re)load. Held apart from the loaded baseline so a
  // failed save keeps them while `Reload card` can discard them and resync to the server.
  const [questionDoc, setQuestionDoc] = useState<DocumentNodeJSON>(emptyDocument);
  const [successCheck, setSuccessCheck] = useState<SuccessCheckState>({ open: false });
  const [questionInvalid, setQuestionInvalid] = useState(false);
  const [successCheckInvalid, setSuccessCheckInvalid] = useState(false);
  // A committed grading-target change on a card with a schedule waits here for the explicit Keep/Restart
  // decision (#686) before any write happens.
  const [pendingTarget, setPendingTarget] = useState<NoteGradingTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  // Focus the repair heading on entry so assistive tech announces the mode change.
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Load the prompt's settings row (question + reveal policy + sibling count + card state) and its live
  // note body (the Reference), then seed the drafts. Runs on mount and on each `Reload card`. State moves
  // happen only in the promise callbacks so the set-state-in-effect lint stays satisfied.
  useEffect(() => {
    let active = true;
    Promise.all([fetchNotePromptSettings(noteId), fetchNoteReveal(promptId)]).then(
      ([settings, reveal]) => {
        if (!active) {
          return;
        }
        const prompt = settings.prompts.find((candidate) => candidate.promptId === promptId);
        if (prompt === undefined) {
          setLoad({ status: "error" });
          return;
        }
        const siblingCount = settings.prompts.length;
        const data: RepairData =
          reveal.kind === "current_note"
            ? { kind: "contract", prompt, referenceDoc: reveal.bodyDoc, siblingCount }
            : reveal.kind === "expected_response"
              ? { kind: "contract", prompt, referenceDoc: reveal.referenceDoc, siblingCount }
              : { kind: "legacy", prompt, siblingCount };
        setQuestionDoc(prompt.questionDoc);
        setSuccessCheck(seedSuccessCheck(prompt.reveal));
        setQuestionInvalid(false);
        setSuccessCheckInvalid(false);
        setPendingTarget(null);
        setFailure(null);
        setLoad({ data, status: "ready" });
      },
      () => {
        if (active) {
          setLoad({ status: "error" });
        }
      }
    );
    return () => {
      active = false;
    };
  }, [noteId, promptId, reloadNonce]);

  // Focus the repair heading once the view is ready (on mount the loading placeholder renders instead, so
  // the heading is not in the DOM yet). Re-running on `load.status` moves focus when it first mounts so
  // assistive tech announces the mode change.
  useEffect(() => {
    if (load.status === "ready") {
      headingRef.current?.focus();
    }
  }, [load.status]);

  // Escape abandons the repair, but never mid-write — a pending save must resolve before the view unmounts.
  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape" && !busy) {
      onCancel();
    }
  }

  if (load.status === "loading") {
    return <LoadingIndicator label="Opening this card to fix…" />;
  }

  if (load.status === "error") {
    return (
      <div className="noteReviewRepair">
        <p className="text-danger" role="alert">
          This card is no longer available.
        </p>
        <div className="noteReviewConfirmActions">
          <Button onClick={onCancel} type="button" variant="secondary">
            Back to review
          </Button>
        </div>
      </div>
    );
  }

  const { data } = load;
  const { prompt, siblingCount } = data;
  const hasCard = prompt.cardState.state !== "not_in_review";
  const questionChanged = JSON.stringify(questionDoc) !== JSON.stringify(prompt.questionDoc);

  // Persist a committed edit: apply the grading target first (it may reset the schedule), then the Question,
  // so the refreshed row reflects both. Either send is skipped when unchanged. On success the prompt flows
  // up; on failure the drafts stay, the named reason shows, and `Reload card` can resync.
  async function persist(
    target: NoteGradingTarget | null,
    mode: "keep" | "restart"
  ): Promise<void> {
    setBusy(true);
    setFailure(null);
    try {
      let refreshed: NotePromptSettingsDto;
      if (target !== null) {
        refreshed = await setNoteGradingTarget(promptId, {
          expectedRevision: prompt.revision,
          mode,
          target
        });
        if (questionChanged) {
          refreshed = await editNotePromptQuestion(promptId, {
            expectedRevision: refreshed.revision,
            questionDoc
          });
        }
      } else {
        refreshed = await editNotePromptQuestion(promptId, {
          expectedRevision: prompt.revision,
          questionDoc
        });
      }
      setBusy(false);
      setPendingTarget(null);
      onRepaired(refreshed);
    } catch (error) {
      setBusy(false);
      setPendingTarget(null);
      setFailure(
        error instanceof SetNoteGradingTargetError
          ? gradingFailureMessages[error.kind]
          : error instanceof EditNotePromptQuestionError
            ? questionFailureMessages[error.kind]
            : genericGradingFailure
      );
    }
  }

  // Validate and resolve a Save. A grading-target change on a card that already has a schedule pauses for
  // the explicit Keep/Restart decision; every other case persists immediately. Nothing changed cancels out.
  function saveEdits(): void {
    const questionBlank = isDocumentBlank(questionDoc);
    const successCheckBlank = successCheck.open ? isDocumentBlank(successCheck.doc) : false;
    setQuestionInvalid(questionBlank);
    setSuccessCheckInvalid(successCheckBlank);
    if (questionBlank || successCheckBlank) {
      return;
    }

    const nextTarget = gradingTargetFor(successCheck);
    const targetChanged =
      data.kind === "contract" &&
      !sameGradingTarget(nextTarget, gradingTargetFor(seedSuccessCheck(prompt.reveal)));

    if (!questionChanged && !targetChanged) {
      onCancel();
      return;
    }
    if (targetChanged && hasCard) {
      setPendingTarget(nextTarget);
      return;
    }
    void persist(targetChanged ? nextTarget : null, "keep");
  }

  const actions = (
    <>
      <Button disabled={pendingTarget !== null} onClick={saveEdits} pending={busy} type="button">
        Save
      </Button>
      <Button
        disabled={busy || pendingTarget !== null}
        onClick={onCancel}
        type="button"
        variant="secondary"
      >
        Cancel
      </Button>
    </>
  );

  return (
    <div className="noteReviewRepair" onKeyDown={handleKeyDown}>
      <h2 className="noteReviewRepairHeading" ref={headingRef} tabIndex={-1}>
        Fix this card
      </h2>
      <p className="text-text-muted">
        Clarify the question or how it is graded. This never counts as a review — the card stays
        due.
      </p>

      {data.kind === "contract" ? (
        <RetrievalContractEditor
          actions={actions}
          answerLabel="Answer"
          editable={!busy && pendingTarget === null}
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
            <div className="noteReviewRepairReference">
              <PmDocument document={data.referenceDoc} />
              {siblingCount > 1 ? (
                <p className="noteReviewRepairSharedWarning text-text-muted">
                  This note has {siblingCount} review cards. Editing the note changes what all of
                  them reveal.
                </p>
              ) : null}
              <Button
                className="min-h-11"
                disabled={busy || pendingTarget !== null}
                onClick={() => onOpenNote(noteId)}
                size="sm"
                type="button"
                variant="ghost"
              >
                Open note
              </Button>
            </div>
          }
          workspaceBlank={isDocumentBlank(data.referenceDoc)}
          workspaceDoc={data.referenceDoc}
        />
      ) : (
        <div className="noteReviewSettingsEdit">
          <label className="noteReviewQuestionField">
            <span className="noteReviewQuestionLabel">Question</span>
            <RichContentEditor
              ariaLabel="Question"
              document={questionDoc}
              editable={!busy}
              onChange={(doc) => {
                setQuestionDoc(doc);
                setQuestionInvalid(false);
              }}
              presentation="compact"
            />
          </label>
          {questionInvalid ? (
            <p className="text-danger" role="alert">
              Write what should bring it to mind.
            </p>
          ) : null}
          <div className="noteReviewConfirmActions">{actions}</div>
        </div>
      )}

      {pendingTarget !== null ? (
        <div className="noteReviewConfirm" role="group">
          <p>
            You changed how this card is graded. Keep its schedule, or restart it because the
            trained capability changed?
          </p>
          <div className="noteReviewConfirmActions">
            <Button
              onClick={() => void persist(pendingTarget, "keep")}
              pending={busy}
              type="button"
            >
              Keep schedule
            </Button>
            <Button
              onClick={() => void persist(pendingTarget, "restart")}
              pending={busy}
              type="button"
              variant="secondary"
            >
              Restart
            </Button>
            <Button
              disabled={busy}
              onClick={() => setPendingTarget(null)}
              type="button"
              variant="ghost"
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {failure !== null ? (
        <div className="noteReviewRepairFailure" role="group">
          <p role="alert">{failure}</p>
          <Button
            disabled={busy}
            onClick={() => {
              setLoad({ status: "loading" });
              setReloadNonce((nonce) => nonce + 1);
            }}
            type="button"
            variant="secondary"
          >
            Reload card
          </Button>
        </div>
      ) : null}
    </div>
  );
}
