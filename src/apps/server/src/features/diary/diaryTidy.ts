import { buildDiaryTidyPrompt, isFaithfulTidy } from "@whetstone/domain";

import type { DiaryTidyConfig } from "../../llm/aiUtilityConfig.js";
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

export type DiaryTidyDependencies = Readonly<{
  // A model backed by the local agent seam (#906), set only when a local agent CLI is configured
  // (`AGENT_BINARY` + `AGENT_MODEL`). It takes precedence over the Ollama model below, because an agent
  // CLI is what makes tidy reachable on a machine with no room for a resident local LLM. Explicitly
  // `| undefined` so the composition root can pass the result of "is an agent configured?" directly,
  // under `exactOptionalPropertyTypes`.
  agentModel?: LlmModel | undefined;
  config: DiaryTidyConfig;
  createModel?: (modelName: string) => LlmModel;
}>;

// Which backend serves tidy. Reported at boot next to the model's own health so an operator can tell
// which one is in use, rather than reading a model line while an agent is quietly doing the work.
// "model" covers the local Ollama model AND the no-model case: with no model name, that backend is
// simply off and tidy keeps the raw transcript.
export type DiaryTidyBackend = "agent" | "model";

// The one precedence rule, as data: a configured local agent CLI wins over the local Ollama model.
// `resolveDiaryTidy` follows exactly this order, so the boot report can never disagree with what the
// worker actually calls.
export function selectDiaryTidyBackend(dependencies: DiaryTidyDependencies): DiaryTidyBackend {
  return dependencies.agentModel === undefined ? "model" : "agent";
}

// Resolve the diary tidier from config: the agent-backed model when a local agent CLI is configured;
// otherwise the real local-model tidier when BOTH a model is configured (`DIARY_TIDY_MODEL`, or the
// `COACH_MODEL` alias) and a model factory is wired; otherwise an identity tidier that returns the
// transcript unchanged. So with neither configured — the deterministic base install — a diary capture is
// saved verbatim (faithful, never faked) with no agent and no Ollama call, exactly like the
// "unavailable" explanation aid. Mirrors `resolveExplainer` (#341) so both optional AI utilities share
// one absent-config-safe resolution shape, independent of the retiring coach.
export function resolveDiaryTidy(dependencies: DiaryTidyDependencies): DiaryTidy {
  const { agentModel, config, createModel } = dependencies;

  // Precedence, in one place: a configured local agent CLI wins. `selectDiaryTidyBackend` reports this
  // same order to the boot log, and a test pins the two together.
  if (agentModel !== undefined) {
    return createDiaryTidy(agentModel);
  }

  if (config.modelName === undefined || createModel === undefined) {
    return (transcript) => Promise.resolve(transcript);
  }

  return createDiaryTidy(createModel(config.modelName));
}
