import { describe, expect, it } from "vitest";

import { createFakeContext } from "../testSupport.mjs";
import { coachStep, validateOllamaAnswer } from "./coach.mjs";

const ENV_PATH = "/repo/.env";
const CONVERSE_MODEL = "llama3.1:8b";
const EXPLAIN_MODEL = "qwen2.5";
// The exact non-secret wiring `provision` writes: the local explain model + both tiers pinned local.
const WIRED_ENV = `EXPLAIN_MODEL=${EXPLAIN_MODEL}\nCOACH_CONVERSE_TIER=cheap\nCOACH_ANALYZE_TIER=cheap\n`;

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
      fileContents: { [ENV_PATH]: `EXPLAIN_MODEL=${EXPLAIN_MODEL}\n` }
    });
    const result = coachStep.check(ctx);
    expect(result.status).toBe("missing");
    expect(result.what).toContain("COACH_CONVERSE_TIER");
  });

  it("reports missing when a coach tier is pinned to strong instead of cheap", () => {
    const { ctx } = createFakeContext({
      execHandler: happyExec,
      fileContents: {
        [ENV_PATH]: `EXPLAIN_MODEL=${EXPLAIN_MODEL}\nCOACH_CONVERSE_TIER=cheap\nCOACH_ANALYZE_TIER=strong\n`
      }
    });
    const result = coachStep.check(ctx);
    expect(result.status).toBe("missing");
    expect(result.what).toContain("COACH_ANALYZE_TIER");
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
    expect(env).toContain(`EXPLAIN_MODEL=${EXPLAIN_MODEL}`);
    expect(env).toContain("COACH_CONVERSE_TIER=cheap");
    expect(env).toContain("COACH_ANALYZE_TIER=cheap");
    expect(env).not.toContain("COACH_API_KEY");
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
    expect(coachStep.verify(ctx).what).toContain("EXPLAIN_MODEL");
  });

  it("errors when the coach tiers are not wired after provisioning", () => {
    const { ctx } = createFakeContext({
      fileContents: { [ENV_PATH]: `EXPLAIN_MODEL=${EXPLAIN_MODEL}\n` },
      execHandler: happyExec
    });
    const result = coachStep.verify(ctx);
    expect(result.status).toBe("error");
    expect(result.what).toContain("COACH_CONVERSE_TIER");
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
