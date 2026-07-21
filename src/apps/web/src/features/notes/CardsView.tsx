import { ChevronRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { NotePromptSettingsDto } from "@whetstone/contracts";
import { type DocumentNodeJSON } from "@whetstone/document";

import { Button } from "../../shared/ui/Button";
import { useLearnerTimeZone } from "../../shared/preferences/useLearnerTimeZone";
import { SavedNoteCardComposer } from "./SavedNoteCardComposer";
import { cardStateLabel, revealSummaryLabel } from "./cardState";
import { CardDetail } from "./CardDetail";
import { CardHistory } from "./CardHistory";
import { fetchNotePromptSettings } from "../notesReview/notesReviewApi";

type CardsViewProps = Readonly<{
  noteEntryId: string;
  onReviewChanged: () => void;
  // The live canonical note body, framed as the read-only Answer/Reference a first card grades against, and
  // shown read-only while editing an existing card's grading target. `null` when the note carries no
  // reflowable body (a Mark) — such a note never offers Add card.
  noteBodyDoc: DocumentNodeJSON | null;
  // An anchored Reader note's exact selected source, shown verbatim as Reference context in the Add-card
  // composer; `null` for a standalone note. The selection never silently chooses the Question or card type.
  sourceSnapshot: string | null;
}>;

type CardsScreen =
  | Readonly<{ kind: "list" }>
  | Readonly<{ kind: "compose" }>
  | Readonly<{ kind: "detail"; fromHistory: boolean; promptId: string }>
  | Readonly<{ kind: "history"; promptId: string }>;

// The Cards hierarchy for one saved note (#700, first-card authoring in #687): one compact
// stable-creation-order list of the note's existing review contracts, drilling into a focused detail and
// then a per-card history, all inside the shared Sheet. It renders N >= 0 rows without a singleton
// assumption and reuses the existing owner-scoped prompt/settings query and prompt-id mutations — no client
// copy becomes a source of truth. Back navigates History -> Detail -> List, restoring the originating row's
// focus. When the note has no authored prompt and carries a body, the toolbar offers Add card, which opens
// the inline rich composer to author the note's first card in place. Cards never offers a rating action;
// Today and Notes Review own the routine.
export function CardsView({
  noteEntryId,
  onReviewChanged,
  noteBodyDoc,
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
          onClick={() =>
            setScreen({ kind: "detail", fromHistory: true, promptId: screen.promptId })
          }
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
        <Button onClick={() => backToList(prompt.promptId)} size="sm" type="button" variant="ghost">
          Back to cards
        </Button>
        <CardDetail
          focusHistoryButton={screen.fromHistory}
          noteBodyDoc={noteBodyDoc}
          onOpenHistory={() => setScreen({ kind: "history", promptId: prompt.promptId })}
          onRefreshed={applyRefreshed}
          onReload={reloadAfterMutation}
          prompt={prompt}
          timeZone={timeZone}
        />
      </div>
    );
  }

  if (screen.kind === "compose" && noteBodyDoc !== null) {
    return (
      <div className="noteCardsCompose">
        <Button onClick={() => setScreen({ kind: "list" })} size="sm" type="button" variant="ghost">
          Back to cards
        </Button>
        <SavedNoteCardComposer
          noteBodyDoc={noteBodyDoc}
          noteEntryId={noteEntryId}
          onCancel={() => setScreen({ kind: "list" })}
          onCreated={() => {
            reloadAfterMutation();
            setScreen({ kind: "list" });
          }}
          sourceSnapshot={sourceSnapshot}
        />
      </div>
    );
  }

  return renderList();

  function renderList(): React.JSX.Element {
    // Add card opens the first-card composer, so it is offered only when the note has no AUTHORED prompt
    // (a `current_note` or `expected_response` reveal) — never gated on total prompt count. A note may
    // carry read-only `legacy_custom` prompts while still owning no authored first card (#657/#687's
    // migration excludes `legacy_custom` from the one-authored-prompt-per-note invariant), so such a note
    // still shows its legacy row(s) AND offers Add card.
    const hasAuthoredPrompt = prompts.some(
      (prompt) =>
        prompt.reveal.kind === "current_note" || prompt.reveal.kind === "expected_response"
    );
    return (
      <div className="noteCardsList">
        <div className="noteCardsToolbar">
          {!hasAuthoredPrompt && noteBodyDoc !== null ? (
            <Button onClick={() => setScreen({ kind: "compose" })} type="button">
              Add card
            </Button>
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
                  onClick={() =>
                    setScreen({ kind: "detail", fromHistory: false, promptId: prompt.promptId })
                  }
                  ref={(node) => {
                    rowRefs.current.set(prompt.promptId, node);
                  }}
                  type="button"
                >
                  <span className="noteCardsRowBody">
                    <span className="noteCardsRowQuestion">{prompt.questionText}</span>
                    <span className="noteCardsRowMeta">
                      <span className="noteCardsRowReveal">
                        {revealSummaryLabel(prompt.reveal)}
                      </span>
                      <span className="noteCardsRowState">
                        {cardStateLabel(prompt.cardState, new Date(), timeZone)}
                      </span>
                    </span>
                  </span>
                  <ChevronRight
                    aria-hidden
                    className="noteCardsRowChevron"
                    size={18}
                    strokeWidth={1.75}
                  />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
}
