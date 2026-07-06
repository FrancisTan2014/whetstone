import { describe, expect, it, vi } from "vitest";

import type { ProposalGeneration } from "@whetstone/contracts";

import type { LlmModel } from "../../llm/llmModel.js";
import { createProposalProvider } from "./proposalProvider.js";

const validGeneration: ProposalGeneration = {
  candidates: [
    {
      type: "phrase_chunk",
      confidence: 0.9,
      reason: "a reusable status phrase",
      evidenceQuote: "back up now",
      payload: {
        target: "WorkInsight is back up now",
        cue: "a service is back",
        useContext: "reporting availability",
        category: "work",
        tags: ["service-status"]
      }
    }
  ]
};

function modelReturning(text: string): LlmModel {
  return vi.fn(async () => text);
}

const noExisting: ReadonlyArray<{ target: string; useContext: string | null }> = [];

describe("createProposalProvider", () => {
  it("asks the model for JSON and returns the validated generation", async () => {
    const chat = modelReturning(JSON.stringify(validGeneration));
    const provider = createProposalProvider(chat, "llama3.1");

    const result = await provider("I couldn't say the service is back up now", noExisting);

    expect(result).toEqual({ generation: validGeneration, modelName: "llama3.1" });
    expect(chat).toHaveBeenCalledWith(expect.stringContaining("Capture:"), { json: true });
  });

  it("threads the retrieved recall context into the prompt (retrieve-before-generate)", async () => {
    const chat = modelReturning(JSON.stringify(validGeneration));
    const provider = createProposalProvider(chat, "llama3.1");

    await provider("the service came back", [
      { target: "It's back up now", useContext: "reporting availability" }
    ]);

    const prompt = (chat as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(prompt).toContain("Already remembered:");
    expect(prompt).toContain("It's back up now");
  });

  it("passes through an empty candidates array (no proposal)", async () => {
    const provider = createProposalProvider(modelReturning('{"candidates":[]}'), "llama3.1");

    expect(await provider("nothing notable here", noExisting)).toEqual({
      generation: { candidates: [] },
      modelName: "llama3.1"
    });
  });

  it("returns null when the model call throws (daemon down / timeout)", async () => {
    const provider = createProposalProvider(() => Promise.reject(new Error("ECONNREFUSED")), "m");

    expect(await provider("x", noExisting)).toBeNull();
  });

  it("returns null when the reply is not valid JSON", async () => {
    const provider = createProposalProvider(modelReturning("not json at all"), "m");

    expect(await provider("x", noExisting)).toBeNull();
  });

  it("returns null when the JSON does not match the schema", async () => {
    const provider = createProposalProvider(
      modelReturning('{"candidates":[{"type":"phrase_chunk"}]}'),
      "m"
    );

    expect(await provider("x", noExisting)).toBeNull();
  });

  it("returns null when the model emits more than one candidate", async () => {
    const two = JSON.stringify({
      candidates: [validGeneration.candidates[0], validGeneration.candidates[0]]
    });
    const provider = createProposalProvider(modelReturning(two), "m");

    expect(await provider("x", noExisting)).toBeNull();
  });
});
