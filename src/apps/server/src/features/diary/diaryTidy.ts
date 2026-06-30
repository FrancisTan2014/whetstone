import { buildDiaryTidyPrompt } from "@whetstone/domain";

import type { ChatModel } from "../../coach/llmCoach.js";

// The diary "tidy" seam (#246): a transcript in, the tidied entry out. The real implementation wraps an
// LLM `ChatModel` (the same Ollama boundary the coach uses) with the tidy-not-polish prompt; tests inject
// a deterministic fake. Kept as an injected dependency so the diary command stays pure and testable.
export type DiaryTidy = (transcript: string) => Promise<string>;

// Wrap a chat model as a diary tidier: build the tidy prompt, call the model, and trim the reply. Tidy
// must NEVER make capture fail: if the model is unavailable (Ollama down / not pulled), the request
// errors, or the reply is blank, fall back to the raw transcript. The worst case is an un-tidied but
// faithful entry — which still honors "preserve the wording" — never a lost entry (#246).
export function createDiaryTidy(chat: ChatModel): DiaryTidy {
  return async (transcript) => {
    let tidied: string;

    try {
      tidied = (await chat(buildDiaryTidyPrompt(transcript))).trim();
    } catch {
      return transcript;
    }

    return tidied.length > 0 ? tidied : transcript;
  };
}
