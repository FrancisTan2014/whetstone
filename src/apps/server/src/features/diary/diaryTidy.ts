import { buildDiaryTidyPrompt, isFaithfulTidy } from "@whetstone/domain";

import type { LlmModel } from "../../llm/llmModel.js";

// The diary "tidy" seam (#246): a transcript in, the tidied entry out. The real implementation wraps the
// shared `LlmModel` seam (#385) with the tidy-not-polish prompt; tests inject a deterministic fake. Kept
// as an injected dependency so the diary command stays pure and testable.
export type DiaryTidy = (transcript: string) => Promise<string>;

// Wrap a chat model as a diary tidier: build the tidy prompt, call the model, and trim the reply. Tidy
// must NEVER make capture fail and must NEVER rewrite the learner's wording. So fall back to the raw
// transcript when the model is unavailable (Ollama down / not pulled), the request errors, the reply is
// blank, OR the reply is not a faithful tidy — one that only drops/reorders the learner's own words
// (`isFaithfulTidy`). A local model can ignore the prompt and upgrade vocabulary / rephrase (#462); the
// deterministic guard catches that. The worst case is an un-tidied but faithful entry — which still
// honors "preserve the wording" — never a lost or silently rewritten entry (#246).
export function createDiaryTidy(chat: LlmModel): DiaryTidy {
  return async (transcript) => {
    let tidied: string;

    try {
      tidied = (await chat(buildDiaryTidyPrompt(transcript))).trim();
    } catch {
      return transcript;
    }

    if (tidied.length === 0 || !isFaithfulTidy(transcript, tidied)) {
      return transcript;
    }

    return tidied;
  };
}
