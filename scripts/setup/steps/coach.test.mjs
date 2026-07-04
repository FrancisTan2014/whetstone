import { describe, expect, it } from "vitest";

import { createFakeContext } from "../testSupport.mjs";
import {
  coachStep,
  isModelPulled,
  parseOllamaModelNames,
  validateOllamaAnswer
} from "./coach.mjs";

const ENV_PATH = "/repo/.env";
const CONVERSE_MODEL = "llama3.1:8b";
const EXPLAIN_MODEL = "qwen2.5";
// The exact non-secret wiring `provision` writes: the local converse + explain models and both tiers
// pinned local.
const WIRED_ENV =
  `COACH_MODEL=${CONVERSE_MODEL}\nEXPLAIN_MODEL=${EXPLAIN_MODEL}\n` +
  "COACH_CONVERSE_TIER=cheap\nCOACH_ANALYZE_TIER=cheap\n";
// The models wired, tiers still to be pinned — isolates the tier-pin branch of the wiring check.
const MODELS_WIRED = `COACH_MODEL=${CONVERSE_MODEL}\nEXPLAIN_MODEL=${EXPLAIN_MODEL}\n`;

// A default handler where Ollama is present, both models are listed, and every model answers; each
// test overrides only the branch it exercises.
function happyExec(command, args) {
  if (command === "ollama" && args[0] === "--version") return { code: 0, stdout: "", stderr: "" };
  if (command === "ollama" && args[0] === "list") {
    return { code: 0, stdout: `${CONVERSE_MODEL}\n${EXPLAIN_MODEL}\n`, stderr: "" };
  }
  if (command === "ollama" && args[0] === "pull") return { code: 0, stdout: "", stderr: "" };
  if (command === "ollama" && args[0] === "run") return { code: 0, stdout: "ok", stderr: "" };
  return { code: 0, stdout: "", stderr: "" };
}

describe("validateOllamaAnswer", () => {
  it("accepts a non-empty answer", () => {
    expect(validateOllamaAnswer("ok")).toEqual({ ok: true });
  });

  it("rejects an empty or whitespace-only answer", () => {
    expect(validateOllamaAnswer("").ok).toBe(false);
    expect(validateOllamaAnswer("   \n ").ok).toBe(false);
  });
});

describe("parseOllamaModelNames", () => {
  it("takes the first column of each row and skips the header", () => {
    const stdout =
      "NAME               ID            SIZE    MODIFIED\n" +
      "llama3.1:8b        abc123        4.7 GB  2 days ago\n" +
      "qwen2.5:latest     def456        4.4 GB  1 hour ago\n";
    expect(parseOllamaModelNames(stdout)).toEqual(["llama3.1:8b", "qwen2.5:latest"]);
  });
});

describe("isModelPulled", () => {
  const listed = `${CONVERSE_MODEL}\nqwen2.5:latest\nqwen2.5-coder:latest\n`;

  it("matches an untagged request against the :latest tag Ollama assigns", () => {
    expect(isModelPulled(listed, "qwen2.5")).toBe(true);
    expect(isModelPulled(listed, "qwen2.5:latest")).toBe(true);
  });

  it("matches a tagged request exactly", () => {
    expect(isModelPulled(listed, CONVERSE_MODEL)).toBe(true);
    expect(isModelPulled(listed, "llama3.1:70b")).toBe(false);
  });

  it("does not treat a name that merely contains the request as pulled", () => {
    // The loose `stdout.includes(model)` bug: qwen2.5-coder must not satisfy qwen2.5.
    expect(isModelPulled("qwen2.5-coder:latest\n", "qwen2.5")).toBe(false);
  });
});

describe("coachStep.check", () => {
  it("reports missing when Ollama is absent, without crashing", () => {
    const { ctx } = createFakeContext({ execHandler: () => ({ code: 1, stdout: "", stderr: "" }) });
    const result = coachStep.check(ctx);
    expect(result.status).toBe("missing");
    expect(result.remedy).toContain("Ollama");
  });

  it("reports missing (with the exact pull) when the coach model is not pulled", () => {
    const { ctx } = createFakeContext({
      execHandler: (command, args) =>
        command === "ollama" && args[0] === "list"
          ? { code: 0, stdout: "some-other-model\n", stderr: "" }
          : { code: 0, stdout: "", stderr: "" }
    });
    const result = coachStep.check(ctx);
    expect(result.status).toBe("missing");
    expect(result.remedy).toContain(`ollama pull ${CONVERSE_MODEL}`);
  });

  it("reports missing when `ollama list` itself fails (models undeterminable)", () => {
    const { ctx } = createFakeContext({
      execHandler: (command, args) => {
        if (command === "ollama" && args[0] === "--version") return { code: 0, stdout: "", stderr: "" };
        if (command === "ollama" && args[0] === "list") return { code: 1, stdout: "", stderr: "daemon down" };
        return { code: 0, stdout: "", stderr: "" };
      }
    });
    expect(coachStep.check(ctx).status).toBe("missing");
  });

  it("reports missing (with the exact pull) when only the explain model is missing", () => {
    const { ctx } = createFakeContext({
      execHandler: (command, args) =>
        command === "ollama" && args[0] === "list"
          ? { code: 0, stdout: `${CONVERSE_MODEL}\n`, stderr: "" }
          : { code: 0, stdout: "", stderr: "" }
    });
    const result = coachStep.check(ctx);
    expect(result.status).toBe("missing");
    expect(result.remedy).toContain(`ollama pull ${EXPLAIN_MODEL}`);
  });

  it("reports missing when EXPLAIN_MODEL is not wired into .env", () => {
    const { ctx } = createFakeContext({ execHandler: happyExec });
    expect(coachStep.check(ctx).what).toContain(".env");
  });

  it("verifies the model .env actually wires, not the default: a mismatched EXPLAIN_MODEL is caught", () => {
    // .env names qwen3, but only the default llama3.1:8b + qwen2.5 are pulled (happyExec). check must
    // derive the model from the runtime-effective .env value and flag qwen3 as not pulled.
    const { ctx } = createFakeContext({
      execHandler: happyExec,
      fileContents: { [ENV_PATH]: "EXPLAIN_MODEL=qwen3\nCOACH_CONVERSE_TIER=cheap\nCOACH_ANALYZE_TIER=cheap\n" }
    });
    const result = coachStep.check(ctx);
    expect(result.status).toBe("missing");
    expect(result.remedy).toContain("ollama pull qwen3");
  });

  it("reports missing when the coach tier pins are absent (analyze would route to strong/fake)", () => {
    const { ctx } = createFakeContext({
      execHandler: happyExec,
      fileContents: { [ENV_PATH]: MODELS_WIRED }
    });
    const result = coachStep.check(ctx);
    expect(result.status).toBe("missing");
    expect(result.what).toContain("COACH_CONVERSE_TIER");
  });

  it("reports missing when a coach tier is pinned to strong instead of cheap", () => {
    const { ctx } = createFakeContext({
      execHandler: happyExec,
      fileContents: {
        [ENV_PATH]: `${MODELS_WIRED}COACH_CONVERSE_TIER=cheap\nCOACH_ANALYZE_TIER=strong\n`
      }
    });
    const result = coachStep.check(ctx);
    expect(result.status).toBe("missing");
    expect(result.what).toContain("COACH_ANALYZE_TIER");
  });

  it("matches pulled models exactly: a `qwen2.5-coder` listing does not satisfy `qwen2.5`", () => {
    // The loose `stdout.includes(model)` bug would treat qwen2.5-coder:latest as qwen2.5.
    const { ctx } = createFakeContext({
      execHandler: (command, args) =>
        command === "ollama" && args[0] === "list"
          ? { code: 0, stdout: `${CONVERSE_MODEL}\nqwen2.5-coder:latest\n`, stderr: "" }
          : happyExec(command, args)
    });
    const result = coachStep.check(ctx);
    expect(result.status).toBe("missing");
    expect(result.remedy).toContain(`ollama pull ${EXPLAIN_MODEL}`);
  });

  it("is ok when Ollama, both models, and .env are all present", () => {
    const { ctx } = createFakeContext({
      execHandler: happyExec,
      fileContents: { [ENV_PATH]: WIRED_ENV }
    });
    expect(coachStep.check(ctx)).toEqual({ status: "ok" });
  });

  it("honors the COACH_MODEL / EXPLAIN_MODEL overrides", () => {
    const { ctx } = createFakeContext({
      env: { COACH_MODEL: "mistral", EXPLAIN_MODEL: "qwen3" },
      execHandler: (command, args) =>
        command === "ollama" && args[0] === "list"
          ? { code: 0, stdout: "nothing\n", stderr: "" }
          : { code: 0, stdout: "", stderr: "" }
    });
    expect(coachStep.check(ctx).remedy).toContain("ollama pull mistral");
  });
});

describe("coachStep.provision", () => {
  it("installs Ollama via winget after consent, then pulls the models and wires .env", () => {
    let ollamaPresent = false;
    const { ctx, confirmCalls, execCalls, files } = createFakeContext({
      platform: "win32",
      confirm: true,
      fileContents: { [ENV_PATH]: "# EXPLAIN_MODEL=\n# COACH_CONVERSE_TIER=cheap\n# COACH_ANALYZE_TIER=strong\n" },
      execHandler: (command, args) => {
        if (command === "ollama" && args[0] === "--version") {
          return { code: ollamaPresent ? 0 : 1, stdout: "", stderr: "" };
        }
        if (command === "winget" && args[0] === "--version") return { code: 0, stdout: "", stderr: "" };
        if (command === "winget" && args[0] === "install") {
          ollamaPresent = true;
          return { code: 0, stdout: "", stderr: "" };
        }
        return happyExec(command, args);
      }
    });
    expect(coachStep.provision(ctx)).toEqual({ status: "ok" });
    expect(confirmCalls).toContain("Install Ollama now? [Y/n]");
    expect(execCalls).toContainEqual(["winget", "install", "Ollama.Ollama"]);
    expect(execCalls).toContainEqual(["ollama", "pull", CONVERSE_MODEL]);
    expect(execCalls).toContainEqual(["ollama", "pull", EXPLAIN_MODEL]);
    const env = files.get(ENV_PATH);
    expect(env).toContain(`COACH_MODEL=${CONVERSE_MODEL}`);
    expect(env).toContain(`EXPLAIN_MODEL=${EXPLAIN_MODEL}`);
    expect(env).toContain("COACH_CONVERSE_TIER=cheap");
    expect(env).toContain("COACH_ANALYZE_TIER=cheap");
    expect(env).not.toContain("COACH_API_KEY");
  });

  it("win32: surfaces the accurate stale-PATH remedy (not `ollama serve`) when a fresh install is unresolved (#423)", () => {
    // #423: winget installs Ollama, but the running process's PATH is stale, so `ollama` stays
    // unresolved even after the refresh. provision must surface installSystemTool's accurate
    // "open a new terminal" remedy and NEVER reach the misleading `ollama serve` pull-failure hint.
    const { ctx, execCalls } = createFakeContext({
      platform: "win32",
      confirm: true,
      execHandler: (command, args) => {
        if (command === "ollama" && args[0] === "--version") return { code: 1, stdout: "", stderr: "" };
        if (command === "winget" && args[0] === "--version") return { code: 0, stdout: "", stderr: "" };
        if (command === "winget" && args[0] === "install") return { code: 0, stdout: "", stderr: "" };
        return { code: 1, stdout: "", stderr: "" };
      }
    });
    const result = coachStep.provision(ctx);
    expect(result.status).toBe("missing");
    expect(result.what).toContain("was installed but is not on this terminal's PATH");
    expect(result.remedy).toContain("Open a new terminal");
    expect(result.remedy).not.toContain("ollama serve");
    // It must not blindly proceed to pull a tool it cannot resolve.
    expect(execCalls).not.toContainEqual(["ollama", "pull", CONVERSE_MODEL]);
  });

  it("falls back to the instruct-only remedy when consent is declined (no install/pull)", () => {
    const { ctx, confirmCalls, execCalls } = createFakeContext({
      platform: "win32",
      confirm: false,
      execHandler: (command, args) => {
        if (command === "winget" && args[0] === "--version") return { code: 0, stdout: "", stderr: "" };
        return { code: 1, stdout: "", stderr: "" }; // ollama absent
      }
    });
    const result = coachStep.provision(ctx);
    expect(result.status).toBe("missing");
    expect(result.remedy).toContain("Ollama");
    expect(confirmCalls).toEqual(["Install Ollama now? [Y/n]"]);
    expect(execCalls).not.toContainEqual(["ollama", "pull", CONVERSE_MODEL]);
  });

  it("falls back to the instruct-only remedy when no package manager is available", () => {
    const { ctx, confirmCalls } = createFakeContext({
      platform: "win32",
      confirm: true,
      execHandler: () => ({ code: 1, stdout: "", stderr: "" })
    });
    expect(coachStep.provision(ctx).status).toBe("missing");
    expect(confirmCalls).toEqual([]); // never asked — nothing to install with
  });

  it("maps a failing `ollama pull` to an actionable error that names the model", () => {
    const { ctx } = createFakeContext({
      execHandler: (command, args) =>
        command === "ollama" && args[0] === "pull"
          ? { code: 1, stdout: "", stderr: "connection reset" }
          : happyExec(command, args)
    });
    const result = coachStep.provision(ctx);
    expect(result.status).toBe("error");
    expect(result.what).toContain(`"${CONVERSE_MODEL}"`);
    expect(result.remedy).toContain("connection reset");
  });

  it("scaffolds .env from scratch when it does not exist", () => {
    const { ctx, files } = createFakeContext({ execHandler: happyExec });
    expect(coachStep.provision(ctx)).toEqual({ status: "ok" });
    expect(files.get(ENV_PATH)).toContain(`EXPLAIN_MODEL=${EXPLAIN_MODEL}`);
  });
});

describe("coachStep.verify", () => {
  const wired = { [ENV_PATH]: WIRED_ENV };

  it("errors when .env is not wired after provisioning", () => {
    const { ctx } = createFakeContext();
    expect(coachStep.verify(ctx).what).toContain("COACH_MODEL");
  });

  it("errors when the coach tiers are not wired after provisioning", () => {
    const { ctx } = createFakeContext({
      fileContents: { [ENV_PATH]: MODELS_WIRED },
      execHandler: happyExec
    });
    const result = coachStep.verify(ctx);
    expect(result.status).toBe("error");
    expect(result.what).toContain("COACH_CONVERSE_TIER");
  });

  it("errors when a process-env EXPLAIN_MODEL override diverges from the wired .env value", () => {
    // COACH_MODEL matches .env, but the runtime-effective EXPLAIN_MODEL (process-env override) is not
    // what .env wires — the runtime would serve qwen3 while .env still names qwen2.5. Must be caught.
    const { ctx } = createFakeContext({
      env: { EXPLAIN_MODEL: "qwen3" },
      fileContents: { [ENV_PATH]: WIRED_ENV },
      execHandler: happyExec
    });
    const result = coachStep.verify(ctx);
    expect(result.status).toBe("error");
    expect(result.what).toContain("EXPLAIN_MODEL=qwen3");
  });

  it("errors when a model does not answer (non-zero)", () => {
    const { ctx } = createFakeContext({
      fileContents: wired,
      execHandler: (command, args) =>
        command === "ollama" && args[0] === "run"
          ? { code: 1, stdout: "", stderr: "no such model" }
          : happyExec(command, args)
    });
    expect(coachStep.verify(ctx).what).toContain("did not answer");
  });

  it("errors when a model answers off-contract (empty response)", () => {
    const { ctx } = createFakeContext({
      fileContents: wired,
      execHandler: (command, args) =>
        command === "ollama" && args[0] === "run"
          ? { code: 0, stdout: "  \n ", stderr: "" }
          : happyExec(command, args)
    });
    expect(coachStep.verify(ctx).what).toContain("off-contract");
  });

  it("is ok when both models answer through the daemon", () => {
    const { ctx } = createFakeContext({ fileContents: wired, execHandler: happyExec });
    expect(coachStep.verify(ctx)).toEqual({ status: "ok" });
  });
});
