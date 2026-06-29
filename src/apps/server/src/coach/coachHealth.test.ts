import { describe, expect, it, vi } from "vitest";

import type { CoachConfig } from "./coachConfig.js";
import { checkCoachHealth } from "./coachHealth.js";
import { defaultCostRouting } from "./coachRouter.js";

const model = "llama3.1:8b";

function configWith(overrides: Partial<CoachConfig>): CoachConfig {
  return { apiKey: "sk-test", routing: defaultCostRouting, ...overrides };
}

describe("checkCoachHealth", () => {
  it("reports the fake when no API key is set, without probing the local model", async () => {
    const probeLocalModel = vi.fn(() => Promise.resolve(true));

    const report = await checkCoachHealth({
      config: configWith({ apiKey: undefined }),
      localModel: model,
      probeLocalModel
    });

    expect(report.status).toBe("fake");
    expect(probeLocalModel).not.toHaveBeenCalled();
  });

  it("reports cloud-only when no call is routed to the local tier", async () => {
    const probeLocalModel = vi.fn(() => Promise.resolve(true));

    const report = await checkCoachHealth({
      config: configWith({
        routing: {
          analyze: "strong",
          author: "strong",
          converse: "strong",
          judge: "strong",
          propose: "strong"
        }
      }),
      localModel: model,
      probeLocalModel
    });

    expect(report.status).toBe("cloud_only");
    expect(probeLocalModel).not.toHaveBeenCalled();
  });

  it("reports local_ready when the cheap tier's model is serving", async () => {
    const report = await checkCoachHealth({
      config: configWith({}),
      localModel: model,
      probeLocalModel: (requested) => Promise.resolve(requested === model)
    });

    expect(report.status).toBe("local_ready");
    expect(report.message).toContain(model);
  });

  it("reports local_unavailable with a pull hint when the model is not serving", async () => {
    const report = await checkCoachHealth({
      config: configWith({}),
      localModel: model,
      probeLocalModel: () => Promise.resolve(false)
    });

    expect(report.status).toBe("local_unavailable");
    expect(report.message).toContain(`ollama pull ${model}`);
  });

  it("treats a thrown probe (daemon down) as local_unavailable, never crashing boot", async () => {
    const report = await checkCoachHealth({
      config: configWith({}),
      localModel: model,
      probeLocalModel: () => Promise.reject(new Error("connection refused"))
    });

    expect(report.status).toBe("local_unavailable");
  });
});
