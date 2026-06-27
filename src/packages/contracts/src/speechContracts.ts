import { z } from "zod";

// Shared, Zod-validated shapes for the voice-input (STT) seam (#207): the transcript + word timings a
// transcriber returns, and the derived timing signal (latency + inter-word pauses). The loop depends
// only on these shapes, so the real Whisper adapter and the fake are interchangeable, and prosody can
// plug in later without touching consumers.

function isNonBlank(value: string): boolean {
  return value.trim().length > 0;
}

// One transcribed word with its start/end offset in milliseconds from the start of the recording.
export const transcribedWordSchema = z
  .object({
    end: z.number().int().min(0),
    start: z.number().int().min(0),
    text: z.string().refine(isNonBlank, { message: "text must be non-empty." })
  })
  .strict();

export type TranscribedWord = z.infer<typeof transcribedWordSchema>;

// A transcription: the full transcript plus the per-word timings that back the automaticity signal.
export const transcriptionSchema = z
  .object({
    transcript: z.string(),
    words: z.array(transcribedWordSchema)
  })
  .strict();

export type Transcription = z.infer<typeof transcriptionSchema>;

// The derived timing signal: response latency and the inter-word pauses (all milliseconds). Mirrors
// `SpeechTiming` in `@whetstone/domain` (`speechTiming.ts`), which owns the pure derivation.
export const speechTimingSchema = z
  .object({
    interWordPauses: z.array(z.number().int()),
    latencyMs: z.number().int(),
    totalDurationMs: z.number().int()
  })
  .strict();

export type SpeechTimingDto = z.infer<typeof speechTimingSchema>;

export function parseTranscription(value: unknown): Transcription {
  return transcriptionSchema.parse(value);
}
