// Pure derivation of the basic automaticity signal from word timings (#207): response latency (how
// long before the learner started speaking) and the inter-word pauses (hesitation between words).
// No audio, model, or I/O — it reads only the word boundaries a transcriber produced, so it is
// identical for the real Whisper adapter and the fake. Pronunciation/prosody scoring is out of scope.

// The minimal timing shape a derivation needs: each word's start and end offset, in milliseconds from
// the start of the recording.
export type WordBoundary = Readonly<{
  end: number;
  start: number;
}>;

export type SpeechTiming = Readonly<{
  // Milliseconds from the start of the recording to the first word — the response latency.
  latencyMs: number;
  // Gap before each word after the first (word[i].start - word[i-1].end), clamped at 0 so an
  // overlap never reads as a negative pause. Length is words.length - 1 (empty for 0 or 1 word).
  interWordPauses: ReadonlyArray<number>;
  // First word start to last word end — the spoken span the pauses sit within.
  totalDurationMs: number;
}>;

const empty: SpeechTiming = Object.freeze({
  interWordPauses: Object.freeze([]),
  latencyMs: 0,
  totalDurationMs: 0
});

export function deriveSpeechTiming(words: ReadonlyArray<WordBoundary>): SpeechTiming {
  const first = words[0];
  const last = words[words.length - 1];

  if (first === undefined || last === undefined) {
    return empty;
  }

  const interWordPauses: number[] = [];
  let previousEnd = first.end;
  for (const word of words.slice(1)) {
    interWordPauses.push(Math.max(0, word.start - previousEnd));
    previousEnd = word.end;
  }

  return {
    interWordPauses,
    latencyMs: first.start,
    totalDurationMs: last.end - first.start
  };
}
