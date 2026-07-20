import { ChevronRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { NotePromptSettingsDto } from "@whetstone/contracts";

import { Button } from "../../shared/ui/Button";
import { useLearnerTimeZone } from "../../shared/preferences/useLearnerTimeZone";
import { AddToReviewFlow } from "./AddToReviewFlow";
import { cardStateLabel, revealSummaryLabel } from "./cardState";
import { CardDetail } from "./CardDetail";
import { CardHistory } from "./CardHistory";
import { fetchNotePromptSettings } from "../notesReview/notesReviewApi";

type CardsViewProps = Readonly<{
  noteEntryId: string;
  onReviewChanged: () => void;
  // The anchored note's exact source snapshot for the no-prompt enrollment flow; `null` for a standalone
  // note, which is asked "What should Whetstone ask you?" instead.
  sourceSnapshot: string | null;
}>;

type CardsScreen =
  | Readonly<{ kind: "list" }>
  | Readonly<{ kind: "detail"; fromHistory: boolean; promptId: string }>
  | Readonly<{ kind: "history"; promptId: string }>;

// The Cards hierarchy for one saved note (#700): one compact stable-creation-order list of the note's
// existing review contracts, drilling into a focused detail and then a per-card history, all inside the
// shared Sheet. It renders N >= 0 rows without a singleton assumption and reuses the existing owner-scoped
// prompt/settings query and prompt-id mutations — no client copy becomes a source of truth. Back navigates
// History -> Detail -> List, restoring the originating row's focus. The optional toolbar slot hosts the
// existing "Add to review" flow only for an eligible no-prompt note. Cards never offers a rating action;
// Today and Notes Review own the routine.
export function CardsView({
  noteEntryId,
  onReviewChanged,
  sourceSnapshot
}: CardsViewProps): React.JSX.Element {
  const [phase, setPhase] = useState<"loading" | "error" | "ready">("loading");
  const [prompts, setPrompts] = useState<ReadonlyArray<NotePromptSettingsDto>>([]);
  const [screen, setScreen] = useState<CardsScreen>({ kind: "list" });
  const timeZone = useLearnerTimeZone();
  const rowRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map());
  // The row to refocus once the list re-renders after a Back from a detail, so keyboard focus returns to
  // exactly the card the learner drilled into rather than the top of the list.
  const pendingRowFocus = useRef<string | null>(null);

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

  useEffect(() => {
    if (screen.kind !== "list" || pendingRowFocus.current === null) {
      return;
    }
    const target = pendingRowFocus.current;
    pendingRowFocus.current = null;
    rowRefs.current.get(target)?.focus();
  }, [screen, prompts]);

  // Replace exactly the mutated row with the server's refreshed projection, then notify the parent so the
  // note's rolled-up Review summary (its Notes-home row, the workspace) stays in sync.
  const applyRefreshed = useCallback(
    (refreshed: NotePromptSettingsDto): void => {
      setPrompts((current) =>
        current.map((prompt) => (prompt.promptId === refreshed.promptId ? refreshed : prompt))
      );
      onReviewChanged();
    },
    [onReviewChanged]
  );

  const reloadAfterMutation = useCallback((): void => {
    loadList();
    onReviewChanged();
  }, [loadList, onReviewChanged]);

  function backToList(promptId: string): void {
    pendingRowFocus.current = promptId;
    setScreen({ kind: "list" });
  }

  if (phase === "loading") {
    return <p>Loading cards…</p>;
  }
  if (phase === "error") {
    return (
      <div>
        <p role="alert">Could not load the cards.</p>
        <Button
          onClick={() => {
            setPhase("loading");
            loadList();
          }}
          type="button"
          variant="secondary"
        >
          Retry
        </Button>
      </div>
    );
  }

  if (screen.kind === "history") {
    return (
      <div className="noteCardsHistory">
        <Button
          onClick={() => setScreen({ kind: "detail", fromHistory: true, promptId: screen.promptId })}
          size="sm"
          type="button"
          variant="ghost"
        >
          Back to card
        </Button>
        <h3 className="noteCardsHistoryHeading">Review history</h3>
        <CardHistory promptId={screen.promptId} />
      </div>
    );
  }

  if (screen.kind === "detail") {
    const prompt = prompts.find((entry) => entry.promptId === screen.promptId);
    // A card that vanished from the list (e.g. a background reload) can no longer be detailed; fall back to
    // the list rather than render a stale card.
    if (prompt === undefined) {
      return renderList();
    }
    return (
      <div className="noteCardDetailScreen">
        <Button
          onClick={() => backToList(prompt.promptId)}
          size="sm"
          type="button"
          variant="ghost"
        >
          Back to cards
        </Button>
        <CardDetail
          focusHistoryButton={screen.fromHistory}
          onOpenHistory={() => setScreen({ kind: "history", promptId: prompt.promptId })}
          onRefreshed={applyRefreshed}
          onReload={reloadAfterMutation}
          prompt={prompt}
          timeZone={timeZone}
        />
      </div>
    );
  }

  return renderList();

  function renderList(): React.JSX.Element {
    return (
      <div className="noteCardsList">
        <div className="noteCardsToolbar">
          {prompts.length === 0 ? (
            <AddToReviewFlow
              noteEntryId={noteEntryId}
              onEnrolled={reloadAfterMutation}
              sourceSnapshot={sourceSnapshot}
            />
          ) : null}
        </div>
        {prompts.length === 0 ? (
          <p className="noteCardsEmpty">This note has no review cards yet.</p>
        ) : (
          <ul className="noteCardsRows">
            {prompts.map((prompt) => (
              <li key={prompt.promptId}>
                <button
                  className="noteCardsRow min-h-11"
                  onClick={() => setScreen({ kind: "detail", fromHistory: false, promptId: prompt.promptId })}
                  ref={(node) => {
                    rowRefs.current.set(prompt.promptId, node);
                  }}
                  type="button"
                >
                  <span className="noteCardsRowBody">
                    <span className="noteCardsRowQuestion">{prompt.questionText}</span>
                    <span className="noteCardsRowMeta">
                      <span className="noteCardsRowReveal">{revealSummaryLabel(prompt.reveal)}</span>
                      <span className="noteCardsRowState">
                        {cardStateLabel(prompt.cardState, new Date(), timeZone)}
                      </span>
                    </span>
                  </span>
                  <ChevronRight aria-hidden className="noteCardsRowChevron" size={18} strokeWidth={1.75} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
}
