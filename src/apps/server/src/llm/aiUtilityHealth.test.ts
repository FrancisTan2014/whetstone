import { describe, expect, it, vi } from "vitest";

import { checkAiUtilityHealth } from "./aiUtilityHealth.js";

describe("checkAiUtilityHealth", () => {
  it("reports disabled with the setup hint when no model is configured, without probing", async () => {
    const probeModel = vi.fn(async () => true);

    const report = await checkAiUtilityHealth({
      label: "Diary tidy",
      modelName: undefined,
      probeModel,
      setupHint: "pnpm setup:ai"
    });

    expect(report.status).toBe("disabled");
    expect(report.message).toContain("Diary tidy is off");
    expect(report.message).toContain("pnpm setup:ai");
    expect(probeModel).not.toHaveBeenCalled();
  });

  it("reports ready and names the model when the probe succeeds", async () => {
    const report = await checkAiUtilityHealth({
      label: "AI 解释",
      modelName: "qwen2.5",
      probeModel: async () => true,
      setupHint: "pnpm setup:ai"
    });

    expect(report).toEqual({ message: "AI 解释 model qwen2.5 is serving.", status: "ready" });
  });

  it("reports unavailable with an actionable pull/setup hint when the probe returns false", async () => {
    const report = await checkAiUtilityHealth({
      label: "Diary tidy",
      modelName: "llama3.1:8b",
      probeModel: async () => false,
      setupHint: "pnpm setup:ai"
    });

    expect(report.status).toBe("unavailable");
    expect(report.message).toContain("ollama pull llama3.1:8b");
    expect(report.message).toContain("pnpm setup:ai");
  });

  it("treats a thrown probe (daemon down) as unavailable rather than crashing boot", async () => {
    const report = await checkAiUtilityHealth({
      label: "Diary tidy",
      modelName: "llama3.1:8b",
      probeModel: async () => {
        throw new Error("ECONNREFUSED");
      },
      setupHint: "pnpm setup:ai"
    });

    expect(report.status).toBe("unavailable");
  });
});
