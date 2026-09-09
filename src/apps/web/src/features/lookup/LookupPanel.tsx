import { useMemo, useState } from "react";

import type {
  DictionaryEntry,
  DictionaryPartOfSpeech,
  DictionarySense,
  LookupSourceId
} from "@whetstone/contracts";

import { SelectionPanel } from "./SelectionPanel";
import { externalDictionaryLinks } from "./externalDictionaries";
import { partOfSpeechHueClass } from "./partOfSpeechHue.tokens";

// The view-only lookup state the reader drives: fetching, a failure, a no-match, or a
// resolved entry. There are deliberately no note controls here — lookup never creates,
// pre-fills, or edits a note.
export type LookupState =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "error" }>
  | Readonly<{ status: "empty" }>
  | Readonly<{ entry: DictionaryEntry; status: "loaded" }>;

// One independently-fetched source rendered as a tab: WordNet, Wiktionary, 萌典, or CC-CEDICT. Each
// carries its own loading/empty/error/loaded state so a slow or down source fails to its tab, never
// the panel.
export type LookupTab = Readonly<{ id: LookupSourceId; label: string; state: LookupState }>;

export type LookupPanelProps = Readonly<{
  // The selection's viewport rect; the desktop popover anchors to it so the card sits near
  // the selection (and flips/offsets near viewport edges) without covering it.
  anchorRect?: DOMRect | undefined;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  tabs: ReadonlyArray<LookupTab>;
  term: string;
}>;

// A single numbered sense: its definition and any examples (indented and italic). Synonyms are
// deliberately not rendered here — they belong once to the whole part-of-speech section (see
// renderPartOfSpeech), never repeated under each sense.
function renderSense(sense: DictionarySense, index: number): React.JSX.Element {
  return (
    <li className="lookupSense" key={index}>
      <span className="lookupSenseOrdinal">{index + 1}.</span>
      <div className="lookupSenseBody">
        <span className="lookupGloss">{sense.definition}</span>
        {sense.examples.map((example, exampleIndex) => (
          <span className="lookupExample" key={exampleIndex}>
            “{example}”
          </span>
        ))}
      </div>
    </li>
  );
}

// The part of speech's synonyms shown once: the union of its senses' synonyms, deduplicated
// case-insensitively and kept in first-seen order. WordNet merges the same synonym set onto
// every sense, so collapsing them here is what stops the chips from repeating under each sense.
function partOfSpeechSynonyms(part: DictionaryPartOfSpeech): ReadonlyArray<string> {
  const seen = new Set<string>();
  const synonyms: string[] = [];

  for (const sense of part.senses) {
    for (const synonym of sense.synonyms) {
      const key = synonym.toLowerCase();

      if (!seen.has(key)) {
        seen.add(key);
        synonyms.push(synonym);
      }
    }
  }

  return synonyms;
}

function renderSynonyms(synonyms: ReadonlyArray<string>): React.JSX.Element | null {
  if (synonyms.length === 0) {
    return null;
  }

  return (
    <div className="lookupSynonymsRow">
      <span className="lookupSynonymsLabel">Synonyms</span>
      <ul aria-label="Synonyms" className="lookupSynonyms">
        {synonyms.map((synonym, synonymIndex) => (
          <li className="lookupSynonym" key={synonymIndex}>
            {synonym}
          </li>
        ))}
      </ul>
    </div>
  );
}

// One part-of-speech group: a color-coded section with its label once, a numbered list of its
// senses, then a single deduplicated "Synonyms" row. A named part of speech gets a collapsible
// header button (the senses are a long list for words like "fundamental"); collapsing focuses the
// reader on the group they want. Groups default to expanded, and reopening lookup mounts a fresh
// group so state resets (no persistence in v0). The hue class drives the section's tokenized
// (Day/Night) color.
function PartOfSpeechGroup({ part }: { part: DictionaryPartOfSpeech }): React.JSX.Element {
  const [expanded, setExpanded] = useState(true);
  const synonyms = partOfSpeechSynonyms(part);
  const label = part.partOfSpeech;

  // The fallback group with no part of speech has no header to toggle, so it always shows.
  if (label === undefined) {
    return (
      <section className={`lookupGroup ${partOfSpeechHueClass(label)}`}>
        <ol className="lookupSenses">{part.senses.map(renderSense)}</ol>
        {renderSynonyms(synonyms)}
      </section>
    );
  }

  return (
    <section className={`lookupGroup ${partOfSpeechHueClass(label)}`}>
      <button
        aria-expanded={expanded}
        className="lookupPartOfSpeech lookupPartOfSpeechToggle"
        onClick={() => setExpanded((value) => !value)}
        type="button"
      >
        <span className="lookupPartOfSpeechLabel">{label}</span>
        <span aria-hidden className="lookupGroupCaret">
          ▾
        </span>
      </button>
      {expanded ? (
        <div className="lookupGroupBody">
          <ol className="lookupSenses">{part.senses.map(renderSense)}</ol>
          {renderSynonyms(synonyms)}
        </div>
      ) : null}
    </section>
  );
}

function renderPronunciation(headword: string) {
  return function renderOne(
    pronunciation: DictionaryEntry["pronunciations"][number],
    index: number
  ): React.JSX.Element {
    return (
      <span className="lookupPronunciation" key={index}>
        {pronunciation.ipa}
        {pronunciation.audio === undefined ? null : (
          <audio
            aria-label={`Pronunciation audio for ${headword}`}
            className="lookupAudio"
            controls
            src={pronunciation.audio}
          />
        )}
      </span>
    );
  };
}

// The language-aware "Open in …" external-dictionary links for a term (#254): English →
// Longman/Merriam-Webster/Oxford, a CJK term → 汉典/萌典/ctext/国学大师. Shared by a resolved entry's
// header and the no-definition fallback (#339), so both render the identical quiet link row.
function LookupExternalLinks({ term }: { term: string }): React.JSX.Element {
  const links = externalDictionaryLinks(term);

  return (
    <nav aria-label="Open in external dictionary" className="lookupExternalLinks">
      <span className="lookupExternalLabel">Open in</span>
      {links.map((link) => (
        <a
          className="lookupExternalLink"
          href={link.url}
          key={link.label}
          rel="noopener noreferrer"
          target="_blank"
        >
          {link.label}
        </a>
      ))}
    </nav>
  );
}

// The no-definition state as a launchpad, not a dead-end (#339): a calm line naming the term, then the
// same language-aware external-dictionary links — so a term the bundled dictionaries simply do not
// carry (a classical-Chinese compound, a proper noun) still routes the reader to real dictionary
// content instead of the misleading "Please try again."
function LookupNotFound({ term }: { term: string }): React.JSX.Element {
  return (
    <div className="lookupNotFound">
      <p>No definition found for “{term}”.</p>
      <LookupExternalLinks term={term} />
    </div>
  );
}

function renderEntry(entry: DictionaryEntry): React.JSX.Element {
  return (
    <div className="lookupEntry">
      <header className="lookupHeader">
        <p className="lookupHeadword">{entry.headword}</p>
        {entry.pronunciations.length === 0 ? null : (
          <div className="lookupPronunciations">
            {entry.pronunciations.map(renderPronunciation(entry.headword))}
          </div>
        )}
        <LookupExternalLinks term={entry.headword} />
      </header>
      <div className="lookupGroups">
        {entry.partsOfSpeech.map((part, index) => (
          <PartOfSpeechGroup key={index} part={part} />
        ))}
      </div>
      {entry.etymology === undefined ? null : (
        <p className="lookupEtymology">
          <span className="lookupEtymologyLabel">Origin</span> {entry.etymology}
        </p>
      )}
      {entry.sources.length === 0 ? null : (
        <footer className="lookupAttribution">{entry.sources.join(" · ")}</footer>
      )}
    </div>
  );
}

// Render one dictionary source's state. Every dictionary source is source-agnostic — no source gets
// special AI-badge treatment; the AI-labeled explanation lives entirely in the separate, explicit
// Explain feature (`features/lookup/explain/`, #925), never mixed into a dictionary tab.
function renderState(state: LookupState, term: string): React.JSX.Element {
  switch (state.status) {
    case "loading":
      return <p role="status">Looking up…</p>;
    case "error":
      return <p role="alert">This source is unavailable. Try another tab.</p>;
    case "empty":
      return <LookupNotFound term={term} />;
    case "loaded":
      // An "empty-but-loaded" entry (found, yet no part-of-speech groups) carries no readable
      // definition: the response contract permits found:true with an empty partsOfSpeech, so a tab
      // the reader opens explicitly still shows the no-match launchpad rather than a bare headword
      // (#306) — with the external links so it is never a dead-end (#339).
      return stateHasContent(state) ? renderEntry(state.entry) : <LookupNotFound term={term} />;
  }
}

// A tab carries readable content only when it has loaded AND its entry has at least one
// part-of-speech group. A loaded-but-content-less entry (the contract allows found:true with an
// empty partsOfSpeech array) counts as no content, so tab selection and the all-failed state treat
// it the same as an empty or errored source (#306).
function stateHasContent(state: LookupState): boolean {
  return state.status === "loaded" && state.entry.partsOfSpeech.length > 0;
}

// The default tab once a tab is open: the first source that has readable content OR is still
// loading — skipping any leading tab that resolved to error, empty, or empty-but-loaded (no
// part-of-speech groups, #306). This keeps the language's preferred lead source (offline WordNet for
// English; 萌典's Chinese definitions for Chinese, #272) as the default even when a later, faster
// source returns first, while never trapping the panel on a source that has nothing to show — a
// function word like "versus" that WordNet has no entry for falls through to Wiktionary. Each
// networked source is time-boxed, so a leading "loading" tab is transient: it resolves to content or
// falls through to the next source. The reader can still switch tabs explicitly.
function preferredTab(tabs: ReadonlyArray<LookupTab>): number {
  const usable = tabs.findIndex(
    (tab) => stateHasContent(tab.state) || tab.state.status === "loading"
  );
  return usable === -1 ? 0 : usable;
}

// The tabbed lookup body: each source fetched independently, with a >=44px tab strip when there is
// more than one. When every source resolved to empty/error, show the no-definition launchpad (a
// not-found line naming the term plus external-dictionary links, #339) instead of a dead tab. A
// single-source language (CJK) shows no strip — just that source's state.
function LookupTabs({
  tabs,
  term
}: Readonly<{ tabs: ReadonlyArray<LookupTab>; term: string }>): React.JSX.Element {
  const [selected, setSelected] = useState<LookupSourceId | undefined>(undefined);
  // Every source has settled with nothing to show: none is still loading and none has content (each
  // resolved to error, empty, or empty-but-loaded). Show the launchpad instead of a dead tab.
  const settled =
    tabs.length > 1 &&
    tabs.every((tab) => tab.state.status !== "loading" && !stateHasContent(tab.state));

  const activeIndex = useMemo(() => {
    const chosen = tabs.findIndex((tab) => tab.id === selected);
    return chosen === -1 ? preferredTab(tabs) : chosen;
  }, [selected, tabs]);

  if (tabs.length === 0 || settled) {
    return <LookupNotFound term={term} />;
  }

  const active = tabs[activeIndex] as LookupTab;

  return (
    <div className="lookupTabsRoot">
      {tabs.length > 1 ? (
        <div className="lookupTabs" role="tablist">
          {tabs.map((tab) => (
            <button
              aria-selected={tab.id === active.id}
              className="lookupTab"
              key={tab.id}
              onClick={() => setSelected(tab.id)}
              role="tab"
              type="button"
            >
              {tab.label}
            </button>
          ))}
        </div>
      ) : null}
      {renderState(active.state, term)}
    </div>
  );
}

// A view-only definition surface. On desktop/tablet it is a compact popover anchored near
// the selection; on narrow screens it is a content-height bottom sheet. Each source is its own
// tab, fetched independently, so one being slow/down/empty never freezes the panel (#196).
export function LookupPanel({
  anchorRect,
  onOpenChange,
  open,
  tabs,
  term
}: LookupPanelProps): React.JSX.Element {
  return (
    <SelectionPanel
      anchorRect={anchorRect}
      onOpenChange={onOpenChange}
      open={open}
      title={`Look up: ${term}`}
    >
      <LookupTabs tabs={tabs} term={term} />
    </SelectionPanel>
  );
}
