import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useEffect, useRef, useState } from "react";

import type { NotePromptSettingsDto } from "@whetstone/contracts";

import { Button } from "../../shared/ui/Button";
import { cardStateLabel } from "./cardState";
import { noteWorkspaceClassNames as cx } from "./noteWorkspace.tokens";
import {
  addNotePromptCardBack,
  editNotePromptQuestion,
  pauseNotePromptCard,
  removeNotePromptCard,
  restartNotePromptCard,
  resumeNotePromptCard
} from "../notesReview/notesReviewApi";

type CardDetailProps = Readonly<{
  // Return focus to the "Review history" control when the learner arrives here via Back from History, so
  // the History -> Detail step restores focus to the control they left from.
  focusHistoryButton: boolean;
  onOpenHistory: () => void;
  onRefreshed: (refreshed: NotePromptSettingsDto) => void;
  onReload: () => void;
  prompt: NotePromptSettingsDto;
  timeZone: string;
}>;

// One card's focused detail (#700): the current retrieval Question (editable), its reveal policy, the
// projected schedule state, and the state-driven lifecycle actions. Frequent state changes (pause/resume,
// re-add) are primary buttons; the infrequent, destructive Restart and Remove live behind a detail overflow
// and each opens an explicit in-Sheet confirmation. A successful action hands the refreshed card up (the
// list and this detail re-render from the server projection); a failed one keeps the detail, reports the
// named error, and reloads the list so a stale row is corrected rather than faking success. It never offers
// a Review/rating action — Today and Notes Review own the routine.
export function CardDetail({
  focusHistoryButton,
  onOpenHistory,
  onRefreshed,
  onReload,
  prompt,
  timeZone
}: CardDetailProps): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(prompt.questionText);
  const [confirming, setConfirming] = useState<"restart" | "remove" | null>(null);
  const overflowRef = useRef<HTMLButtonElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const historyRef = useRef<HTMLButtonElement>(null);
  // Which control to focus after a committed action, deferred to a post-commit effect: a synchronous focus
  // inside the resolve callback would target a still-busy (disabled) button and be dropped. After a remove
  // the overflow is gone, so focus lands on the new Add button; otherwise it returns to the overflow trigger.
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

  // Run one settings mutation with a shared in-flight guard: on success the refreshed card flows up; on
  // failure the list reloads (so a stale row is corrected) and a retryable error shows.
  function run(action: () => Promise<NotePromptSettingsDto>, onDone?: () => void): void {
    setBusy(true);
    setFailed(false);
    action().then(
      (refreshed) => {
        setBusy(false);
        onDone?.();
        onRefreshed(refreshed);
      },
      () => {
        setBusy(false);
        setFailed(true);
        onReload();
      }
    );
  }

  function saveQuestion(): void {
    run(
      () => editNotePromptQuestion(prompt.promptId, draft.trim()),
      () => setEditing(false)
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

  const state = prompt.cardState.state;
  const inReview = state !== "not_in_review";

  return (
    <div className="noteCardDetail">
      <div className="noteCardDetailQuestion">
        {editing ? (
          <div className="noteReviewSettingsEdit">
            <label className="noteReviewQuestionField">
              <span className="noteReviewQuestionLabel">Question</span>
              <input
                aria-label="Question"
                className="noteReviewQuestionInput min-h-11"
                onChange={(event) => setDraft(event.target.value)}
                type="text"
                value={draft}
              />
            </label>
            <div className="noteReviewConfirmActions">
              <Button
                disabled={draft.trim().length === 0}
                onClick={saveQuestion}
                pending={busy}
                type="button"
              >
                Save
              </Button>
              <Button
                disabled={busy}
                onClick={() => {
                  setEditing(false);
                  setDraft(prompt.questionText);
                }}
                type="button"
                variant="secondary"
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <>
            <p className="noteReviewSettingsQuestionText">{prompt.questionText}</p>
            <Button
              className="min-h-11"
              onClick={() => {
                setDraft(prompt.questionText);
                setEditing(true);
              }}
              size="sm"
              type="button"
              variant="ghost"
            >
              Edit question
            </Button>
          </>
        )}
      </div>

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
            Add to review
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

      {failed ? (
        <p role="alert">
          That action could not be completed. The list was refreshed — please try again.
        </p>
      ) : null}
    </div>
  );
}
