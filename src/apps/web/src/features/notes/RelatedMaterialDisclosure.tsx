import { useRef, useState } from "react";

import type {
  CreateDirectCardRequest,
  RelatedMaterialGroupDto,
  RelatedMaterialRelationsResponse,
  RelatedMaterialSenseDto,
  RelatedMaterialSenseRef,
  RelatedMaterialSensesResponse
} from "@whetstone/contracts";

import { fetchRelatedRelations, fetchRelatedSenses } from "./relatedMaterialApi";
import { relationLabel } from "./relatedMaterial.tokens";
import { Button, buttonVariants } from "../../shared/ui/Button";

type RelatedMaterialDisclosureProps = Readonly<{
  answerDoc: CreateDirectCardRequest["answerDoc"];
}>;

// The New-card "Find related material" disclosure (#716): a collapsed, opt-in inspection aid over the offline
// lexical service (#715). The parent renders it only for an eligible single-word Answer and keys it by that
// surface, so it remounts (and resets) when the word changes. It NEVER fetches until the learner opens it —
// so ordinary multi-word drafts make no request — and it is purely for inspection: it can never block the
// save, preselect a card, offer "Use existing material", or persist a relation or sense (v1). The learner
// opens it, picks one WordNet sense explicitly (the service never auto-picks), and reads the owner's typed
// related saved Notes; each note offers only "Open note" (in a new tab, so the untouched draft stays mounted).
// A genuine database failure surfaces `unavailable` with Retry — never silence — while an out-of-vocabulary
// word or an empty relation set is a quiet "nothing to show", never an error.
export function RelatedMaterialDisclosure({
  answerDoc
}: RelatedMaterialDisclosureProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [senses, setSenses] = useState<RelatedMaterialSensesResponse | null>(null);
  const [sensesLoading, setSensesLoading] = useState(false);
  const [selectedSense, setSelectedSense] = useState<RelatedMaterialSenseRef | null>(null);
  const [relations, setRelations] = useState<RelatedMaterialRelationsResponse | null>(null);
  const [relationsLoading, setRelationsLoading] = useState(false);
  // Monotonic request ids so only the most recent in-flight response is applied; selecting a new sense (or a
  // Retry) bumps the counter, so any earlier response is stale and ignored (cancellation + out-of-order safety).
  const sensesSeq = useRef(0);
  const relationsSeq = useRef(0);

  function loadSenses(): void {
    const seq = (sensesSeq.current += 1);
    setSensesLoading(true);
    void fetchRelatedSenses(answerDoc).then((result) => {
      if (seq !== sensesSeq.current) {
        return;
      }
      setSenses(result);
      setSensesLoading(false);
    });
  }

  function toggle(): void {
    // Fetch senses lazily on the first open only, so a draft the learner never inspects costs no request.
    if (!open && senses === null && !sensesLoading) {
      loadSenses();
    }
    setOpen((value) => !value);
  }

  function selectSense(sense: RelatedMaterialSenseDto): void {
    const ref: RelatedMaterialSenseRef = {
      offset: sense.offset,
      partOfSpeech: sense.partOfSpeech
    };
    setSelectedSense(ref);
    loadRelations(ref);
  }

  function loadRelations(sense: RelatedMaterialSenseRef): void {
    const seq = (relationsSeq.current += 1);
    setRelations(null);
    setRelationsLoading(true);
    void fetchRelatedRelations(answerDoc, sense).then((result) => {
      if (seq !== relationsSeq.current) {
        return;
      }
      setRelations(result);
      setRelationsLoading(false);
    });
  }

  return (
    <section aria-label="Find related material" className="relatedMaterial">
      <Button
        aria-expanded={open}
        className="min-h-11"
        onClick={toggle}
        size="sm"
        type="button"
        variant="ghost"
      >
        {open ? "Hide related material" : "Find related material"}
      </Button>
      {open ? (
        <div className="relatedMaterialBody" role="status">
          {renderSenses()}
          {selectedSense !== null ? renderRelations() : null}
        </div>
      ) : null}
    </section>
  );

  function renderSenses(): React.JSX.Element {
    if (sensesLoading || senses === null) {
      return <p className="text-text-muted">Looking for related material…</p>;
    }
    if (senses.status === "unavailable") {
      return (
        <p className="text-text-muted">
          Whetstone could not look up related material just now.{" "}
          <Button onClick={loadSenses} type="button" variant="ghost">
            Retry
          </Button>
        </p>
      );
    }
    if (senses.status !== "found") {
      return <p className="text-text-muted">No related material for this word.</p>;
    }
    return (
      <div className="relatedMaterialSenses">
        <p className="text-text-muted">Choose a meaning to inspect related notes:</p>
        <ul className="relatedMaterialSenseList">
          {senses.senses.map((sense) => (
            <li className="relatedMaterialSense" key={`${sense.partOfSpeech}:${sense.offset}`}>
              <Button
                aria-pressed={
                  selectedSense !== null &&
                  selectedSense.offset === sense.offset &&
                  selectedSense.partOfSpeech === sense.partOfSpeech
                }
                className="relatedMaterialSenseButton"
                onClick={() => selectSense(sense)}
                size="sm"
                type="button"
                variant="secondary"
              >
                <span className="relatedMaterialSensePos">{sense.partOfSpeech}</span>{" "}
                <span className="relatedMaterialSenseGloss">{sense.definition}</span>
              </Button>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  function renderRelations(): React.JSX.Element {
    if (relationsLoading || relations === null) {
      return <p className="text-text-muted">Looking for related notes…</p>;
    }
    if (relations.status === "unavailable") {
      return (
        <p className="text-text-muted">
          Whetstone could not look up related notes just now.{" "}
          <Button
            onClick={() => {
              if (selectedSense !== null) {
                loadRelations(selectedSense);
              }
            }}
            type="button"
            variant="ghost"
          >
            Retry
          </Button>
        </p>
      );
    }
    if (relations.status !== "found") {
      return <p className="text-text-muted">No related notes for this meaning.</p>;
    }
    if (relations.groups.length === 0) {
      return <p className="text-text-muted">No related notes for this meaning.</p>;
    }
    const { surface, selectedLemma, partOfSpeech, groups } = relations;
    return (
      <div className="relatedMaterialRelations">
        <p className="relatedMaterialHeader">
          {surface} → {selectedLemma} · {partOfSpeech}
        </p>
        {groups.map((group) => renderGroup(group, partOfSpeech))}
      </div>
    );
  }

  function renderGroup(
    group: RelatedMaterialGroupDto,
    partOfSpeech: RelatedMaterialSenseRef["partOfSpeech"]
  ): React.JSX.Element {
    return (
      <div className="relatedMaterialGroup" key={`${group.relation}:${group.direction}`}>
        <p className="relatedMaterialGroupLabel">{relationLabel(group.relation, partOfSpeech)}</p>
        <ul className="relatedMaterialNoteList">
          {group.notes.map((note) => (
            <li className="relatedMaterialNote" key={note.noteId}>
              <span className="relatedMaterialNoteWord">{note.word}</span>
              {note.context !== null ? (
                <span className="relatedMaterialNoteContext">“{note.context}”</span>
              ) : null}
              <a
                className={buttonVariants({ size: "sm", variant: "ghost" })}
                href={`#/notes?open=${encodeURIComponent(note.noteId)}`}
                rel="noopener noreferrer"
                target="_blank"
              >
                Open note
              </a>
            </li>
          ))}
        </ul>
      </div>
    );
  }
}
