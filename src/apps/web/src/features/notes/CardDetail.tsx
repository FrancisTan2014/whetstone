import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useEffect, useRef, useState } from "react";

import type { NoteGradingTarget, NotePromptSettingsDto } from "@whetstone/contracts";
import { type DocumentNodeJSON } from "@whetstone/document";

import { Button } from "../../shared/ui/Button";
import { RichContentEditor } from "../../shared/editor/index.js";
import { PmDocument } from "../reader/PmDocument.js";
import { cardStateLabel } from "./cardState";
import { noteWorkspaceClassNames as cx } from "./noteWorkspace.tokens";
import {
  RetrievalContractEditor,
  gradingTargetFor,
  isDocumentBlank,
  type SuccessCheckState
} from "./RetrievalContractEditor";
import {
  SetNoteGradingTargetError,
  addNotePromptCardBack,
  editNotePromptQuestion,
  pauseNotePromptCard,
  removeNotePromptCard,
  restartNotePromptCard,
  resumeNotePromptCard,
  setNoteGradingTarget
} from "../notesReview/notesReviewApi";

type CardDetailProps = Readonly<{
  // Return focus to the "Review history" control when the learner arrives here via Back from History, so
  // the History -> Detail step restores focus to the control they left from.
  focusHistoryButton: boolean;
  // The live canonical note body, shown read-only as Reference while editing so the learner sees exactly
  // what the card grades against. `null` when the note carries no reflowable body (e.g. a Mark). The
  // Reference is never edited here — the canonical note write stays in the Note tab (#700).
  noteBodyDoc: DocumentNodeJSON | null;
  onOpenHistory: () => void;
  onRefreshed: (refreshed: NotePromptSettingsDto) => void;
  onReload: () => void;
  prompt: NotePromptSettingsDto;
  timeZone: string;
}>;

// A stable empty ProseMirror document for the Try preview when a note carries no body — the preview simply
// has nothing to reveal.
const emptyDocument: DocumentNodeJSON = { content: [{ type: "paragraph" }], type: "doc" };

// The failure copy for a settings mutation. A grading-target rejection is named so the learner knows what to
// change; every other failure is the shared retry message.
const gradingFailureMessages: Readonly<Record<SetNoteGradingTargetError["kind"], string>> = {
  invalid_success_check: "Write the success check, or grade against the whole note.",
  legacy_read_only: "This card keeps its original answer and cannot change its grading target.",
  network: "That change could not be saved. The list was refreshed — please try again.",
  not_found: "This card is no longer available. The list was refreshed.",
  restart_requires_card: "Start reviewing this card before restarting its schedule."
};

const genericFailure =
  "That action could not be completed. The list was refreshed — please try again.";

// Whether two grading targets describe the same policy: same kind, and for a Success check the same rich
// document. Compared structurally so a re-opened-then-restored Success check is not treated as a change.
function sameGradingTarget(a: NoteGradingTarget, b: NoteGradingTarget): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  if (a.kind === "expected_response" && b.kind === "expected_response") {
    return JSON.stringify(a.successCheckDoc) === JSON.stringify(b.successCheckDoc);
  }
  return true;
}

// The Success-check disclosure state a prompt's reveal policy seeds: an `expected_response` reveal opens the
// disclosure on its stored Success check; any other reveal starts closed (grade against the whole note).
function seedSuccessCheck(reveal: NotePromptSettingsDto["reveal"]): SuccessCheckState {
  return reveal.kind === "expected_response"
    ? { doc: reveal.successCheckDoc, open: true }
    : { open: false };
}

// One card's focused detail (#700, rich in #687): the current retrieval Question and grading target
// (editable through #690's rich editor with the live note as read-only Reference), the projected schedule
// state, and the state-driven lifecycle actions. Question edits never touch the schedule; a grading-target
// change goes through #686's explicit Keep-schedule / Restart contract. Frequent state changes
// (pause/resume, start) are primary buttons; the infrequent, destructive Restart and Remove live behind a
// detail overflow and each opens an explicit in-Sheet confirmation. A successful action hands the refreshed
// card up (the list and this detail re-render from the server projection); a failed one keeps the detail,
// reports the named error, and reloads the list so a stale row is corrected rather than faking success. It
// never offers a Review/rating action — Today and Notes Review own the routine.
export function CardDetail({
  focusHistoryButton,
  noteBodyDoc,
  onOpenHistory,
  onRefreshed,
  onReload,
  prompt,
  timeZone
}: CardDetailProps): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [questionDoc, setQuestionDoc] = useState<DocumentNodeJSON>(prompt.questionDoc);
  const [successCheck, setSuccessCheck] = useState<SuccessCheckState>(() =>
    seedSuccessCheck(prompt.reveal)
  );
  const [questionInvalid, setQuestionInvalid] = useState(false);
  const [successCheckInvalid, setSuccessCheckInvalid] = useState(false);
  // Once the learner commits an edit that changes the grading target of a card that already has a schedule,
  // this holds the resolved change awaiting the explicit Keep-schedule / Restart decision (#686) before any
  // write happens.
  const [pendingTarget, setPendingTarget] = useState<NoteGradingTarget | null>(null);
  const [confirming, setConfirming] = useState<"restart" | "remove" | null>(null);
  const overflowRef = useRef<HTMLButtonElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const historyRef = useRef<HTMLButtonElement>(null);
  // Which control to focus after a committed action, deferred to a post-commit effect: a synchronous focus
  // inside the resolve callback would target a still-busy (disabled) button and be dropped. After a remove
  // the overflow is gone, so focus lands on the new Start button; otherwise it returns to the overflow.
  const pendingFocus = useRef<"overflow" | "add" | null>(null);

  useEffect(() => {
    const target = pendingFocus.current;
    if (target === null) {
      return;
    }
    pendingFocus.current = null;
    (target === "add" ? addRef.current : overflowRef.current)?.focus();
  });

  // Arriving via Back from History returns focus to the control the learner opened History from.
  useEffect(() => {
    if (focusHistoryButton) {
      historyRef.current?.focus();
    }
  }, [focusHistoryButton]);

  const state = prompt.cardState.state;
  const inReview = state !== "not_in_review";
  const hasCard = state !== "not_in_review";
  const canEditTarget =
    prompt.reveal.kind === "current_note" || prompt.reveal.kind === "expected_response";
  const questionChanged = JSON.stringify(questionDoc) !== JSON.stringify(prompt.questionDoc);

  function beginEditing(): void {
    setQuestionDoc(prompt.questionDoc);
    setSuccessCheck(seedSuccessCheck(prompt.reveal));
    setQuestionInvalid(false);
    setSuccessCheckInvalid(false);
    setPendingTarget(null);
    setFailure(null);
    setEditing(true);
  }

  function cancelEditing(): void {
    setEditing(false);
    setPendingTarget(null);
  }

  // Persist a committed edit: apply the grading target first (it may reset the schedule), then the Question,
  // so the final refreshed row reflects both. Either send is skipped when unchanged. On success the card
  // flows up and editing closes; on failure the drafts stay, the named reason shows, and the list reloads.
  async function persist(
    target: NoteGradingTarget | null,
    mode: "keep" | "restart"
  ): Promise<void> {
    setBusy(true);
    setFailure(null);
    let refreshed: NotePromptSettingsDto | null = null;
    try {
      if (target !== null) {
        refreshed = await setNoteGradingTarget(prompt.promptId, { mode, target });
      }
      if (questionChanged) {
        refreshed = await editNotePromptQuestion(prompt.promptId, questionDoc);
      }
    } catch (error) {
      setBusy(false);
      setFailure(
        error instanceof SetNoteGradingTargetError
          ? gradingFailureMessages[error.kind]
          : genericFailure
      );
      setPendingTarget(null);
      onReload();
      return;
    }
    setBusy(false);
    setPendingTarget(null);
    setEditing(false);
    if (refreshed !== null) {
      onRefreshed(refreshed);
    }
  }

  // Validate and resolve a Save from the rich editor. A grading-target change on a card that already has a
  // schedule pauses for the explicit Keep/Restart decision; every other case persists immediately.
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
      canEditTarget &&
      !sameGradingTarget(nextTarget, gradingTargetFor(seedSuccessCheck(prompt.reveal)));

    if (!questionChanged && !targetChanged) {
      cancelEditing();
      return;
    }
    if (targetChanged && hasCard) {
      // A schedule exists and the trained capability may have changed: the learner must declare Keep or
      // Restart (#686) before anything is written.
      setPendingTarget(nextTarget);
      return;
    }
    void persist(targetChanged ? nextTarget : null, "keep");
  }

  // Run one URL-addressed card transition (pause/resume/start/restart/remove) with the shared in-flight
  // guard: on success the refreshed card flows up; on failure the list reloads and a retryable error shows.
  function run(action: () => Promise<NotePromptSettingsDto>, onDone?: () => void): void {
    setBusy(true);
    setFailure(null);
    action().then(
      (refreshed) => {
        setBusy(false);
        onDone?.();
        onRefreshed(refreshed);
      },
      () => {
        setBusy(false);
        setFailure(genericFailure);
        onReload();
      }
    );
  }

  function confirmRestart(): void {
    run(
      () => restartNotePromptCard(prompt.promptId),
      () => {
        setConfirming(null);
        pendingFocus.current = "overflow";
      }
    );
  }

  function confirmRemove(): void {
    run(
      () => removeNotePromptCard(prompt.promptId),
      () => {
        setConfirming(null);
        pendingFocus.current = "add";
      }
    );
  }

  return (
    <div className="noteCardDetail">
      <div className="noteCardDetailQuestion">
        {editing ? (
          canEditTarget ? (
            <RetrievalContractEditor
              actions={
                <>
                  <Button onClick={saveEdits} pending={busy} type="button">
                    Save
                  </Button>
                  <Button disabled={busy} onClick={cancelEditing} type="button" variant="secondary">
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
                <div className="noteCardDetailReference">
                  {noteBodyDoc === null ? (
                    <p className="text-text-muted">This note has no body to reveal.</p>
                  ) : (
                    <PmDocument document={noteBodyDoc} />
                  )}
                </div>
              }
              workspaceBlank={noteBodyDoc === null || isDocumentBlank(noteBodyDoc)}
              workspaceDoc={noteBodyDoc ?? emptyDocument}
            />
          ) : (
            <div className="noteReviewSettingsEdit">
              <label className="noteReviewQuestionField">
                <span className="noteReviewQuestionLabel">Question</span>
                <RichContentEditor
                  ariaLabel="Question"
                  document={questionDoc}
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
              <div className="noteReviewConfirmActions">
                <Button onClick={saveEdits} pending={busy} type="button">
                  Save
                </Button>
                <Button disabled={busy} onClick={cancelEditing} type="button" variant="secondary">
                  Cancel
                </Button>
              </div>
            </div>
          )
        ) : (
          <>
            <p className="noteReviewSettingsQuestionText">{prompt.questionText}</p>
            <Button
              className="min-h-11"
              onClick={beginEditing}
              size="sm"
              type="button"
              variant="ghost"
            >
              Edit question
            </Button>
          </>
        )}
      </div>

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

      {!editing ? (
        <>
          <p className="noteReviewSettingsReveal">
            {prompt.reveal.kind === "current_note"
              ? "Reveals the current note"
              : prompt.reveal.kind === "expected_response"
                ? "Success check"
                : "Custom answer (read-only)"}
          </p>
          {prompt.reveal.kind === "expected_response" ? (
            <p className="noteReviewSettingsSuccessCheck">{prompt.reveal.successCheckText}</p>
          ) : prompt.reveal.kind === "legacy_custom" ? (
            <p className="noteReviewSettingsLegacyAnswer">{prompt.reveal.answerText}</p>
          ) : null}
        </>
      ) : null}

      <p className="noteReviewSettingsState">
        {cardStateLabel(prompt.cardState, new Date(), timeZone)}
      </p>

      <div className="noteReviewSettingsActions">
        {state === "due" || state === "scheduled" ? (
          <Button
            disabled={busy}
            onClick={() => run(() => pauseNotePromptCard(prompt.promptId))}
            type="button"
            variant="secondary"
          >
            Pause
          </Button>
        ) : null}
        {state === "paused" ? (
          <Button
            disabled={busy}
            onClick={() => run(() => resumeNotePromptCard(prompt.promptId))}
            type="button"
          >
            Resume
          </Button>
        ) : null}
        {state === "not_in_review" ? (
          <Button
            disabled={busy}
            onClick={() => run(() => addNotePromptCardBack(prompt.promptId))}
            ref={addRef}
            type="button"
          >
            Start reviewing
          </Button>
        ) : null}

        <Button
          className="min-h-11"
          onClick={onOpenHistory}
          ref={historyRef}
          size="sm"
          type="button"
          variant="ghost"
        >
          Review history
        </Button>

        {inReview ? (
          <DropdownMenu.Root modal={false}>
            <DropdownMenu.Trigger asChild>
              <Button
                aria-label="More card actions"
                className="min-w-11 px-2"
                ref={overflowRef}
                variant="ghost"
              >
                <span aria-hidden="true">⋯</span>
              </Button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Content align="end" className={cx.overflowContent} sideOffset={4}>
              <DropdownMenu.Item
                className={cx.overflowItem}
                onSelect={() => setConfirming("restart")}
              >
                Restart schedule
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className={cx.overflowDestructiveItem}
                onSelect={() => setConfirming("remove")}
              >
                Remove from review
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        ) : null}
      </div>

      {confirming === "restart" ? (
        <div className="noteReviewConfirm" role="group">
          <p>Restart the schedule for “{prompt.questionText}”? Its next review becomes now.</p>
          <div className="noteReviewConfirmActions">
            <Button onClick={confirmRestart} pending={busy} type="button">
              Confirm restart
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setConfirming(null);
                overflowRef.current?.focus();
              }}
              type="button"
              variant="secondary"
            >
              Cancel restart
            </Button>
          </div>
        </div>
      ) : null}

      {confirming === "remove" ? (
        <div className="noteReviewConfirm" role="group">
          <p>Remove “{prompt.questionText}” from review? The note and its history are kept.</p>
          <div className="noteReviewConfirmActions">
            <Button onClick={confirmRemove} pending={busy} type="button">
              Confirm remove
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setConfirming(null);
                overflowRef.current?.focus();
              }}
              type="button"
              variant="secondary"
            >
              Cancel remove
            </Button>
          </div>
        </div>
      ) : null}

      {failure !== null ? <p role="alert">{failure}</p> : null}
    </div>
  );
}
