import type { DepositMemoryRequest, ImportMemoryRequest } from "@whetstone/contracts";
import { createTextDocument, documentText, type DocumentNodeJSON } from "@whetstone/document";
import {
  mergeNotebookDrafts,
  parseNotebookList,
  splitNotebookDraftContext,
  undoNotebookSplit,
  type NotebookSeparator,
  type ParsedNotebookDraft
} from "@whetstone/domain";

// One editable review row for the "Paste a list" surface (#574). The cue and answer are rich documents so
// the learner can format them in the shared editor before importing (the reviewer's requirement); their
// plaintext is derived on demand via `documentText`. `context` stays a plain string ("" = none) since the
// reviewer's ask is cue/answer only. `separator`/`raw` retain the parse so the shared structural edit ops
// stay lossless, `id` is a stable React key, and `note` is a per-row status message (e.g. a gloss miss).
export type ImportDraft = Readonly<{
  id: string;
  cueDoc: DocumentNodeJSON;
  answerDoc: DocumentNodeJSON;
  context: string;
  separator: NotebookSeparator | null;
  raw: string;
  note: string | null;
}>;

// Mints a stable id for a fresh draft (split promotes a new one). Injected so the component owns the seam.
export type IdMaker = () => string;

// Convert an editable row back into the domain's parsed shape so the shared edit ops operate on it; a
// blank answer/context maps to null, matching the parser's own representation. Structural ops rebuild the
// docs from this plaintext, so rich formatting is lost only on a reshape, never on a direct edit.
function toParsed(draft: ImportDraft): ParsedNotebookDraft {
  const answer = documentText(draft.answerDoc);
  return {
    cue: documentText(draft.cueDoc),
    answer: answer.trim().length === 0 ? null : answer,
    separator: draft.separator,
    context: draft.context.trim().length === 0 ? null : draft.context,
    raw: draft.raw
  };
}

function fromParsed(parsed: ParsedNotebookDraft, id: string): ImportDraft {
  return {
    id,
    cueDoc: createTextDocument(parsed.cue),
    answerDoc: createTextDocument(parsed.answer ?? ""),
    context: parsed.context ?? "",
    separator: parsed.separator,
    raw: parsed.raw,
    note: null
  };
}

// Parse pasted plain text into editable review drafts, minting an id for each.
export function draftsFromText(text: string, makeId: IdMaker): ReadonlyArray<ImportDraft> {
  return parseNotebookList(text).map((draft) => fromParsed(draft, makeId()));
}

// Apply a field edit to the draft with the given id, leaving the rest untouched.
export function updateDraftIn(
  drafts: ReadonlyArray<ImportDraft>,
  id: string,
  patch: Partial<ImportDraft>
): ReadonlyArray<ImportDraft> {
  return drafts.map((draft) => (draft.id === id ? { ...draft, ...patch } : draft));
}

// Drop the draft with the given id so it is not imported.
export function removeDraftFrom(
  drafts: ReadonlyArray<ImportDraft>,
  id: string
): ReadonlyArray<ImportDraft> {
  return drafts.filter((draft) => draft.id !== id);
}

// Undo a proposed cue/answer split on one draft: the whole heading becomes the cue again, keeping its
// context. Its `note` is preserved. Drafts without a proposed split are unaffected.
export function undoSplitIn(
  drafts: ReadonlyArray<ImportDraft>,
  id: string
): ReadonlyArray<ImportDraft> {
  return drafts.map((draft) =>
    draft.id === id
      ? { ...fromParsed(undoNotebookSplit(toParsed(draft)), draft.id), note: draft.note }
      : draft
  );
}

// Merge the draft at `index` with the one after it: the earlier draft keeps its cue/answer and the later
// draft's whole text folds into its context (lossless). Out-of-range indices are a no-op.
export function mergeDraftsAt(
  drafts: ReadonlyArray<ImportDraft>,
  index: number
): ReadonlyArray<ImportDraft> {
  const earlier = drafts[index];
  const later = drafts[index + 1];
  if (earlier === undefined || later === undefined) {
    return drafts;
  }
  const merged = fromParsed(mergeNotebookDrafts(toParsed(earlier), toParsed(later)), earlier.id);
  return [...drafts.slice(0, index), merged, ...drafts.slice(index + 2)];
}

// Split a draft's context out into its own following draft. A missing id or a draft with no context is a
// no-op. The promoted draft gets a fresh id.
export function splitContextIn(
  drafts: ReadonlyArray<ImportDraft>,
  id: string,
  makeId: IdMaker
): ReadonlyArray<ImportDraft> {
  const index = drafts.findIndex((draft) => draft.id === id);
  const target = drafts[index];
  if (target === undefined) {
    return drafts;
  }
  const result = splitNotebookDraftContext(toParsed(target));
  if (result === null) {
    return drafts;
  }
  const [remainder, promoted] = result;
  return [
    ...drafts.slice(0, index),
    fromParsed(remainder, target.id),
    fromParsed(promoted, makeId()),
    ...drafts.slice(index + 1)
  ];
}

// The drafts that carry a non-blank cue and can therefore be imported.
export function importableDrafts(drafts: ReadonlyArray<ImportDraft>): ReadonlyArray<ImportDraft> {
  return drafts.filter((draft) => documentText(draft.cueDoc).trim().length > 0);
}

// Build the deposit item for one row: the note body is the cue plus any context (blank-line separated,
// mirroring Quick Add), and the prompt carries the rich cue document plus, when an answer is present, its
// answer text and document — an answerless row saves as an unscheduled draft. `cueText`/`answerText` are
// the trimmed plaintext (authoritative for search/lifecycle); the documents carry the learner's formatting.
function toDepositItem(draft: ImportDraft): DepositMemoryRequest {
  const cue = documentText(draft.cueDoc).trim();
  const answer = documentText(draft.answerDoc).trim();
  const context = draft.context.trim();
  const noteText = context.length === 0 ? cue : `${cue}\n\n${context}`;
  return {
    captureSource: "import",
    noteText,
    prompts: [
      answer.length === 0
        ? { cueText: cue, cueDoc: draft.cueDoc }
        : { cueText: cue, answerText: answer, cueDoc: draft.cueDoc, answerDoc: draft.answerDoc }
    ]
  };
}

// The import request body items for the current drafts (blank-cue rows dropped). Returns the mutable
// request shape the API helper expects, built fresh from a map so nothing internal is exposed.
export function toImportItems(drafts: ReadonlyArray<ImportDraft>): ImportMemoryRequest["items"] {
  return importableDrafts(drafts).map(toDepositItem);
}
