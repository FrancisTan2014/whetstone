import type { Transcription } from "@whetstone/contracts";

// The voice-input (STT) seam (#207): the only thing the practice loop depends on for turning a
// recorded utterance into text + word timings. A local OSS Whisper adapter, a deterministic fake, or
// a future prosody-enriched transcriber can all sit behind it without the loop changing.

// A recorded utterance to transcribe: a path to an audio file already saved on the server. Audio
// never leaves the machine — it is handed to a local transcriber by path.
export type SpeechAudio = Readonly<{
  path: string;
}>;

export interface SpeechInput {
  transcribe(audio: SpeechAudio): Promise<Transcription>;
}
