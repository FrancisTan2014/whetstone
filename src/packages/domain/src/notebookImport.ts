// Deterministic parsing of a pasted plain-text vocabulary notebook into Memory import drafts (#574). This
// is intentionally dumb structure recognition, never semantic inference: each non-indented nonblank line
// starts a draft, indented lines continue the preceding draft, blank lines separate groups, and only a
// small set of EXPLICIT separators may propose a cue/answer split. No LLM, no guessing from prose.

// The explicit cue/answer separators recognized on a draft's heading line. Only these tokens split a
// heading; a bare dash, "vs", a comma, or ordinary punctuation is never treated as a separator. The
// leftmost occurrence among them wins, so `push back -> pushback` splits on `->` and `word: meaning` on
// its first `:`.
export const notebookSeparators = ["->", "\u2192", "=", ":"] as const;

export type NotebookSeparator = (typeof notebookSeparators)[number];

// One draft proposed from a pasted notebook, still awaiting the learner's confirmation:
// - `cue` is the heading text before any recognized separator (or the whole heading when none split it).
// - `answer` is the text after the separator when one split the heading, else null.
// - `separator` records which explicit token produced the split (null when none), so the review UI can
//   show the proposed split and offer to undo it.
// - `context` joins the draft's indented continuation lines with newlines (null when it had none).
// - `raw` preserves the draft's original pasted text verbatim, so no keystroke is lost before the learner
//   confirms, and an undo can restore the exact heading.
export type ParsedNotebookDraft = Readonly<{
  cue: string;
  answer: string | null;
  separator: NotebookSeparator | null;
  context: string | null;
  raw: string;
}>;

type DraftAccumulator = {
  headingLine: string;
  contextLines: string[];
  rawLines: string[];
};

function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

// Whether a line is an indented continuation. Only a leading space or tab counts; a line starting flush
// with content always begins a new draft.
function isIndented(line: string): boolean {
  return /^[ \t]/.test(line);
}

// Split a heading on the leftmost recognized separator, but only when BOTH sides are non-blank — a
// dangling `word ->` or a leading `-> word` is not a real cue/answer pair, so the whole heading stays the
// cue and no split is proposed.
function splitHeading(heading: string): Pick<ParsedNotebookDraft, "cue" | "answer" | "separator"> {
  let bestIndex = -1;
  let bestSeparator: NotebookSeparator | null = null;
  for (const separator of notebookSeparators) {
    const index = heading.indexOf(separator);
    if (index !== -1 && (bestIndex === -1 || index < bestIndex)) {
      bestIndex = index;
      bestSeparator = separator;
    }
  }

  if (bestSeparator === null) {
    return { cue: heading, answer: null, separator: null };
  }

  const cue = heading.slice(0, bestIndex).trim();
  const answer = heading.slice(bestIndex + bestSeparator.length).trim();
  if (cue.length === 0 || answer.length === 0) {
    return { cue: heading, answer: null, separator: null };
  }
  return { cue, answer, separator: bestSeparator };
}

function finalizeDraft(accumulator: DraftAccumulator): ParsedNotebookDraft {
  const split = splitHeading(accumulator.headingLine);
  return Object.freeze({
    cue: split.cue,
    answer: split.answer,
    separator: split.separator,
    context: accumulator.contextLines.length === 0 ? null : accumulator.contextLines.join("\n"),
    raw: accumulator.rawLines.join("\n")
  });
}

// Parse a pasted notebook into ordered draft proposals. Deterministic and lossless: every nonblank line
// lands in exactly one draft (as a heading or a continuation) and the original text of each draft is kept
// in `raw`. A blank line closes the current draft group, so a later indented line starts a fresh draft
// rather than attaching across the gap.
export function parseNotebookList(text: string): ReadonlyArray<ParsedNotebookDraft> {
  const drafts: DraftAccumulator[] = [];
  let current: DraftAccumulator | null = null;

  for (const line of text.split(/\r?\n/)) {
    if (isBlank(line)) {
      current = null;
      continue;
    }
    if (current !== null && isIndented(line)) {
      current.contextLines.push(line.trim());
      current.rawLines.push(line);
      continue;
    }
    current = { headingLine: line.trim(), contextLines: [], rawLines: [line] };
    drafts.push(current);
  }

  return drafts.map(finalizeDraft);
}

// Undo a proposed split: restore the draft's original heading line as the cue and clear the answer and
// separator, keeping the context. A draft with no proposed split is returned unchanged.
export function undoNotebookSplit(draft: ParsedNotebookDraft): ParsedNotebookDraft {
  if (draft.separator === null) {
    return draft;
  }
  const newlineIndex = draft.raw.indexOf("\n");
  const heading = (newlineIndex === -1 ? draft.raw : draft.raw.slice(0, newlineIndex)).trim();
  return Object.freeze({
    cue: heading,
    answer: null,
    separator: null,
    context: draft.context,
    raw: draft.raw
  });
}

function readableLine(draft: ParsedNotebookDraft): string {
  return draft.answer === null ? draft.cue : `${draft.cue} \u2192 ${draft.answer}`;
}

// Merge `later` into `earlier`, keeping `earlier`'s cue and answer and folding all of `later`'s text (its
// cue/answer line and context) plus `earlier`'s existing context into the merged context, so nothing the
// learner pasted is dropped. The proposed-split marker is cleared (the merged draft is no longer a raw
// parse), and both raws are preserved.
export function mergeNotebookDrafts(
  earlier: ParsedNotebookDraft,
  later: ParsedNotebookDraft
): ParsedNotebookDraft {
  const contextParts = [earlier.context, readableLine(later), later.context].filter(
    (part): part is string => part !== null
  );
  return Object.freeze({
    cue: earlier.cue,
    answer: earlier.answer,
    separator: null,
    context: contextParts.join("\n"),
    raw: `${earlier.raw}\n${later.raw}`
  });
}

// Split a draft's context off into its own following draft — the common "this continuation line is really
// a separate entry" case. The original keeps its cue/answer and loses its context; the promoted draft
// takes the first context line as its cue and the remaining lines as its context. Returns null when there
// is no context to promote.
export function splitNotebookDraftContext(
  draft: ParsedNotebookDraft
): readonly [ParsedNotebookDraft, ParsedNotebookDraft] | null {
  if (draft.context === null) {
    return null;
  }
  const newlineIndex = draft.context.indexOf("\n");
  const firstLine = newlineIndex === -1 ? draft.context : draft.context.slice(0, newlineIndex);
  const rest = newlineIndex === -1 ? null : draft.context.slice(newlineIndex + 1);
  const remainder: ParsedNotebookDraft = Object.freeze({
    cue: draft.cue,
    answer: draft.answer,
    separator: draft.separator,
    context: null,
    raw: draft.raw
  });
  const promoted: ParsedNotebookDraft = Object.freeze({
    cue: firstLine,
    answer: null,
    separator: null,
    context: rest,
    raw: draft.context
  });
  return [remainder, promoted];
}
