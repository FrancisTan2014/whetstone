import { z } from "zod";

// Shared, Zod-validated shapes for the voice-input (STT) seam (#207): the transcript + word timings a
// transcriber returns. The voice-diary capture depends only on these shapes, so the real Whisper
// adapter and the fake are interchangeable.

function isNonBlank(value: string): boolean {
  return value.trim().length > 0;
}

// One transcribed word with its start/end offset in milliseconds from the start of the recording.
// `end >= start` is enforced so a Transcription can never carry an impossible (end-before-start) word.
export const transcribedWordSchema = z
  .object({
    end: z.number().int().min(0),
    start: z.number().int().min(0),
    text: z.string().refine(isNonBlank, { message: "text must be non-empty." })
  })
  .strict()
  .refine((word) => word.end >= word.start, {
    message: "end must be greater than or equal to start."
  });

export type TranscribedWord = z.infer<typeof transcribedWordSchema>;

// A transcription: the full transcript, the per-word timings, and the language the provider detected for
// the utterance. `transcript` is the required, transcript-first payload. `words` is *optional evidence*:
// token timings are an empty array when the provider has no aligner, and a valid transcript is never
// failed merely because timings are unavailable (#799). `language` is the provider's automatic detection
// (there is no forced-language override, #647); it is informational only and is null when none was
// reported, so a missing detection never fails or rewrites the transcript.
export const transcriptionSchema = z
  .object({
    language: z.string().nullable(),
    transcript: z.string(),
    words: z.array(transcribedWordSchema)
  })
  .strict();

export type Transcription = z.infer<typeof transcriptionSchema>;

export function parseTranscription(value: unknown): Transcription {
  return transcriptionSchema.parse(value);
}
