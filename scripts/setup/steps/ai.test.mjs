import { describe, expect, it } from "vitest";

import { createFakeContext } from "../testSupport.mjs";
import { aiStep, isModelPulled, parseOllamaModelNames, validateOllamaAnswer } from "./ai.mjs";

const ENV_PATH = "/repo/.env";
const DIARY_TIDY_MODEL = "llama3.1:8b";
const EXPLAIN_MODEL = "qwen2.5";
// The exact non-secret wiring `provision` writes: the local diary-tidy + explain model names. No coach
// tiers, no keys — the utilities are local-only and decoupled from the coach (#602).
const WIRED_ENV = `DIARY_TIDY_MODEL=${DIARY_TIDY_MODEL}\nEXPLAIN_MODEL=${EXPLAIN_MODEL}\n`;
// Only the diary-tidy model wired — isolates the EXPLAIN_MODEL branch of the wiring check.
const DIARY_ONLY = `DIARY_TIDY_MODEL=${DIARY_TIDY_MODEL}\n`;

// A default handler where Ollama is present, both models are listed, and every model answers; each
// test overrides only the branch it exercises.
function happyExec(command, args) {
  if (command === "ollama" && args[0] === "--version") return { code: 0, stdout: "", stderr: "" };
  if (command === "ollama" && args[0] === "list") {
    return { code: 0, stdout: `${DIARY_TIDY_MODEL}\n${EXPLAIN_MODEL}\n`, stderr: "" };
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
  const listed = `${DIARY_TIDY_MODEL}\nqwen2.5:latest\nqwen2.5-coder:latest\n`;

  it("matches an untagged request against the :latest tag Ollama assigns", () => {
    expect(isModelPulled(listed, "qwen2.5")).toBe(true);
    expect(isModelPulled(listed, "qwen2.5:latest")).toBe(true);
  });

  it("matches a tagged request exactly", () => {
    expect(isModelPulled(listed, DIARY_TIDY_MODEL)).toBe(true);
    expect(isModelPulled(listed, "llama3.1:70b")).toBe(false);
  });

  it("does not treat a name that merely contains the request as pulled", () => {
    // The loose `stdout.includes(model)` bug: qwen2.5-coder must not satisfy qwen2.5.
    expect(isModelPulled("qwen2.5-coder:latest\n", "qwen2.5")).toBe(false);
  });
});

describe("aiStep.check", () => {
  it("reports missing when Ollama is absent, without crashing", () => {
    const { ctx } = createFakeContext({ execHandler: () => ({ code: 1, stdout: "", stderr: "" }) });
    const result = aiStep.check(ctx);
    expect(result.status).toBe("missing");
    expect(result.remedy).toContain("Ollama");
  });

  it("reports missing (with the exact pull) when the diary tidy model is not pulled", () => {
    const { ctx } = createFakeContext({
      execHandler: (command, args) =>
        command === "ollama" && args[0] === "list"
          ? { code: 0, stdout: "some-other-model\n", stderr: "" }
          : { code: 0, stdout: "", stderr: "" }
    });
    const result = aiStep.check(ctx);
    expect(result.status).toBe("missing");
    expect(result.remedy).toContain(`ollama pull ${DIARY_TIDY_MODEL}`);
  });

  it("reports missing when `ollama list` itself fails (models undeterminable)", () => {
    const { ctx } = createFakeContext({
      execHandler: (command, args) => {
        if (command === "ollama" && args[0] === "--version") return { code: 0, stdout: "", stderr: "" };
        if (command === "ollama" && args[0] === "list") return { code: 1, stdout: "", stderr: "daemon down" };
        return { code: 0, stdout: "", stderr: "" };
      }
    });
    expect(aiStep.check(ctx).status).toBe("missing");
  });

  it("reports missing (with the exact pull) when only the explain model is missing", () => {
    const { ctx } = createFakeContext({
      execHandler: (command, args) =>
        command === "ollama" && args[0] === "list"
          ? { code: 0, stdout: `${DIARY_TIDY_MODEL}\n`, stderr: "" }
          : { code: 0, stdout: "", stderr: "" }
    });
    const result = aiStep.check(ctx);
    expect(result.status).toBe("missing");
    expect(result.remedy).toContain(`ollama pull ${EXPLAIN_MODEL}`);
  });

  it("reports missing when DIARY_TIDY_MODEL is not wired into .env", () => {
    const { ctx } = createFakeContext({ execHandler: happyExec });
    const result = aiStep.check(ctx);
    expect(result.status).toBe("missing");
    expect(result.what).toContain("DIARY_TIDY_MODEL");
  });

  it("reports missing when EXPLAIN_MODEL is not wired into .env", () => {
    const { ctx } = createFakeContext({
      execHandler: happyExec,
      fileContents: { [ENV_PATH]: DIARY_ONLY }
    });
    const result = aiStep.check(ctx);
    expect(result.status).toBe("missing");
    expect(result.what).toContain("EXPLAIN_MODEL");
  });

  it("verifies the model .env actually wires, not the default: a mismatched EXPLAIN_MODEL is caught", () => {
    // .env names qwen3, but only the defaults llama3.1:8b + qwen2.5 are pulled (happyExec). check must
    // derive the model from the runtime-effective .env value and flag qwen3 as not pulled.
    const { ctx } = createFakeContext({
      execHandler: happyExec,
      fileContents: { [ENV_PATH]: `DIARY_TIDY_MODEL=${DIARY_TIDY_MODEL}\nEXPLAIN_MODEL=qwen3\n` }
    });
    const result = aiStep.check(ctx);
    expect(result.status).toBe("missing");
    expect(result.remedy).toContain("ollama pull qwen3");
  });

  it("matches pulled models exactly: a `qwen2.5-coder` listing does not satisfy `qwen2.5`", () => {
    // The loose `stdout.includes(model)` bug would treat qwen2.5-coder:latest as qwen2.5.
    const { ctx } = createFakeContext({
      execHandler: (command, args) =>
        command === "ollama" && args[0] === "list"
          ? { code: 0, stdout: `${DIARY_TIDY_MODEL}\nqwen2.5-coder:latest\n`, stderr: "" }
          : happyExec(command, args)
    });
    const result = aiStep.check(ctx);
    expect(result.status).toBe("missing");
    expect(result.remedy).toContain(`ollama pull ${EXPLAIN_MODEL}`);
  });

  it("is ok when Ollama, both models, and .env are all present", () => {
    const { ctx } = createFakeContext({
      execHandler: happyExec,
      fileContents: { [ENV_PATH]: WIRED_ENV }
    });
    expect(aiStep.check(ctx)).toEqual({ status: "ok" });
  });

  it("honors the DIARY_TIDY_MODEL / EXPLAIN_MODEL overrides", () => {
    const { ctx } = createFakeContext({
      env: { DIARY_TIDY_MODEL: "mistral", EXPLAIN_MODEL: "qwen3" },
      execHandler: (command, args) =>
        command === "ollama" && args[0] === "list"
          ? { code: 0, stdout: "nothing\n", stderr: "" }
          : { code: 0, stdout: "", stderr: "" }
    });
    expect(aiStep.check(ctx).remedy).toContain("ollama pull mistral");
  });
});

describe("aiStep.provision", () => {
  it("installs Ollama via winget after consent, then pulls the models and wires .env", () => {
    let ollamaPresent = false;
    const { ctx, confirmCalls, execCalls, files } = createFakeContext({
      platform: "win32",
      confirm: true,
      fileContents: { [ENV_PATH]: "# DIARY_TIDY_MODEL=\n# EXPLAIN_MODEL=\n" },
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
    expect(aiStep.provision(ctx)).toEqual({ status: "ok" });
    expect(confirmCalls).toContain("Install Ollama now? [Y/n]");
    expect(execCalls).toContainEqual(["winget", "install", "Ollama.Ollama"]);
    expect(execCalls).toContainEqual(["ollama", "pull", DIARY_TIDY_MODEL]);
    expect(execCalls).toContainEqual(["ollama", "pull", EXPLAIN_MODEL]);
    const env = files.get(ENV_PATH);
    expect(env).toContain(`DIARY_TIDY_MODEL=${DIARY_TIDY_MODEL}`);
    expect(env).toContain(`EXPLAIN_MODEL=${EXPLAIN_MODEL}`);
    // Never writes a key or a coach tier — the utilities are local-only and coach-independent.
    expect(env).not.toContain("COACH_API_KEY");
    expect(env).not.toContain("COACH_CONVERSE_TIER");
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
    const result = aiStep.provision(ctx);
    expect(result.status).toBe("missing");
    expect(result.what).toContain("was installed but is not on this terminal's PATH");
    expect(result.remedy).toContain("Open a new terminal");
    expect(result.remedy).not.toContain("ollama serve");
    // It must not blindly proceed to pull a tool it cannot resolve.
    expect(execCalls).not.toContainEqual(["ollama", "pull", DIARY_TIDY_MODEL]);
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
    const result = aiStep.provision(ctx);
    expect(result.status).toBe("missing");
    expect(result.remedy).toContain("Ollama");
    expect(confirmCalls).toEqual(["Install Ollama now? [Y/n]"]);
    expect(execCalls).not.toContainEqual(["ollama", "pull", DIARY_TIDY_MODEL]);
  });

  it("falls back to the instruct-only remedy when no package manager is available", () => {
    const { ctx, confirmCalls } = createFakeContext({
      platform: "win32",
      confirm: true,
      execHandler: () => ({ code: 1, stdout: "", stderr: "" })
    });
    expect(aiStep.provision(ctx).status).toBe("missing");
    expect(confirmCalls).toEqual([]); // never asked — nothing to install with
  });

  it("maps a failing `ollama pull` to an actionable error that names the model", () => {
    const { ctx } = createFakeContext({
      execHandler: (command, args) =>
        command === "ollama" && args[0] === "pull"
          ? { code: 1, stdout: "", stderr: "connection reset" }
          : happyExec(command, args)
    });
    const result = aiStep.provision(ctx);
    expect(result.status).toBe("error");
    expect(result.what).toContain(`"${DIARY_TIDY_MODEL}"`);
    expect(result.remedy).toContain("connection reset");
  });

  it("scaffolds .env from scratch when it does not exist", () => {
    const { ctx, files } = createFakeContext({ execHandler: happyExec });
    expect(aiStep.provision(ctx)).toEqual({ status: "ok" });
    expect(files.get(ENV_PATH)).toContain(`EXPLAIN_MODEL=${EXPLAIN_MODEL}`);
  });
});

describe("aiStep.verify", () => {
  const wired = { [ENV_PATH]: WIRED_ENV };

  it("errors when .env is not wired after provisioning", () => {
    const { ctx } = createFakeContext();
    expect(aiStep.verify(ctx).what).toContain("DIARY_TIDY_MODEL");
  });

  it("errors when a process-env EXPLAIN_MODEL override diverges from the wired .env value", () => {
    // DIARY_TIDY_MODEL matches .env, but the runtime-effective EXPLAIN_MODEL (process-env override) is
    // not what .env wires — the runtime would serve qwen3 while .env still names qwen2.5. Must be caught.
    const { ctx } = createFakeContext({
      env: { EXPLAIN_MODEL: "qwen3" },
      fileContents: { [ENV_PATH]: WIRED_ENV },
      execHandler: happyExec
    });
    const result = aiStep.verify(ctx);
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
    expect(aiStep.verify(ctx).what).toContain("did not answer");
  });

  it("errors when a model answers off-contract (empty response)", () => {
    const { ctx } = createFakeContext({
      fileContents: wired,
      execHandler: (command, args) =>
        command === "ollama" && args[0] === "run"
          ? { code: 0, stdout: "  \n ", stderr: "" }
          : happyExec(command, args)
    });
    expect(aiStep.verify(ctx).what).toContain("off-contract");
  });

  it("is ok when both models answer through the daemon", () => {
    const { ctx } = createFakeContext({ fileContents: wired, execHandler: happyExec });
    expect(aiStep.verify(ctx)).toEqual({ status: "ok" });
  });
});
