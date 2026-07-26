import { useEffect, useId, useRef, useState } from "react";

import type {
  LexicalPartOfSpeechDto,
  RelatedMaterialGroupDto,
  RelatedMaterialNoteDto,
  RelatedMaterialRelationsResponse,
  RelatedMaterialSenseDto,
  RelatedMaterialSenseRef,
  RelatedMaterialSensesResponse
} from "@whetstone/contracts";
import type { DocumentNodeJSON } from "@whetstone/document";

import { partOfSpeechLabel, relationReasonLabel } from "./relatedMaterial.tokens";
import { fetchRelatedRelations, fetchRelatedSenses } from "./relatedMaterialApi";
import { Button, buttonVariants } from "../../shared/ui/Button";

type RelatedMaterialDisclosureProps = Readonly<{
  // The current Answer draft. The disclosure sends the whole document; the server reprojects its surface and
  // eligibility, so the client never asserts either. The composer only mounts this for an eligible single-word
  // Answer, and re-keys it by that surface so a changed Answer resets the disclosure and any selection.
  answerDoc: DocumentNodeJSON;
}>;

// One related saved Note row: its saved word, its capture context (when anchored), and Open note. Open note is
// a plain link that opens the note in a NEW tab, so inspecting a related note never replaces or loses the card
// draft. It offers nothing else — no Use existing material, no preselected card, no save or schedule change.
function RelatedNoteRow({ note }: Readonly<{ note: RelatedMaterialNoteDto }>): React.JSX.Element {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded border border-border bg-surface p-3">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="font-medium break-words text-text">{note.word}</span>
        {note.context === null ? null : (
          <span className="break-words text-sm text-text-muted">{note.context}</span>
        )}
      </div>
      <a
        aria-label={`Open note: ${note.word}`}
        className={buttonVariants({ size: "sm", variant: "ghost" })}
        href={`#/notes?open=${encodeURIComponent(note.noteId)}`}
        rel="noopener noreferrer"
        target="_blank"
      >
        Open note
      </a>
    </li>
  );
}

// One typed relation group: its plain reason (labelled with the selected part of speech for an inflection —
// "same verb lemma") and the owned notes the service already capped and ordered. The learner inspects; nothing
// is decided, preselected, or reversed.
function RelationGroup({
  group,
  partOfSpeech
}: Readonly<{
  group: RelatedMaterialGroupDto;
  partOfSpeech: LexicalPartOfSpeechDto;
}>): React.JSX.Element {
  const reason = relationReasonLabel(group.relation, partOfSpeech);
  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-sm font-semibold text-text">{reason}</h4>
      <ul aria-label={reason} className="flex flex-col gap-2">
        {group.notes.map((note) => (
          <RelatedNoteRow key={note.noteId} note={note} />
        ))}
      </ul>
    </div>
  );
}

// The related saved Notes under the selected sense. `found` renders the "born -> bear . verb" header and the
// typed groups (possibly empty — a silent no-result); `unavailable` offers Retry and never blocks the save;
// `not_found`/`unsupported` stay quiet. Loading is announced.
function RelationsView({
  loading,
  onRetry,
  relations
}: Readonly<{
  loading: boolean;
  onRetry: () => void;
  relations: RelatedMaterialRelationsResponse | null;
}>): React.JSX.Element | null {
  if (loading) {
    return (
      <p className="text-sm text-text-muted" role="status">
        Finding related saved notes…
      </p>
    );
  }
  if (relations === null) {
    return null;
  }
  if (relations.status === "unavailable") {
    return (
      <p className="text-sm text-text-muted" role="status">
        Whetstone could not load related saved notes.{" "}
        <Button className="min-h-11" onClick={onRetry} size="sm" type="button" variant="ghost">
          Retry
        </Button>
      </p>
    );
  }
  if (relations.status !== "found") {
    return (
      <p className="text-sm text-text-muted" role="status">
        No related saved notes for this sense.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-text-muted" role="status">
        {relations.surface} → {relations.selectedLemma} ·{" "}
        {partOfSpeechLabel(relations.partOfSpeech)}
      </p>
      {relations.groups.length === 0 ? (
        <p className="text-sm text-text-muted">No related saved notes for this sense.</p>
      ) : (
        <div className="flex flex-col gap-4">
          {relations.groups.map((group) => (
            <RelationGroup
              group={group}
              key={`${group.relation}:${group.direction}`}
              partOfSpeech={relations.partOfSpeech}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// One sense offered for EXPLICIT selection (#715 never auto-picks): its lemma(s), part of speech, definition,
// and examples when present. Rendered as a radio so no sense is preselected and the group has a single
// selection with native keyboard support.
function SenseChoice({
  groupName,
  onSelect,
  selected,
  sense
}: Readonly<{
  groupName: string;
  onSelect: () => void;
  selected: boolean;
  sense: RelatedMaterialSenseDto;
}>): React.JSX.Element {
  return (
    <label className="flex min-h-11 cursor-pointer gap-3 rounded border border-border bg-surface p-3">
      <input
        checked={selected}
        className="mt-1"
        name={groupName}
        onChange={onSelect}
        type="radio"
      />
      <span className="flex min-w-0 flex-col gap-1">
        <span className="break-words text-text">
          <span className="font-medium">{sense.lemmas.join(", ")}</span> · {sense.partOfSpeech}
        </span>
        <span className="break-words text-sm text-text-muted">{sense.definition}</span>
        {sense.examples.length > 0 ? (
          <ul className="flex flex-col gap-1 text-sm text-text-muted italic">
            {sense.examples.map((example, index) => (
              <li className="break-words" key={`${example}#${index}`}>
                “{example}”
              </li>
            ))}
          </ul>
        ) : null}
      </span>
    </label>
  );
}

// The senses step. `found` lists every sense for explicit selection and renders the relations for the selected
// one beneath; `unavailable` offers Retry; `not_found`/`unsupported` stay quiet. Loading is announced.
function SensesView({
  answerDoc,
  groupName,
  loading,
  onRetry,
  senses
}: Readonly<{
  answerDoc: DocumentNodeJSON;
  groupName: string;
  loading: boolean;
  onRetry: () => void;
  senses: RelatedMaterialSensesResponse | null;
}>): React.JSX.Element | null {
  const [selectedSense, setSelectedSense] = useState<RelatedMaterialSenseRef | null>(null);
  const [relations, setRelations] = useState<RelatedMaterialRelationsResponse | null>(null);
  const [relationsLoading, setRelationsLoading] = useState(false);
  const relationsSeq = useRef(0);
  const answerDocRef = useRef(answerDoc);
  answerDocRef.current = answerDoc;

  useEffect(() => {
    // Fetch relations once a sense is explicitly selected and no result is held yet. Selecting a different
    // sense (or Retry) clears `relations` to re-enter this. The cleanup bumps the sequence so a response that
    // arrives after the sense changed — or after unmount — is ignored (stale/cancelled safety).
    if (selectedSense === null || relations !== null) {
      return;
    }
    const seq = (relationsSeq.current += 1);
    setRelationsLoading(true);
    void fetchRelatedRelations(answerDocRef.current, selectedSense).then((result) => {
      if (seq === relationsSeq.current) {
        setRelationsLoading(false);
        setRelations(result);
      }
    });
    return () => {
      relationsSeq.current += 1;
    };
  }, [relations, selectedSense]);

  function selectSense(sense: RelatedMaterialSenseDto): void {
    setSelectedSense({ offset: sense.offset, partOfSpeech: sense.partOfSpeech });
    setRelations(null);
    setRelationsLoading(false);
  }

  if (loading) {
    return (
      <p className="text-sm text-text-muted" role="status">
        Finding senses…
      </p>
    );
  }
  if (senses === null) {
    return null;
  }
  if (senses.status === "unavailable") {
    return (
      <p className="text-sm text-text-muted" role="status">
        Whetstone could not load related material.{" "}
        <Button className="min-h-11" onClick={onRetry} size="sm" type="button" variant="ghost">
          Retry
        </Button>
      </p>
    );
  }
  if (senses.status !== "found") {
    return (
      <p className="text-sm text-text-muted" role="status">
        No related material for this word.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm text-text-muted">
          Choose the sense you mean to inspect related saved notes.
        </legend>
        {senses.senses.map((sense) => {
          const senseSelected =
            selectedSense !== null &&
            selectedSense.offset === sense.offset &&
            selectedSense.partOfSpeech === sense.partOfSpeech;
          return (
            <SenseChoice
              groupName={groupName}
              key={`${sense.partOfSpeech}:${sense.offset}`}
              onSelect={() => selectSense(sense)}
              selected={senseSelected}
              sense={sense}
            />
          );
        })}
      </fieldset>
      <RelationsView
        loading={relationsLoading}
        onRetry={() => setRelations(null)}
        relations={relations}
      />
    </div>
  );
}

// The "Find related material" disclosure shown during New-card creation for an eligible single-word Answer
// (#716). Related material is an explicit INSPECTION AID over the offline lexical service (#715): it never
// warns about saving, decides identity, preselects a card, enters Possible duplicate, or alters the save.
//
// Collapsed by default, it performs NO request until opened; opening triggers sense discovery. The learner
// explicitly chooses a sense (never preselected), then inspects the typed related saved Notes. Every failure
// is a retryable state that never blocks the save; unsupported/no-result stay quiet; stale responses after a
// sense change (or an Answer change, which remounts this) are ignored. The composer owns eligibility and
// re-keys this by the projected surface, so a changed Answer resets the disclosure and selection.
export function RelatedMaterialDisclosure({
  answerDoc
}: RelatedMaterialDisclosureProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [senses, setSenses] = useState<RelatedMaterialSensesResponse | null>(null);
  const [sensesLoading, setSensesLoading] = useState(false);
  const sensesSeq = useRef(0);
  const answerDocRef = useRef(answerDoc);
  answerDocRef.current = answerDoc;
  const panelId = useId();
  const groupName = useId();

  useEffect(() => {
    // Discover senses the first time the disclosure is open with no result held (Retry clears `senses` to
    // re-enter this). A closed disclosure never requests. The cleanup bumps the sequence so a response that
    // arrives after close/unmount is ignored.
    if (!open || senses !== null) {
      return;
    }
    const seq = (sensesSeq.current += 1);
    setSensesLoading(true);
    void fetchRelatedSenses(answerDocRef.current).then((result) => {
      if (seq === sensesSeq.current) {
        setSensesLoading(false);
        setSenses(result);
      }
    });
    return () => {
      sensesSeq.current += 1;
    };
  }, [open, senses]);

  return (
    <section className="flex flex-col gap-3 rounded border border-border bg-bg p-3">
      <Button
        aria-controls={panelId}
        aria-expanded={open}
        className="min-h-11 self-start"
        onClick={() => setOpen((value) => !value)}
        size="sm"
        type="button"
        variant="ghost"
      >
        Find related material
      </Button>
      {open ? (
        <div aria-label="Related material" className="flex flex-col gap-3" id={panelId} role="group">
          <SensesView
            answerDoc={answerDoc}
            groupName={groupName}
            loading={sensesLoading}
            onRetry={() => setSenses(null)}
            senses={senses}
          />
        </div>
      ) : null}
    </section>
  );
}
