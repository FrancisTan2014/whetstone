import { describe, expect, it, vi } from "vitest";

import type { CoachConfig } from "./coachConfig.js";
import { checkCoachHealth } from "./coachHealth.js";
import { defaultCostRouting } from "./coachRouter.js";

const model = "llama3.1:8b";

function configWith(overrides: Partial<CoachConfig>): CoachConfig {
  return { apiKey: "sk-test", converseModel: model, routing: defaultCostRouting, ...overrides };
}

describe("checkCoachHealth", () => {
  const allStrong = {
    analyze: "strong" as const,
    author: "strong" as const,
    converse: "strong" as const,
    judge: "strong" as const,
    propose: "strong" as const
  };

  it("reports the fake when no key is set and nothing is routed to the local tier", async () => {
    const probeLocalModel = vi.fn(() => Promise.resolve(true));

    const report = await checkCoachHealth({
      config: configWith({ apiKey: undefined, routing: allStrong }),
      localModel: model,
      probeLocalModel
    });

    expect(report.status).toBe("fake");
    expect(probeLocalModel).not.toHaveBeenCalled();
  });

  it("reports cloud-only when a key is set but no call is routed to the local tier", async () => {
    const probeLocalModel = vi.fn(() => Promise.resolve(true));

    const report = await checkCoachHealth({
      config: configWith({ routing: allStrong }),
      localModel: model,
      probeLocalModel
    });

    expect(report.status).toBe("cloud_only");
    expect(probeLocalModel).not.toHaveBeenCalled();
  });

  it("reports local_ready when the cheap tier's model is serving (with a key)", async () => {
    const report = await checkCoachHealth({
      config: configWith({}),
      localModel: model,
      probeLocalModel: (requested) => Promise.resolve(requested === model)
    });

    expect(report.status).toBe("local_ready");
    expect(report.message).toContain(model);
  });

  it("reports local_ready for a keyless coach whose cheap tier is serving", async () => {
    const report = await checkCoachHealth({
      config: configWith({ apiKey: undefined }),
      localModel: model,
      probeLocalModel: (requested) => Promise.resolve(requested === model)
    });

    expect(report.status).toBe("local_ready");
  });

  it("reports local_unavailable with a pull hint when the model is not serving", async () => {
    const report = await checkCoachHealth({
      config: configWith({ apiKey: undefined }),
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

  it("emits pure-ASCII log messages so the Windows console renders them cleanly (#439)", async () => {
    // Cover every status branch — the Windows OEM console mangles any non-ASCII (e.g. an em dash) to
    // mojibake, so each boot/health message that reaches stdout must stay ASCII-only.
    const reports = await Promise.all([
      checkCoachHealth({
        config: configWith({ apiKey: undefined, routing: allStrong }),
        localModel: model,
        probeLocalModel: () => Promise.resolve(true)
      }),
      checkCoachHealth({
        config: configWith({ routing: allStrong }),
        localModel: model,
        probeLocalModel: () => Promise.resolve(true)
      }),
      checkCoachHealth({
        config: configWith({}),
        localModel: model,
        probeLocalModel: () => Promise.resolve(true)
      }),
      checkCoachHealth({
        config: configWith({}),
        localModel: model,
        probeLocalModel: () => Promise.resolve(false)
      })
    ]);

    for (const report of reports) {
      expect([...report.message].every((ch) => (ch.codePointAt(0) ?? 0) <= 127)).toBe(true);
    }
  });
});
