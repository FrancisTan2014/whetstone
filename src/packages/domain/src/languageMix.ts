// The bilingual language-mix dial (#270): a near-beginner talks day one in whatever EN/L1 mix they
// can, and the coach meets them in that mix while always pushing some English — the level emerges
// from the English<->L1 ratio, not a fixed band gate. All pure: the English-share metric and the
// allowed-L1-share derivation are deterministic functions of text/state, unit-testable with no I/O.

// The learner's first language for the mix. "none" is an English-only learner (no L1 allowed — the
// dial is off and behaviour is unchanged). More L1s can be added without touching the derivation.
export const l1Languages = ["none", "zh"] as const;
export type L1Language = (typeof l1Languages)[number];

// CJK ideographs (Chinese) vs. Latin letters (English) — the two scripts the share metric scores. Other
// characters (digits, punctuation, spaces) are ignored so they don't skew the ratio.
const cjkPattern = /[\u3400-\u4dbf\u4e00-\u9fff]/g;
const latinPattern = /[A-Za-z]/g;

// The English share of a turn: Latin letters over Latin+CJK letters, in [0, 1]. This is the level
// signal — a rising share over rounds is progress. A turn with no scorable letters (digits/punctuation
// only, or empty) counts as fully English (1), so it never drags the trend toward L1.
export function englishShare(text: string): number {
  const latin = (text.match(latinPattern) ?? []).length;
  const cjk = (text.match(cjkPattern) ?? []).length;
  const total = latin + cjk;

  return total === 0 ? 1 : latin / total;
}

// The coach never goes fully L1 — it always pushes some English (pushed output), so L1 is a bridge,
// not a comfort trap. This caps how much L1 the dial ever allows in a round.
export const MAX_L1_SHARE = 0.7;

// The L1 share the coach is briefed to allow this round: 0 for an English-only learner (dial off), or
// — for an L1 learner — the inverse of their current English share, capped at `MAX_L1_SHARE`. As the
// learner's English share rises, the allowed L1 shrinks, pulling the conversation toward English.
export function targetL1Share(l1: L1Language, englishShareValue: number): number {
  if (l1 === "none") {
    return 0;
  }

  return Math.max(0, Math.min(MAX_L1_SHARE, 1 - englishShareValue));
}
