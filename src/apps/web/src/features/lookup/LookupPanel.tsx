import type { NormalizedEntry, NormalizedSense } from "@whetstone/contracts";

import { Sheet } from "../../shared/ui/Sheet";

// The view-only lookup state the reader drives: fetching, a failure, a no-match, or a
// resolved entry. There are deliberately no note controls here — lookup never creates,
// pre-fills, or edits a note.
export type LookupState =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "error" }>
  | Readonly<{ status: "empty" }>
  | Readonly<{ attribution?: string | undefined; entry: NormalizedEntry; status: "loaded" }>;

export type LookupPanelProps = Readonly<{
  onOpenChange: (open: boolean) => void;
  open: boolean;
  state: LookupState;
  term: string;
}>;

function renderSense(sense: NormalizedSense, index: number): React.JSX.Element {
  return (
    <li className="lookupSense" key={index}>
      {sense.partOfSpeech === undefined ? null : (
        <span className="lookupPartOfSpeech">{sense.partOfSpeech}</span>
      )}
      <span className="lookupGloss">{sense.gloss}</span>
      {sense.example === undefined ? null : (
        <span className="lookupExample">“{sense.example}”</span>
      )}
    </li>
  );
}

function renderEntry(entry: NormalizedEntry, attribution: string | undefined): React.JSX.Element {
  return (
    <div className="lookupEntry">
      <p className="lookupHeadword">{entry.headword}</p>
      {entry.pronunciation === undefined ? null : (
        <p className="lookupPronunciation">{entry.pronunciation}</p>
      )}
      <ol className="lookupSenses">{entry.senses.map(renderSense)}</ol>
      {attribution === undefined ? null : <p className="lookupAttribution">{attribution}</p>}
    </div>
  );
}

function renderState(state: LookupState): React.JSX.Element {
  switch (state.status) {
    case "loading":
      return <p role="status">Looking up…</p>;
    case "error":
      return <p role="alert">Could not look up this word. Please try again.</p>;
    case "empty":
      return <p>No definition found.</p>;
    case "loaded":
      return renderEntry(state.entry, state.attribution);
  }
}

// A view-only definition surface hosted in the shared responsive Sheet (right panel on
// desktop, bottom sheet on mobile). It renders the headword, pronunciation, senses, and
// required attribution, with explicit loading / empty / error states.
export function LookupPanel({
  onOpenChange,
  open,
  state,
  term
}: LookupPanelProps): React.JSX.Element {
  return (
    <Sheet onOpenChange={onOpenChange} open={open} title={`Look up: ${term}`}>
      <div className="lookupPanel">{renderState(state)}</div>
    </Sheet>
  );
}
