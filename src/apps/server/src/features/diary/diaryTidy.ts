import { buildDiaryTidyPrompt } from "@whetstone/domain";

import type { ChatModel } from "../../coach/llmCoach.js";

// The diary "tidy" seam (#246): a transcript in, the tidied entry out. The real implementation wraps an
// LLM `ChatModel` (the same Ollama boundary the coach uses) with the tidy-not-polish prompt; tests inject
// a deterministic fake. Kept as an injected dependency so the diary command stays pure and testable.
export type DiaryTidy = (transcript: string) => Promise<string>;

// Wrap a chat model as a diary tidier: build the tidy prompt, call the model, and trim the reply. If the
// model returns nothing usable (blank), fall back to the raw transcript so a flaky model never empties an
// entry — the worst case is an un-tidied but faithful entry, which still honors "preserve the wording".
export function createDiaryTidy(chat: ChatModel): DiaryTidy {
  return async (transcript) => {
    const tidied = (await chat(buildDiaryTidyPrompt(transcript))).trim();
    return tidied.length > 0 ? tidied : transcript;
  };
}
