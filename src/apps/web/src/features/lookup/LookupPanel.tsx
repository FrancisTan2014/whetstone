import * as Popover from "@radix-ui/react-popover";

import type {
  DictionaryEntry,
  DictionaryPartOfSpeech,
  DictionarySense
} from "@whetstone/contracts";

import { Sheet } from "../../shared/ui/Sheet";
import { useMediaQuery } from "../../shared/ui/useMediaQuery";

// The view-only lookup state the reader drives: fetching, a failure, a no-match, or a
// resolved entry. There are deliberately no note controls here — lookup never creates,
// pre-fills, or edits a note.
export type LookupState =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "error" }>
  | Readonly<{ status: "empty" }>
  | Readonly<{ entry: DictionaryEntry; status: "loaded" }>;

export type LookupPanelProps = Readonly<{
  // The selection's viewport rect; the desktop popover anchors to it so the card sits near
  // the selection (and flips/offsets near viewport edges) without covering it.
  anchorRect?: DOMRect | undefined;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  state: LookupState;
  term: string;
}>;

function renderSense(sense: DictionarySense, index: number): React.JSX.Element {
  return (
    <li className="lookupSense" key={index}>
      <span className="lookupGloss">{sense.definition}</span>
      {sense.examples.map((example, exampleIndex) => (
        <span className="lookupExample" key={exampleIndex}>
          “{example}”
        </span>
      ))}
      {sense.synonyms.length === 0 ? null : (
        <span className="lookupSynonyms">Synonyms: {sense.synonyms.join(", ")}</span>
      )}
    </li>
  );
}

// One part-of-speech group: the label once (when present), then its senses as separated blocks.
function renderPartOfSpeech(part: DictionaryPartOfSpeech, index: number): React.JSX.Element {
  return (
    <div className="lookupGroup" key={index}>
      {part.partOfSpeech === undefined ? null : (
        <p className="lookupPartOfSpeech">{part.partOfSpeech}</p>
      )}
      <ol className="lookupSenses">{part.senses.map(renderSense)}</ol>
    </div>
  );
}

function renderEntry(entry: DictionaryEntry): React.JSX.Element {
  return (
    <div className="lookupEntry">
      <p className="lookupHeadword">{entry.headword}</p>
      {entry.pronunciations.length === 0 ? null : (
        <p className="lookupPronunciation">
          {entry.pronunciations.map((pronunciation) => pronunciation.ipa).join(", ")}
        </p>
      )}
      <div className="lookupGroups">{entry.partsOfSpeech.map(renderPartOfSpeech)}</div>
      {entry.etymology === undefined ? null : <p className="lookupEtymology">{entry.etymology}</p>}
      {entry.sources.length === 0 ? null : (
        <p className="lookupAttribution">{entry.sources.join(" · ")}</p>
      )}
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
      return renderEntry(state.entry);
  }
}

// Position an invisible Radix anchor over the selection's rect so the popover opens beside
// it. Without a rect (e.g. the selection could not be measured), fall back to the viewport
// center so the card still appears rather than anchoring to nothing.
function anchorStyle(rect: DOMRect | undefined): React.CSSProperties {
  if (rect === undefined) {
    return { left: "50%", position: "fixed", top: "50%" };
  }

  return {
    height: rect.height,
    left: rect.left,
    position: "fixed",
    top: rect.top,
    width: rect.width
  };
}

// Desktop/tablet: a compact card anchored near the selection. Radix supplies the dismissal
// (outside-click, Esc, the explicit close), the dialog role/labelling, and the
// collision-aware flip/offset so the card never covers the selected text.
function LookupPopover({
  anchorRect,
  onOpenChange,
  open,
  state,
  term
}: LookupPanelProps): React.JSX.Element {
  return (
    <Popover.Root onOpenChange={onOpenChange} open={open}>
      <Popover.Anchor aria-hidden className="lookupAnchor" style={anchorStyle(anchorRect)} />
      <Popover.Portal>
        <Popover.Content
          align="start"
          aria-label={`Look up: ${term}`}
          className="lookupPopover"
          collisionPadding={12}
          side="bottom"
          sideOffset={8}
        >
          <div className="lookupPopoverChrome">
            <Popover.Close aria-label="Close" className="lookupClose">
              ✕
            </Popover.Close>
          </div>
          <div className="lookupPanel">{renderState(state)}</div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// Narrow/mobile: a content-height bottom sheet (not the full-height side panel). Reuses the
// shared Sheet primitive forced to its bottom layout.
function LookupSheet({
  onOpenChange,
  open,
  state,
  term
}: Omit<LookupPanelProps, "anchorRect">): React.JSX.Element {
  return (
    <Sheet onOpenChange={onOpenChange} open={open} side="bottom" title={`Look up: ${term}`}>
      <div className="lookupPanel">{renderState(state)}</div>
    </Sheet>
  );
}

// A view-only definition surface. On desktop/tablet it is a compact popover anchored near
// the selection; on narrow screens it is a content-height bottom sheet. It renders the
// headword, pronunciation, senses, and required attribution, with explicit loading / empty
// / error states. The note editor keeps using the shared Sheet — only lookup is a popover.
export function LookupPanel({
  anchorRect,
  onOpenChange,
  open,
  state,
  term
}: LookupPanelProps): React.JSX.Element {
  const isDesktop = useMediaQuery("(min-width: 768px)");

  if (isDesktop) {
    return (
      <LookupPopover
        anchorRect={anchorRect}
        onOpenChange={onOpenChange}
        open={open}
        state={state}
        term={term}
      />
    );
  }

  return <LookupSheet onOpenChange={onOpenChange} open={open} state={state} term={term} />;
}
