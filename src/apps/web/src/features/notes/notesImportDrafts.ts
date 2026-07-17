import type { ImportNotesRequest } from "@whetstone/contracts";
import {
  createTextDocument,
  documentText,
  parseDocument,
  serializeDocument,
  type DocumentNodeJSON
} from "@whetstone/document";
import {
  mergeNotebookDrafts,
  parseNotebookList,
  splitNotebookDraftContext,
  undoNotebookSplit,
  type NotebookSeparator,
  type ParsedNotebookDraft
} from "@whetstone/domain";

// One editable review row for the Notes "Import a list" surface (#661). Unlike the Memory importer, an
// imported row owns TWO rich documents the learner refines in the shared editor before import: the
// `questionDoc` (becomes the note's cardless current-note prompt cue) and the `noteDoc` (the standalone
// note's canonical body). The parsed answer and any indented context are FOLDED into that one Note
// document as ordinary paragraphs, in source order — Import is another Notes writer, so there is no second
// answer/context/reveal copy. `separator`/`raw` retain the parse so the shared structural edit ops stay
// lossless, `id` is a stable React key, and `note` is a per-row status message (e.g. a dictionary miss).
export type NoteImportDraft = Readonly<{
  id: string;
  questionDoc: DocumentNodeJSON;
  noteDoc: DocumentNodeJSON;
  separator: NotebookSeparator | null;
  raw: string;
  note: string | null;
}>;

// Mints a stable id for a fresh draft (a context split promotes a new one). Injected so the component owns
// the seam.
export type IdMaker = () => string;

// The plaintext of each top-level block of a Note document, in order. `documentText` concatenates all
// descendant text with no inter-block separator, so a faithful inverse of the answer+context fold must
// read block boundaries structurally rather than from the flattened string.
function noteParagraphLines(doc: DocumentNodeJSON): ReadonlyArray<string> {
  return (doc.content ?? []).map(documentText);
}

// Build the single Note document from a parsed answer and its indented context: the answer is the first
// paragraph, then each context line becomes its own paragraph, in source order. A row with neither yields
// a blank document (one empty paragraph) — an incomplete row the learner must fill or remove before
// import. Validated through the document schema, so the result is always a well-formed whetstone document.
export function noteDocumentFromAnswerAndContext(
  answer: string | null,
  context: string | null
): DocumentNodeJSON {
  const lines: string[] = [];
  if (answer !== null && answer.trim().length > 0) {
    lines.push(answer);
  }
  if (context !== null) {
    for (const line of context.split("\n")) {
      lines.push(line);
    }
  }
  const paragraphs: ReadonlyArray<DocumentNodeJSON> =
    lines.length === 0
      ? [{ type: "paragraph" }]
      : lines.map((line) =>
          line.length === 0
            ? { type: "paragraph" }
            : { content: [{ text: line, type: "text" }], type: "paragraph" }
        );
  return serializeDocument(parseDocument({ content: paragraphs, type: "doc" }));
}

// Convert an editable row back into the domain's parsed shape so the shared structural ops operate on it.
// The Note document's first block is the answer (null when blank) and every following block is a context
// line; this is the deterministic inverse of `noteDocumentFromAnswerAndContext`, so a normal answer+context
// row round-trips exactly and no pasted text is ever dropped on a reshape.
function toParsed(draft: NoteImportDraft): ParsedNotebookDraft {
  const lines = noteParagraphLines(draft.noteDoc);
  const [first, ...rest] = lines;
  const answer = first === undefined || first.trim().length === 0 ? null : first;
  const context = rest.length === 0 ? null : rest.join("\n");
  return {
    cue: documentText(draft.questionDoc),
    answer,
    separator: draft.separator,
    context,
    raw: draft.raw
  };
}

function fromParsed(parsed: ParsedNotebookDraft, id: string): NoteImportDraft {
  return {
    id,
    questionDoc: createTextDocument(parsed.cue),
    noteDoc: noteDocumentFromAnswerAndContext(parsed.answer, parsed.context),
    separator: parsed.separator,
    raw: parsed.raw,
    note: null
  };
}

// Parse pasted plain text into editable Note import drafts, minting an id for each.
export function draftsFromText(text: string, makeId: IdMaker): ReadonlyArray<NoteImportDraft> {
  return parseNotebookList(text).map((draft) => fromParsed(draft, makeId()));
}

// Whether a draft's Note has content beyond its first line that could be split into its own following
// draft — used by the UI to show the "Split off" control only when it would do something.
export function noteHasSplittableContext(draft: NoteImportDraft): boolean {
  return splitNotebookDraftContext(toParsed(draft)) !== null;
}

// Apply a field edit to the draft with the given id, leaving the rest untouched.
export function updateDraftIn(
  drafts: ReadonlyArray<NoteImportDraft>,
  id: string,
  patch: Partial<NoteImportDraft>
): ReadonlyArray<NoteImportDraft> {
  return drafts.map((draft) => (draft.id === id ? { ...draft, ...patch } : draft));
}

// Drop the draft with the given id so it is not imported.
export function removeDraftFrom(
  drafts: ReadonlyArray<NoteImportDraft>,
  id: string
): ReadonlyArray<NoteImportDraft> {
  return drafts.filter((draft) => draft.id !== id);
}

// Undo a proposed Question/Note split on one draft: the whole heading becomes the Question again, folding
// the former answer out of the Note (its context is kept). The row's `note` is preserved. Drafts without a
// proposed split are unaffected.
export function undoSplitIn(
  drafts: ReadonlyArray<NoteImportDraft>,
  id: string
): ReadonlyArray<NoteImportDraft> {
  return drafts.map((draft) =>
    draft.id === id
      ? { ...fromParsed(undoNotebookSplit(toParsed(draft)), draft.id), note: draft.note }
      : draft
  );
}

// Merge the draft at `index` with the one after it: the earlier draft keeps its Question and the later
// draft's whole text folds into its Note (lossless). Out-of-range indices are a no-op.
export function mergeDraftsAt(
  drafts: ReadonlyArray<NoteImportDraft>,
  index: number
): ReadonlyArray<NoteImportDraft> {
  const earlier = drafts[index];
  const later = drafts[index + 1];
  if (earlier === undefined || later === undefined) {
    return drafts;
  }
  const merged = fromParsed(mergeNotebookDrafts(toParsed(earlier), toParsed(later)), earlier.id);
  return [...drafts.slice(0, index), merged, ...drafts.slice(index + 2)];
}

// Split a draft's trailing Note paragraphs out into their own following draft. A missing id or a draft
// whose Note has no lines beyond the first is a no-op. The promoted draft gets a fresh id.
export function splitContextIn(
  drafts: ReadonlyArray<NoteImportDraft>,
  id: string,
  makeId: IdMaker
): ReadonlyArray<NoteImportDraft> {
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

// Whether a draft carries both a non-blank Question and a non-blank Note, and can therefore be imported.
function isImportable(draft: NoteImportDraft): boolean {
  return (
    documentText(draft.questionDoc).trim().length > 0 && documentText(draft.noteDoc).trim().length > 0
  );
}

// The drafts that are complete (both Question and Note non-blank) and can therefore be imported.
export function importableNoteDrafts(
  drafts: ReadonlyArray<NoteImportDraft>
): ReadonlyArray<NoteImportDraft> {
  return drafts.filter(isImportable);
}

// The drafts still missing a Question or a Note, surfaced so the UI can flag them inline rather than
// silently dropping them at import.
export function incompleteNoteDrafts(
  drafts: ReadonlyArray<NoteImportDraft>
): ReadonlyArray<NoteImportDraft> {
  return drafts.filter((draft) => !isImportable(draft));
}

// The import request items for the current drafts (incomplete rows excluded). Returns the mutable request
// shape the API helper expects, built fresh from a map so nothing internal is exposed.
export function toImportNoteItems(
  drafts: ReadonlyArray<NoteImportDraft>
): ImportNotesRequest["items"] {
  return importableNoteDrafts(drafts).map((draft) => ({
    questionDoc: draft.questionDoc,
    noteDoc: draft.noteDoc
  }));
}
