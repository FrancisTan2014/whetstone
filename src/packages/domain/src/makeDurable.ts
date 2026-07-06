// Pure Make Durable proposal logic (#452): the proposal prompt, the visibility gate, and duplicate
// classification. No LLM, DB, or IO — the model call is an injected seam; these are the deterministic
// rules the server runs over a generated candidate before it can ever become a Today review card.

// Bumped whenever the proposal prompt's meaning changes, so a stored candidate records which prompt
// produced it (audit / eval). Stamped onto every `proposal_candidates.prompt_version`.
export const PROPOSAL_PROMPT_VERSION = "proposal-v1";

// The confidence floor a candidate must clear to be shown. Below this the model is too unsure to be
// worth the learner's attention — prefer no card over a weak one.
export const DEFAULT_PROPOSAL_CONFIDENCE_THRESHOLD = 0.6;

// The instruction lines the proposal prompt always carries. Exported so a test asserts the invariants
// survive prompt edits: at most one candidate, only the allowed types, faithful evidence quote, prefer
// no proposal over a weak one, strict JSON out.
export const proposalPromptInstructions: ReadonlyArray<string> = [
  "You analyze one quick capture and decide whether it contains ONE high-value English-production learning item.",
  "Emit ZERO or ONE candidate — never more. Prefer no candidate over a weak one.",
  'The candidate type must be exactly one of: "phrase_chunk" (a reusable phrase/chunk worth remembering), "couldnt_say_gap" (something the learner could not say in English), or "recurring_pattern" (a reusable fix for a repeated error such as a preposition, word choice, or verb complementation).',
  "Quote evidence verbatim from the capture in evidenceQuote — do NOT paraphrase or invent it.",
  "Use only the capture text; do not invent facts.",
  "confidence is 0..1; reason is one concrete sentence.",
  "payload carries: target (the phrase/pattern to remember), cue (a retrieval prompt), useContext (when/where to use it), an optional explanation, category (one of language, work, family, technical, reading, reflection, daily_life), and optional tags.",
  'Reply with ONLY strict JSON of the form {"candidates":[{"type":"...","confidence":0.0,"reason":"...","evidenceQuote":"...","payload":{"target":"...","cue":"...","useContext":"...","category":"...","tags":["..."]}}]} — an empty candidates array when nothing qualifies.'
];

// Build the proposal prompt for a raw capture: the fixed invariant instructions, then the capture text.
export function buildProposalPrompt(rawText: string): string {
  return [...proposalPromptInstructions, "", `Capture:\n${rawText}`].join("\n");
}

// Normalize free text for faithful-quote / duplicate comparison: trim, lowercase, and collapse internal
// whitespace so quoting/dedup ignore casing and spacing noise but nothing else.
export function normalizeForMatch(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

// Is `quote` a faithful (verbatim, modulo case/whitespace) span of `source`? The gate uses this to
// reject a candidate whose evidence the model paraphrased or fabricated — a Make Durable card must be
// grounded in what the learner actually wrote.
export function isFaithfulQuote(quote: string, source: string): boolean {
  const normalizedQuote = normalizeForMatch(quote);
  if (normalizedQuote.length === 0) {
    return false;
  }
  return normalizeForMatch(source).includes(normalizedQuote);
}

// Why a candidate was hidden (or that it passed) — surfaced for logging/tuning, never shown raw.
export type ProposalGateVerdict =
  | Readonly<{ visible: true }>
  | Readonly<{ reason: "low_confidence" | "unfaithful_quote"; visible: false }>;

// The pure visibility gate: a candidate may be shown only when the model is confident enough AND its
// evidence quote is a faithful span of the capture. (Required-field presence is guaranteed upstream by
// the payload schema; duplicate + per-capture cap are enforced with DB data by the caller.)
export function evaluateProposalGate(
  input: Readonly<{
    confidence: number;
    evidenceQuote: string;
    rawText: string;
    threshold?: number;
  }>
): ProposalGateVerdict {
  const threshold = input.threshold ?? DEFAULT_PROPOSAL_CONFIDENCE_THRESHOLD;

  if (input.confidence < threshold) {
    return { reason: "low_confidence", visible: false };
  }

  if (!isFaithfulQuote(input.evidenceQuote, input.rawText)) {
    return { reason: "unfaithful_quote", visible: false };
  }

  return { visible: true };
}

// The v0 duplicate verdicts the classifier can return (a subset of the stored duplicate-status
// vocabulary): brand new, same target in the same context, or same target in a new context.
export type ProposalDuplicateVerdict =
  | "unique"
  | "same_target_same_context"
  | "same_target_new_context";

// Classify a proposed (target, useContext) against the learner's existing recall items. v0 rule: an
// existing item with the SAME normalized target and the SAME normalized use-context is a duplicate
// (`same_target_same_context`, suppressed by the caller); the same target in a different context is
// `same_target_new_context` (allowed); otherwise `unique`. Context comparison treats a missing existing
// context as an empty string.
export function classifyProposalDuplicate(
  proposed: Readonly<{ target: string; useContext: string }>,
  existing: ReadonlyArray<Readonly<{ text: string; useContext: string | null }>>
): ProposalDuplicateVerdict {
  const target = normalizeForMatch(proposed.target);
  const useContext = normalizeForMatch(proposed.useContext);

  let sawSameTarget = false;
  for (const item of existing) {
    if (normalizeForMatch(item.text) !== target) {
      continue;
    }
    sawSameTarget = true;
    if (normalizeForMatch(item.useContext ?? "") === useContext) {
      return "same_target_same_context";
    }
  }

  return sawSameTarget ? "same_target_new_context" : "unique";
}
