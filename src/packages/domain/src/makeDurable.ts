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
  "Compare the capture against the learner's 'Already remembered' items below; if it is already covered by one of them, prefer NO candidate rather than proposing a near-duplicate.",
  "confidence is 0..1; reason is one concrete sentence.",
  "payload carries: target (the phrase/pattern to remember), cue (a retrieval prompt), useContext (when/where to use it), an optional explanation, category (one of language, work, family, technical, reading, reflection, daily_life), and optional tags.",
  'Reply with ONLY strict JSON of the form {"candidates":[{"type":"...","confidence":0.0,"reason":"...","evidenceQuote":"...","payload":{"target":"...","cue":"...","useContext":"...","category":"...","tags":["..."]}}]} — an empty candidates array when nothing qualifies.'
];

// The extra instruction lines the BACKFILL prompt adds on top of the shared ones (#456). Mining older
// history must be MORE selective than live capture: prefer durable, reusable production value (a
// recurring pattern, a genuinely reusable phrase, or a real "couldn't say it" gap) and pass over
// one-off spelling, typo, or product/proper-name fixes, which carry no reusable value. Exported so a
// test asserts the high-value bias survives prompt edits.
export const backfillEmphasisInstructions: ReadonlyArray<string> = [
  "You are mining an OLDER capture from history for durable value, so be MORE selective than live capture.",
  "Propose ONLY reusable production value: a recurring_pattern (a repeated error worth a durable fix), a phrase_chunk (a genuinely reusable phrase), or a real couldnt_say_gap.",
  "Do NOT propose one-off spelling fixes, typos, or product/proper-name corrections — they carry no reusable production value, so prefer NO candidate for them."
];

// A small slice of the learner's existing recall for retrieve-before-generate: the target they already
// remember, plus when they use it. Passed into the proposal prompt so the model can avoid re-proposing
// something already covered (the deterministic `classifyProposalDuplicate` remains the safety net).
export type ExistingRecallItem = Readonly<{ target: string; useContext: string | null }>;

// ---- Reviewed-example proposal policy (#457) ----

// A proposal the learner already reviewed, distilled to what the few-shot policy prompt needs: the
// decision (outcome), the proposal type, the broad category, the target phrase, when it is used, and any
// tags. For an edited_saved review this reflects the learner's EDITED payload — what they actually kept.
// The string unions mirror @whetstone/contracts (proposalReviewOutcomeSchema / proposalCandidateTypeSchema);
// domain stays contracts-free, so keep them in sync (as coachGrade.ts / learnerModel.ts do).
export type ReviewedProposalOutcome =
  | "saved"
  | "edited_saved"
  | "not_useful_now"
  | "wrong_hallucinated"
  | "ignored";

export type ReviewedProposalKind = "phrase_chunk" | "couldnt_say_gap" | "recurring_pattern";

export type ReviewedProposalExample = Readonly<{
  outcome: ReviewedProposalOutcome;
  type: ReviewedProposalKind;
  category: string;
  target: string;
  useContext: string;
  tags: ReadonlyArray<string>;
}>;

// The cap on reviewed examples fed into one proposal prompt, so the few-shot policy stays bounded no
// matter how much review history exists.
export const MAX_POLICY_EXAMPLES = 6;

// The three proposal types, in a fixed order, so example selection round-robins deterministically.
const REVIEWED_PROPOSAL_KINDS: ReadonlyArray<ReviewedProposalKind> = [
  "phrase_chunk",
  "couldnt_say_gap",
  "recurring_pattern"
];

// Select a small, bounded, type-diverse set of reviewed examples for the policy prompt. Input is
// most-recent-first. Duplicates (same normalized target) collapse to their most-recent review, then the
// survivors are taken round-robin across proposal types so no single type floods the few-shot set,
// capped at `cap`. Deterministic and pure — a non-positive cap yields no examples.
export function selectPolicyExamples(
  examples: ReadonlyArray<ReviewedProposalExample>,
  cap: number = MAX_POLICY_EXAMPLES
): ReadonlyArray<ReviewedProposalExample> {
  if (cap <= 0) {
    return [];
  }

  const seen = new Set<string>();
  const byKind: Record<ReviewedProposalKind, ReviewedProposalExample[]> = {
    phrase_chunk: [],
    couldnt_say_gap: [],
    recurring_pattern: []
  };
  for (const example of examples) {
    const key = normalizeForMatch(example.target);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    byKind[example.type].push(example);
  }

  const selected: ReviewedProposalExample[] = [];
  let addedInRound = true;
  while (selected.length < cap && addedInRound) {
    addedInRound = false;
    for (const kind of REVIEWED_PROPOSAL_KINDS) {
      if (selected.length >= cap) {
        break;
      }
      const next = byKind[kind].shift();
      if (next !== undefined) {
        selected.push(next);
        addedInRound = true;
      }
    }
  }

  return selected;
}

// Render one reviewed example as a single policy line the model can read: the decision, the type, the
// broad category, the target, when it is used, and any tags.
function renderPolicyExample(example: ReviewedProposalExample): string {
  const tags = example.tags.length === 0 ? "" : ` [tags: ${example.tags.join(", ")}]`;
  return `- [${example.outcome}] ${example.type} (${example.category}): "${example.target}" — used when ${example.useContext}${tags}`;
}

// Render the "Policy from your past reviews" few-shot block, or null when there are no examples (so the
// prompt omits the section entirely and falls back to the base path).
function renderPolicyBlock(examples: ReadonlyArray<ReviewedProposalExample>): string | null {
  if (examples.length === 0) {
    return null;
  }
  return [
    "Policy from your past reviews — follow these decisions when deciding whether to propose, skip, or which type to choose:",
    ...examples.map(renderPolicyExample),
    "Repeat the kind of item marked saved/edited_saved; do NOT propose items like those marked not_useful_now or wrong_hallucinated."
  ].join("\n");
}

// Render the "Already remembered" retrieval block for the prompt: one line per existing item (with its
// use-context when known), or an explicit "(none yet)" so the section is always present and unambiguous.
function renderRememberedItems(existing: ReadonlyArray<ExistingRecallItem>): string {
  if (existing.length === 0) {
    return "(none yet)";
  }
  return existing
    .map((item) =>
      item.useContext === null ? `- ${item.target}` : `- ${item.target} — ${item.useContext}`
    )
    .join("\n");
}

// Assemble a proposal prompt from a chosen instruction set: the instructions, the retrieved "Already
// remembered" context (so the model compares before proposing), the optional reviewed-example policy
// block (#457), then the capture text. Shared by the live and backfill builders so both keep the
// identical framing. When there are no reviewed examples the policy section is omitted (the fallback
// path), leaving the exact pre-policy prompt.
function assembleProposalPrompt(
  instructions: ReadonlyArray<string>,
  rawText: string,
  existing: ReadonlyArray<ExistingRecallItem>,
  examples: ReadonlyArray<ReviewedProposalExample>
): string {
  const policyBlock = renderPolicyBlock(examples);
  const sections = [
    instructions.join("\n"),
    `Already remembered:\n${renderRememberedItems(existing)}`,
    ...(policyBlock === null ? [] : [policyBlock]),
    `Capture:\n${rawText}`
  ];
  return sections.join("\n\n");
}

// Build the proposal prompt for a raw capture: the fixed invariant instructions, the retrieved
// "Already remembered" context (so the model compares before proposing), the optional reviewed-example
// policy (#457), then the capture text.
export function buildProposalPrompt(
  rawText: string,
  existing: ReadonlyArray<ExistingRecallItem> = [],
  examples: ReadonlyArray<ReviewedProposalExample> = []
): string {
  return assembleProposalPrompt(proposalPromptInstructions, rawText, existing, examples);
}

// Build the BACKFILL proposal prompt (#456): the shared invariant instructions plus the high-value
// backfill bias, over the same retrieval/policy/capture framing. Used when mining existing Timeline
// history so only durable, reusable items surface — not one-off spelling/product-name corrections.
export function buildBackfillProposalPrompt(
  rawText: string,
  existing: ReadonlyArray<ExistingRecallItem> = [],
  examples: ReadonlyArray<ReviewedProposalExample> = []
): string {
  return assembleProposalPrompt(
    [...proposalPromptInstructions, ...backfillEmphasisInstructions],
    rawText,
    existing,
    examples
  );
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
  existing: ReadonlyArray<ExistingRecallItem>
): ProposalDuplicateVerdict {
  const target = normalizeForMatch(proposed.target);
  const useContext = normalizeForMatch(proposed.useContext);

  let sawSameTarget = false;
  for (const item of existing) {
    if (normalizeForMatch(item.target) !== target) {
      continue;
    }
    sawSameTarget = true;
    if (normalizeForMatch(item.useContext ?? "") === useContext) {
      return "same_target_same_context";
    }
  }

  return sawSameTarget ? "same_target_new_context" : "unique";
}
