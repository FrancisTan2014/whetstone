import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import type {
  NotePromptSettingsDto,
  ReviewHistoryEventDto,
  ReviewHistoryPageDto
} from "@whetstone/contracts";

import { Button, buttonVariants } from "../../shared/ui/Button";
import {
  addNotePromptCardBack,
  editNotePromptQuestion,
  fetchNotePromptHistory,
  fetchNotePromptSettings,
  pauseNotePromptCard,
  removeNotePromptCard,
  restartNotePromptCard,
  resumeNotePromptCard
} from "../notesReview/notesReviewApi";

type NoteReviewSettingsProps = Readonly<{
  noteEntryId: string;
  onChanged: () => void;
}>;

// Localize a card's next due instant as a calm date, matching the Review session's format.
function formatNextReview(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    day: "numeric",
    month: "long",
    year: "numeric"
  });
}

// The objective state label a settings row shows, derived from the projected card state (never persisted).
function cardStateLabel(cardState: NotePromptSettingsDto["cardState"]): string {
  switch (cardState.state) {
    case "due":
      return "Due now";
    case "scheduled":
      return `Next review · ${formatNextReview(cardState.nextReviewAt)}`;
    case "paused":
      return "Paused";
    case "not_in_review":
      return "Not in review";
  }
}

// The Review-settings expansion for one owned note (#660): every prompt in creation order with its reveal
// policy, projected state, and state-driven controls (review/pause/resume/restart/remove/re-add), plus each
// prompt's append-only history. It expands in place — no nested modal. A settings change refreshes only the
// affected row (from the server's refreshed row) and notifies the parent so the compact summary and the
// Notes-home row stay in sync; a stale action reloads the list rather than faking success.
export function NoteReviewSettings({
  noteEntryId,
  onChanged
}: NoteReviewSettingsProps): React.JSX.Element {
  const [phase, setPhase] = useState<"loading" | "error" | "ready">("loading");
  const [prompts, setPrompts] = useState<ReadonlyArray<NotePromptSettingsDto>>([]);

  const loadList = useCallback((): void => {
    fetchNotePromptSettings(noteEntryId).then(
      (list) => {
        setPrompts(list.prompts);
        setPhase("ready");
      },
      () => setPhase("error")
    );
  }, [noteEntryId]);

  useEffect(() => {
    loadList();
  }, [loadList]);

  // Replace exactly the mutated row with the server's refreshed projection, then notify the parent.
  const applyRefreshed = useCallback(
    (refreshed: NotePromptSettingsDto): void => {
      setPrompts((current) =>
        current.map((prompt) => (prompt.promptId === refreshed.promptId ? refreshed : prompt))
      );
      onChanged();
    },
    [onChanged]
  );

  function retry(): void {
    setPhase("loading");
    loadList();
  }

  if (phase === "loading") {
    return <p>Loading review settings…</p>;
  }
  if (phase === "error") {
    return (
      <div>
        <p role="alert">Could not load the review settings.</p>
        <Button onClick={retry} type="button" variant="secondary">
          Retry
        </Button>
      </div>
    );
  }
  if (prompts.length === 0) {
    return <p>This note has no review prompts yet.</p>;
  }
  return (
    <ul className="noteReviewSettingsList">
      {prompts.map((prompt) => (
        <PromptSettingsRow
          key={prompt.promptId}
          onReload={loadList}
          onRefreshed={applyRefreshed}
          prompt={prompt}
        />
      ))}
    </ul>
  );
}

type PromptSettingsRowProps = Readonly<{
  onReload: () => void;
  onRefreshed: (refreshed: NotePromptSettingsDto) => void;
  prompt: NotePromptSettingsDto;
}>;

// One prompt row. It owns its transient UI (editing the question, an inline restart/remove confirmation,
// an expanded history) and never double-submits (every action button reports `pending`). A successful
// action hands the refreshed row up; a failed one reloads the whole list and surfaces a retryable error.
function PromptSettingsRow({
  onReload,
  onRefreshed,
  prompt
}: PromptSettingsRowProps): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(prompt.questionText);
  const [confirming, setConfirming] = useState<"restart" | "remove" | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const restartRef = useRef<HTMLButtonElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  // Which control to focus after a successful confirmation commits. A synchronous focus inside the
  // resolve callback would target a still-`busy` (disabled) button and be dropped; deferring to a
  // post-commit effect focuses the control once it is enabled (or, after a removal, the new Add button).
  const pendingFocus = useRef<"restart" | "add" | null>(null);

  useEffect(() => {
    const target = pendingFocus.current;
    if (target === null) {
      return;
    }
    pendingFocus.current = null;
    (target === "restart" ? restartRef.current : addRef.current)?.focus();
  });

  // Run one settings mutation with a shared in-flight guard: on success the refreshed row flows up; on
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
    const question = draft.trim();
    run(() => editNotePromptQuestion(prompt.promptId, question), () => setEditing(false));
  }

  function confirmRestart(): void {
    run(() => restartNotePromptCard(prompt.promptId), () => {
      setConfirming(null);
      pendingFocus.current = "restart";
    });
  }

  function confirmRemove(): void {
    run(() => removeNotePromptCard(prompt.promptId), () => {
      setConfirming(null);
      pendingFocus.current = "add";
    });
  }

  const state = prompt.cardState.state;
  return (
    <li className="noteReviewSettingsRow">
      <div className="noteReviewSettingsQuestion">
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
          : "Custom answer (read-only)"}
      </p>
      {prompt.reveal.kind === "legacy_custom" ? (
        <p className="noteReviewSettingsLegacyAnswer">{prompt.reveal.answerText}</p>
      ) : null}

      <p className="noteReviewSettingsState">{cardStateLabel(prompt.cardState)}</p>

      <div className="noteReviewSettingsActions">
        {state === "due" ? (
          <Link className={buttonVariants({ variant: "secondary" })} to="/notes/review">
            Review
          </Link>
        ) : null}
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
        {state !== "not_in_review" ? (
          <>
            <Button
              disabled={busy}
              onClick={() => setConfirming("restart")}
              ref={restartRef}
              type="button"
              variant="ghost"
            >
              Restart
            </Button>
            <Button
              disabled={busy}
              onClick={() => setConfirming("remove")}
              ref={removeRef}
              type="button"
              variant="ghost"
            >
              Remove
            </Button>
          </>
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
                restartRef.current?.focus();
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
                removeRef.current?.focus();
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
        <p role="alert">That action could not be completed. The list was refreshed — please try again.</p>
      ) : null}

      <div className="noteReviewSettingsHistory">
        <Button
          aria-expanded={historyOpen}
          onClick={() => setHistoryOpen((open) => !open)}
          size="sm"
          type="button"
          variant="ghost"
        >
          {historyOpen ? "Hide review history" : "Review history"}
        </Button>
        {historyOpen ? <PromptHistory promptId={prompt.promptId} /> : null}
      </div>
    </li>
  );
}

type PromptHistoryProps = Readonly<{ promptId: string }>;

// A prompt's append-only Review history (#660), paged newest-first with "Load older". It reads only real
// card events — ratings (Again/Hard/Good/Easy) and resets (Schedule restarted) — never a fabricated entry.
function PromptHistory({ promptId }: PromptHistoryProps): React.JSX.Element {
  const [events, setEvents] = useState<ReadonlyArray<ReviewHistoryEventDto>>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [step, setStep] = useState<"loading" | "error" | "ready">("loading");
  const [loadingMore, setLoadingMore] = useState(false);

  const apply = useCallback((page: ReviewHistoryPageDto): void => {
    setEvents((current) => [...current, ...page.events]);
    setCursor(page.nextCursor);
    setStep("ready");
  }, []);

  const loadFirst = useCallback((): void => {
    fetchNotePromptHistory(promptId).then(apply, () => setStep("error"));
  }, [apply, promptId]);

  useEffect(() => {
    loadFirst();
  }, [loadFirst]);

  function loadOlder(olderCursor: string): void {
    setLoadingMore(true);
    fetchNotePromptHistory(promptId, olderCursor).then(
      (page) => {
        setLoadingMore(false);
        apply(page);
      },
      () => {
        setLoadingMore(false);
        setStep("error");
      }
    );
  }

  function retry(): void {
    setStep("loading");
    loadFirst();
  }

  if (step === "loading") {
    return <p>Loading history…</p>;
  }
  if (step === "error") {
    return (
      <div>
        <p role="alert">Could not load the review history.</p>
        <Button onClick={retry} size="sm" type="button" variant="secondary">
          Retry
        </Button>
      </div>
    );
  }
  if (events.length === 0) {
    return <p>No review history yet.</p>;
  }
  return (
    <div>
      <ul className="noteReviewHistoryList">
        {events.map((event) => (
          <li key={event.id} className="noteReviewHistoryItem">
            <span className="noteReviewHistoryLabel">{historyLabel(event)}</span>
            <time dateTime={event.occurredAt}>{formatOccurredAt(event.occurredAt)}</time>
          </li>
        ))}
      </ul>
      {cursor !== null ? (
        <Button onClick={() => loadOlder(cursor)} pending={loadingMore} size="sm" type="button" variant="ghost">
          Load older
        </Button>
      ) : null}
    </div>
  );
}

// The four-button rating localized for the history line, or the reset label. History carries no other kind.
function historyLabel(event: ReviewHistoryEventDto): string {
  if (event.kind === "reset") {
    return "Schedule restarted";
  }
  switch (event.rating) {
    case "again":
      return "Rated Again";
    case "hard":
      return "Rated Hard";
    case "good":
      return "Rated Good";
    case "easy":
      return "Rated Easy";
  }
}

function formatOccurredAt(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "long",
    year: "numeric"
  });
}
