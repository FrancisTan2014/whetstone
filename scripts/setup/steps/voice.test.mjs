import { describe, expect, it } from "vitest";

import { createFakeContext } from "../testSupport.mjs";
import { readEnv } from "../env-file.mjs";
import {
  parseEnvVars,
  probeSpeechContract,
  resolveVoiceConfig,
  upsertEnvVars,
  validateLocalSpeechContract,
  voiceReadiness,
  voiceStep
} from "./voice.mjs";

const GIB = 1024 ** 3;
const ROOT = "/repo";
const ENV_PATH = "/repo/.env";
const VENV = "/repo/.data/voice/qwen-venv";
const VENV_PY = `${VENV}/bin/python`;
const LAUNCHER = `${VENV}/bin/whetstone-qwen`;
const MARKER = `${VENV}/.whetstone-voice-runtime`;
const DATA_DIR = "/repo/.data/voice";
const MODEL = "Qwen/Qwen3-ASR-1.7B";
const REVISION = "7278e1e70fe206f11671096ffdd38061171dd6e5";
const RUNTIME_VERSION = `${MODEL}@${REVISION}+torch2.5.1+qwen-asr0.0.6`;
// The legacy whisper wrapper's expected build revision (mirrors BUILD_REVISION in whisper-wrapper cli.py
// and SUPPORTED_WHISPER_BUILD_REVISION in voice.mjs): a wrapper that reports a different value — or none —
// is stale (#912) and reported not ready.
const WHISPER_REVISION = "910";
// A distinct custom provider-neutral LOCAL_ASR executable path, used to prove the local branch probes ITS
// binary (not a bundled one) and that provisioning refuses to clobber a custom provider.
const CUSTOM_BINARY = "/bin/custom-asr";

// The managed provider's cheap `--contract-version` descriptor (mirrors qwen-wrapper cli.py).
const PROBE_STDOUT = JSON.stringify({
  contractVersion: "1",
  provider: "qwen3-asr-1.7b",
  revision: REVISION,
  persistent: true,
  requirements: { diskGiB: 12, memoryGiB: 12 }
});
// A valid #799 transcript-first sample-inference payload (empty timing).
const SAMPLE_STDOUT = JSON.stringify({ text: "你好", language: "zh", segments: [] });

/**
 * Build an exec handler where every provisioning + probe call succeeds; a `fails` set flips one named
 * call to a nonzero exit, and `stdout` overrides a call's captured output. Named calls:
 *   pyversion | venv | torch | wrapper | modelprobe | modeldownload | contract | sample
 */
function execFor({ fails = new Set(), stdout = {}, python = "python" } = {}) {
  const name = (command, args) => {
    const joined = args.join(" ");
    if (args[0] === "--version") return "pyversion";
    if (args.includes("venv")) return "venv";
    if (joined.includes("pip install") && joined.includes("torch==")) return "torch";
    if (joined.includes("pip install") && joined.includes("qwen-wrapper")) return "wrapper";
    if (args[0] === "-c" && args[1].includes("local_files_only")) return "modelprobe";
    if (args[0] === "-c") return "modeldownload";
    if (args[0] === "--contract-version") return "contract";
    if (args.includes("--output")) return "sample";
    return "other";
  };
  return (command, args) => {
    // A `python3`-only host: the first `python --version` probe fails so resolvePython falls through.
    if (args[0] === "--version" && python === "python3" && command === "python") {
      return { code: 1, stdout: "", stderr: "" };
    }
    if (args[0] === "--version" && python === "none") {
      return { code: 1, stdout: "", stderr: "" };
    }
    const key = name(command, args);
    const defaults = { contract: PROBE_STDOUT, sample: SAMPLE_STDOUT };
    return {
      code: fails.has(key) ? 1 : 0,
      stdout: stdout[key] ?? defaults[key] ?? "",
      stderr: ""
    };
  };
}

describe("parseEnvVars / upsertEnvVars (re-exported)", () => {
  it("parses active lines and upserts values", () => {
    expect(parseEnvVars("# A=\nB=2\n")).toEqual({ B: "2" });
    expect(upsertEnvVars("# LOCAL_ASR_MODEL=\n", { LOCAL_ASR_MODEL: MODEL })).toBe(
      `LOCAL_ASR_MODEL=${MODEL}\n`
    );
  });
});

describe("resolveVoiceConfig (#799)", () => {
  it("treats a complete LOCAL_ASR pair as authoritative local", () => {
    expect(resolveVoiceConfig({ LOCAL_ASR_BINARY: LAUNCHER, LOCAL_ASR_MODEL: MODEL })).toEqual({
      kind: "local",
      binaryPath: LAUNCHER,
      modelIdentifier: MODEL,
      legacyAlsoPresent: false
    });
  });

  it("flags a mixed config when legacy WHISPER_* is also present", () => {
    expect(
      resolveVoiceConfig({
        LOCAL_ASR_BINARY: LAUNCHER,
        LOCAL_ASR_MODEL: MODEL,
        WHISPER_BINARY: "/bin/w"
      }).legacyAlsoPresent
    ).toBe(true);
  });

  it("reports a partial pair (exactly one new key) as a configuration error", () => {
    expect(resolveVoiceConfig({ LOCAL_ASR_BINARY: LAUNCHER })).toEqual({ kind: "partial-local" });
    expect(resolveVoiceConfig({ LOCAL_ASR_MODEL: MODEL })).toEqual({ kind: "partial-local" });
  });

  it("falls back to the legacy whisper pair only when no new key is present", () => {
    expect(resolveVoiceConfig({ WHISPER_BINARY: "/bin/w", WHISPER_MODEL_PATH: "small" })).toEqual({
      kind: "whisper",
      binaryPath: "/bin/w",
      modelPath: "small"
    });
  });

  it("treats blank/whitespace values as unset", () => {
    expect(resolveVoiceConfig({ LOCAL_ASR_BINARY: "  ", LOCAL_ASR_MODEL: "" })).toEqual({
      kind: "none"
    });
    expect(resolveVoiceConfig({})).toEqual({ kind: "none" });
  });
});

describe("resolveVoiceConfig from a CRLF .env (#915)", () => {
  // #915 acceptance #2: on Windows the `.env` is CRLF. Setup used to read it as empty, so a working
  // legacy whisper config resolved to `kind: "none"` and the #912 stale-wrapper build-revision check
  // — which only runs in the `kind === "whisper"` branch — was never reachable on the platform where a
  // stale wrapper was actually observed. readEnv must now parse the CRLF file so resolveVoiceConfig
  // returns `kind: "whisper"`.
  it("resolves the legacy whisper pair so the #912 stale-revision check is reachable", () => {
    const crlf = "WHISPER_BINARY=/opt/whisper\r\nWHISPER_MODEL_PATH=small\r\n";
    const { ctx } = createFakeContext({ fileContents: { [ENV_PATH]: crlf } });
    expect(resolveVoiceConfig(readEnv(ctx))).toEqual({
      kind: "whisper",
      binaryPath: "/opt/whisper",
      modelPath: "small"
    });
  });
});

describe("validateLocalSpeechContract (#799 transcript-first)", () => {
  it("accepts a transcript with empty segments and a null/string language", () => {
    expect(validateLocalSpeechContract(SAMPLE_STDOUT)).toEqual({ ok: true });
    expect(validateLocalSpeechContract('{"text":"","language":null,"segments":[]}')).toEqual({
      ok: true
    });
  });

  it("rejects non-JSON and non-object output", () => {
    expect(validateLocalSpeechContract("not json").ok).toBe(false);
    expect(validateLocalSpeechContract("[]").ok).toBe(false);
  });

  it("rejects a missing string text or a non-array segments", () => {
    expect(validateLocalSpeechContract('{"segments":[]}').ok).toBe(false);
    expect(validateLocalSpeechContract('{"text":"hi"}').ok).toBe(false);
  });

  it("rejects a language that is neither a string nor null", () => {
    const result = validateLocalSpeechContract('{"text":"hi","language":42,"segments":[]}');
    expect(result).toEqual({ ok: false, reason: '"language" must be a string or null' });
  });
});

describe("probeSpeechContract", () => {
  const probe = (execResult) =>
    probeSpeechContract(createFakeContext({ defaultExec: execResult }).ctx, LAUNCHER);

  it("returns ok with the parsed descriptor on a matching version", () => {
    const result = probe({ code: 0, stdout: PROBE_STDOUT, stderr: "" });
    expect(result.ok).toBe(true);
    expect(result.descriptor).toMatchObject({ provider: "qwen3-asr-1.7b", revision: REVISION });
  });

  it("is incompatible on a nonzero exit", () => {
    expect(probe({ code: 1, stdout: "", stderr: "boom" }).ok).toBe(false);
  });

  it("is incompatible on non-JSON probe output", () => {
    expect(probe({ code: 0, stdout: "nope", stderr: "" }).ok).toBe(false);
  });

  it("is incompatible when contractVersion is missing or not a string", () => {
    expect(probe({ code: 0, stdout: "{}", stderr: "" }).ok).toBe(false);
    expect(probe({ code: 0, stdout: '{"contractVersion":1}', stderr: "" }).ok).toBe(false);
  });

  it("is incompatible when the probe emits valid JSON that is not an object", () => {
    const result = probe({ code: 0, stdout: "42", stderr: "" });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('missing a string "contractVersion"');
  });

  it("is incompatible on a version mismatch", () => {
    const result = probe({ code: 0, stdout: '{"contractVersion":"2"}', stderr: "" });
    expect(result).toEqual({
      ok: false,
      reason: "it reports contract version 2, but this Whetstone requires 1"
    });
  });
});

describe("voiceReadiness", () => {
  const context = (overrides) => createFakeContext({ root: ROOT, ...overrides });

  it("errors on a partial LOCAL_ASR pair", () => {
    const result = voiceReadiness(context().ctx, { kind: "partial-local" });
    expect(result.status).toBe("error");
    expect(result.what).toContain("partially configured");
  });

  it("reports the bundled provider not installed when nothing is configured", () => {
    const result = voiceReadiness(context().ctx, { kind: "none" });
    expect(result.status).toBe("missing");
    expect(result.remedy).toContain("pnpm setup:voice");
  });

  describe("legacy whisper config", () => {
    // A legacy whisper wrapper's `--contract-version` descriptor: a matching shared contract version, plus
    // the build revision setup compares (#912). Omit the revision to model an install predating the field.
    const whisperProbe = (revision) =>
      JSON.stringify(
        revision === undefined ? { contractVersion: "1" } : { contractVersion: "1", revision }
      );

    it("is missing when the whisper launcher file is absent", () => {
      const result = voiceReadiness(context().ctx, {
        kind: "whisper",
        binaryPath: "/bin/w",
        modelPath: "small"
      });
      expect(result.status).toBe("missing");
      expect(result.what).toContain("legacy Whisper launcher is missing");
    });

    it("is missing when the whisper launcher fails the contract probe", () => {
      const { ctx } = context({
        files: ["/bin/w"],
        defaultExec: { code: 1, stdout: "", stderr: "" }
      });
      const result = voiceReadiness(ctx, { kind: "whisper", binaryPath: "/bin/w", modelPath: "small" });
      expect(result.status).toBe("missing");
      expect(result.remedy).toContain("pnpm setup:voice");
    });

    it("is ready and nudges migration when the wrapper reports the expected build revision", () => {
      // #912 criterion 3: a wrapper at the expected revision is ready, and the migration hint still logs.
      const { ctx, logs } = context({
        files: ["/bin/w"],
        defaultExec: { code: 0, stdout: whisperProbe(WHISPER_REVISION), stderr: "" }
      });
      const result = voiceReadiness(ctx, { kind: "whisper", binaryPath: "/bin/w", modelPath: "small" });
      expect(result.status).toBe("ok");
      expect(logs.some((line) => line.includes("Legacy WHISPER_* is still configured"))).toBe(true);
    });

    it("is not ready when the wrapper reports a different build revision (#912 criterion 1)", () => {
      const { ctx, logs } = context({
        files: ["/bin/w"],
        defaultExec: { code: 0, stdout: whisperProbe("909"), stderr: "" }
      });
      const result = voiceReadiness(ctx, { kind: "whisper", binaryPath: "/bin/w", modelPath: "small" });
      expect(result.status).not.toBe("ok");
      expect(result.what).toContain("stale");
      expect(result.what).toContain("909");
      expect(result.remedy).toContain("pip install --force-reinstall --no-deps");
      expect(result.remedy).toContain("pnpm setup:voice");
      // A stale wrapper must NOT be nudged as a ready migration — it is reported not ready instead.
      expect(logs.some((line) => line.includes("Legacy WHISPER_* is still configured"))).toBe(false);
    });

    it("is not ready when the wrapper descriptor has no build revision (#912 criterion 2)", () => {
      const { ctx } = context({
        files: ["/bin/w"],
        defaultExec: { code: 0, stdout: whisperProbe(), stderr: "" }
      });
      const result = voiceReadiness(ctx, { kind: "whisper", binaryPath: "/bin/w", modelPath: "small" });
      expect(result.status).not.toBe("ok");
      expect(result.what).toContain("predates revision tracking");
      expect(result.remedy).toContain("pip install --force-reinstall --no-deps");
      expect(result.remedy).toContain("pnpm setup:voice");
    });

    it("derives the reinstall command from the configured binary's own venv (#912 criterion 5)", () => {
      // The remedy targets the venv that owns WHISPER_BINARY — its sibling python — not a hardcoded
      // author-time path, so a different binary yields a different reinstall target.
      const binaryPath = "/opt/asr/whisper-venv/bin/whetstone-whisper";
      const { ctx } = context({
        files: [binaryPath],
        defaultExec: { code: 0, stdout: whisperProbe("stale"), stderr: "" }
      });
      const result = voiceReadiness(ctx, { kind: "whisper", binaryPath, modelPath: "small" });
      expect(result.remedy).toContain(
        '"/opt/asr/whisper-venv/bin/python" -m pip install --force-reinstall --no-deps'
      );
      expect(result.remedy).not.toContain("/bin/w");
    });

    it("derives the venv python from a Windows launcher path with backslashes", () => {
      const binaryPath = "C:\\repo\\.data\\whisper-venv\\Scripts\\whetstone-whisper.exe";
      const { ctx } = context({
        platform: "win32",
        files: [binaryPath],
        defaultExec: { code: 0, stdout: whisperProbe("stale"), stderr: "" }
      });
      const result = voiceReadiness(ctx, { kind: "whisper", binaryPath, modelPath: "small" });
      expect(result.remedy).toContain(
        '"C:\\repo\\.data\\whisper-venv\\Scripts\\python.exe" -m pip install --force-reinstall --no-deps'
      );
    });
  });

  describe("local provider", () => {
    it("is ready without any build-revision check (#912 criterion 4: Qwen/LOCAL_ASR unaffected)", () => {
      // The whisper build-revision staleness gate is scoped to the legacy whisper branch. A LOCAL_ASR
      // provider whose descriptor carries no such revision must still be ready — no new required field.
      const { ctx } = context({
        files: [CUSTOM_BINARY],
        defaultExec: { code: 0, stdout: '{"contractVersion":"1"}', stderr: "" }
      });
      const result = voiceReadiness(ctx, {
        kind: "local",
        binaryPath: CUSTOM_BINARY,
        modelIdentifier: MODEL,
        legacyAlsoPresent: false
      });
      expect(result.status).toBe("ok");
    });

    it("is missing when the configured executable file is absent", () => {
      const result = voiceReadiness(context().ctx, {
        kind: "local",
        binaryPath: CUSTOM_BINARY,
        modelIdentifier: MODEL,
        legacyAlsoPresent: false
      });
      expect(result.status).toBe("missing");
      expect(result.what).toContain("configured local speech executable is missing");
    });

    it("is missing (incompatible) when the executable fails the contract probe", () => {
      const { ctx } = context({
        files: [CUSTOM_BINARY],
        defaultExec: { code: 1, stdout: "", stderr: "" }
      });
      const result = voiceReadiness(ctx, {
        kind: "local",
        binaryPath: CUSTOM_BINARY,
        modelIdentifier: MODEL,
        legacyAlsoPresent: false
      });
      expect(result.status).toBe("missing");
      expect(result.what).toContain("incompatible");
    });

    it("is ready and logs the managed provider descriptor with requirements", () => {
      const { ctx, logs } = context({
        files: [LAUNCHER],
        defaultExec: { code: 0, stdout: PROBE_STDOUT, stderr: "" }
      });
      const result = voiceReadiness(ctx, {
        kind: "local",
        binaryPath: LAUNCHER,
        modelIdentifier: MODEL,
        legacyAlsoPresent: false
      });
      expect(result.status).toBe("ok");
      expect(logs.some((line) => line.includes(`qwen3-asr-1.7b @ ${REVISION}`))).toBe(true);
      expect(logs.some((line) => line.includes("12 GiB free disk, 12 GiB available memory"))).toBe(
        true
      );
    });

    it("logs that a persistent-capable provider's memory floor recurs whenever a capture is recent", () => {
      const { ctx, logs } = context({
        files: [LAUNCHER],
        defaultExec: { code: 0, stdout: PROBE_STDOUT, stderr: "" }
      });
      voiceReadiness(ctx, {
        kind: "local",
        binaryPath: LAUNCHER,
        modelIdentifier: MODEL,
        legacyAlsoPresent: false
      });
      expect(
        logs.some(
          (line) =>
            line.includes("resident for up to 5 idle minutes") &&
            line.includes("applies whenever a capture has landed in the last 5 minutes")
        )
      ).toBe(true);
    });

    it("logs no persistent-mode note when the descriptor does not declare persistent support", () => {
      const nonPersistentProbe = JSON.stringify({
        contractVersion: "1",
        provider: "qwen3-asr-1.7b",
        revision: REVISION,
        requirements: { diskGiB: 12, memoryGiB: 12 }
      });
      const { ctx, logs } = context({
        files: [LAUNCHER],
        defaultExec: { code: 0, stdout: nonPersistentProbe, stderr: "" }
      });
      voiceReadiness(ctx, {
        kind: "local",
        binaryPath: LAUNCHER,
        modelIdentifier: MODEL,
        legacyAlsoPresent: false
      });
      expect(logs.some((line) => line.includes("resident for up to 5 idle minutes"))).toBe(false);
    });

    it("logs the mixed-config hint when legacy WHISPER_* is also present", () => {
      const { ctx, logs } = context({
        files: [LAUNCHER],
        defaultExec: { code: 0, stdout: PROBE_STDOUT, stderr: "" }
      });
      voiceReadiness(ctx, {
        kind: "local",
        binaryPath: LAUNCHER,
        modelIdentifier: MODEL,
        legacyAlsoPresent: true
      });
      expect(logs.some((line) => line.includes("legacy WHISPER_* is"))).toBe(true);
    });

    it("logs no requirements when the descriptor omits them, and nothing when provider is absent", () => {
      const withoutRequirements = context({
        files: [LAUNCHER],
        defaultExec: {
          code: 0,
          stdout: JSON.stringify({ contractVersion: "1", provider: "x", revision: "y" }),
          stderr: ""
        }
      });
      voiceReadiness(withoutRequirements.ctx, {
        kind: "local",
        binaryPath: LAUNCHER,
        modelIdentifier: MODEL,
        legacyAlsoPresent: false
      });
      expect(withoutRequirements.logs.some((line) => line.includes("x @ y"))).toBe(true);
      expect(withoutRequirements.logs.some((line) => line.includes("needs"))).toBe(false);

      const nonNumericRequirements = context({
        files: [LAUNCHER],
        defaultExec: {
          code: 0,
          stdout: JSON.stringify({
            contractVersion: "1",
            provider: "x",
            revision: "y",
            requirements: { diskGiB: "12", memoryGiB: 12 }
          }),
          stderr: ""
        }
      });
      voiceReadiness(nonNumericRequirements.ctx, {
        kind: "local",
        binaryPath: LAUNCHER,
        modelIdentifier: MODEL,
        legacyAlsoPresent: false
      });
      expect(nonNumericRequirements.logs.some((line) => line.includes("needs"))).toBe(false);

      const noProvider = context({
        files: [LAUNCHER],
        defaultExec: { code: 0, stdout: '{"contractVersion":"1"}', stderr: "" }
      });
      voiceReadiness(noProvider.ctx, {
        kind: "local",
        binaryPath: LAUNCHER,
        modelIdentifier: MODEL,
        legacyAlsoPresent: false
      });
      expect(noProvider.logs.some((line) => line.includes("local speech provider:"))).toBe(false);
    });
  });
});

describe("voiceStep.check", () => {
  it("delegates to voiceReadiness over the resolved .env config", () => {
    const { ctx } = createFakeContext({
      root: ROOT,
      fileContents: { [ENV_PATH]: `LOCAL_ASR_BINARY=${LAUNCHER}\nLOCAL_ASR_MODEL=${MODEL}\n` },
      files: [LAUNCHER],
      defaultExec: { code: 0, stdout: PROBE_STDOUT, stderr: "" }
    });
    expect(voiceStep.check(ctx).status).toBe("ok");
  });

  it("reports the bundled provider not installed on an empty .env", () => {
    const { ctx } = createFakeContext({ root: ROOT });
    expect(voiceStep.check(ctx).status).toBe("missing");
  });
});

describe("voiceStep.provision", () => {
  const base = (overrides = {}) =>
    createFakeContext({
      root: ROOT,
      confirm: true,
      execHandler: execFor(overrides.exec ?? {}),
      ...overrides.ctx
    });

  it("errors on a partial LOCAL_ASR pair without touching the runtime", () => {
    const { ctx, execCalls } = base({
      ctx: { fileContents: { [ENV_PATH]: `LOCAL_ASR_BINARY=${LAUNCHER}\n` } }
    });
    const result = voiceStep.provision(ctx);
    expect(result.status).toBe("error");
    expect(result.what).toContain("partially configured");
    expect(execCalls.length).toBe(0);
  });

  it("refuses to clobber a custom LOCAL_ASR provider", () => {
    const { ctx } = base({
      ctx: {
        fileContents: { [ENV_PATH]: `LOCAL_ASR_BINARY=${CUSTOM_BINARY}\nLOCAL_ASR_MODEL=${MODEL}\n` }
      }
    });
    const result = voiceStep.provision(ctx);
    expect(result.status).toBe("error");
    expect(result.what).toContain("custom local speech provider");
  });

  it("falls back to the Python remedy when no interpreter and no package manager exist", () => {
    const { ctx } = base({ exec: {}, ctx: { execHandler: execFor({ python: "none" }) } });
    const result = voiceStep.provision(ctx);
    expect(result.status).toBe("missing");
    expect(result.remedy).toContain("Install Python 3");
  });

  it("fails fast when free disk is below the floor, before any download", () => {
    const { ctx, execCalls } = base({
      ctx: { resources: () => ({ diskFreeBytes: 5 * GIB, memoryAvailableBytes: 64 * GIB }) }
    });
    const result = voiceStep.provision(ctx);
    expect(result.status).toBe("error");
    expect(result.what).toContain("Not enough free disk");
    // No venv creation was attempted — the preflight ran before the heavy work.
    expect(execCalls.some((call) => call.includes("venv"))).toBe(false);
  });

  it("fails fast when available memory is below the floor", () => {
    const { ctx } = base({
      ctx: {
        files: [DATA_DIR],
        resources: () => ({ diskFreeBytes: 64 * GIB, memoryAvailableBytes: 4 * GIB })
      }
    });
    const result = voiceStep.provision(ctx);
    expect(result.status).toBe("error");
    expect(result.what).toContain("Not enough available memory");
  });

  it("surfaces a venv creation failure", () => {
    const { ctx } = base({ exec: { fails: new Set(["venv"]) } });
    const result = voiceStep.provision(ctx);
    expect(result.status).toBe("error");
    expect(result.what).toContain("virtual environment failed");
  });

  it("surfaces a torch install failure", () => {
    const { ctx } = base({ exec: { fails: new Set(["torch"]) } });
    expect(voiceStep.provision(ctx).what).toContain("CPU PyTorch");
  });

  it("surfaces a wrapper install failure", () => {
    const { ctx } = base({ exec: { fails: new Set(["wrapper"]) } });
    expect(voiceStep.provision(ctx).what).toContain("whetstone-qwen provider");
  });

  it("downloads the model when it is not cached, and surfaces a download failure", () => {
    const { ctx } = base({ exec: { fails: new Set(["modelprobe", "modeldownload"]) } });
    expect(voiceStep.provision(ctx).what).toContain("model snapshot");
  });

  it("provisions cleanly from an empty .env: writes LOCAL_ASR_*, removes WHISPER_*, downloads once", () => {
    // The model probe fails so the download path (idempotent fetch) is exercised.
    const { ctx, files, execCalls } = base({
      exec: { fails: new Set(["modelprobe"]) },
      ctx: {
        fileContents: {
          [ENV_PATH]: `WHISPER_BINARY=/old/w\nWHISPER_MODEL_PATH=small\nHOST=127.0.0.1\n`
        }
      }
    });
    const result = voiceStep.provision(ctx);
    expect(result.status).toBe("ok");
    const written = files.get(ENV_PATH);
    expect(written).toContain(`LOCAL_ASR_BINARY=${LAUNCHER}`);
    expect(written).toContain(`LOCAL_ASR_MODEL=${MODEL}`);
    expect(written).not.toContain("WHISPER_BINARY");
    expect(written).not.toContain("WHISPER_MODEL_PATH");
    expect(written).toContain("HOST=127.0.0.1");
    // The version marker was written after a successful build.
    expect(files.get(MARKER)).toBe(`${RUNTIME_VERSION}\n`);
    // The model download ran because the cache probe failed.
    expect(execCalls.some((call) => call.join(" ").includes("local_files_only"))).toBe(true);
  });

  it("is a no-op on the runtime when the venv marker already matches (idempotent repair)", () => {
    const { ctx, execCalls } = base({
      ctx: {
        files: [VENV_PY, DATA_DIR],
        fileContents: { [MARKER]: `${RUNTIME_VERSION}\n` }
      }
    });
    const result = voiceStep.provision(ctx);
    expect(result.status).toBe("ok");
    // A healthy venv is not recreated and no pip install runs.
    expect(execCalls.some((call) => call.includes("venv"))).toBe(false);
    expect(execCalls.some((call) => call.join(" ").includes("pip install"))).toBe(false);
  });

  it("bootstraps the venv with python3 when python is unavailable", () => {
    const { ctx } = base({ ctx: { execHandler: execFor({ python: "python3" }) } });
    const result = voiceStep.provision(ctx);
    expect(result.status).toBe("ok");
  });

  it("writes Windows Scripts paths on win32", () => {
    const winLauncher = `${VENV}/Scripts/whetstone-qwen.exe`;
    const { ctx, files } = base({ ctx: { platform: "win32", execHandler: execFor({}) } });
    const result = voiceStep.provision(ctx);
    expect(result.status).toBe("ok");
    expect(files.get(ENV_PATH)).toContain(`LOCAL_ASR_BINARY=${winLauncher}`);
  });
});

describe("voiceStep.verify", () => {
  const base = (overrides = {}) =>
    createFakeContext({
      root: ROOT,
      fileContents: { [ENV_PATH]: `LOCAL_ASR_BINARY=${LAUNCHER}\nLOCAL_ASR_MODEL=${MODEL}\n` },
      execHandler: execFor(overrides.exec ?? {}),
      ...overrides.ctx
    });

  it("errors when the pair is not wired into .env after provisioning", () => {
    const { ctx } = createFakeContext({ root: ROOT });
    const result = voiceStep.verify(ctx);
    expect(result.status).toBe("error");
    expect(result.what).toContain("not wired into .env");
  });

  it("errors when the installed launcher fails the contract probe", () => {
    const { ctx } = base({ exec: { fails: new Set(["contract"]) } });
    expect(voiceStep.verify(ctx).what).toContain("incompatible");
  });

  it("errors when the sample inference fails", () => {
    const { ctx } = base({ exec: { fails: new Set(["sample"]) } });
    expect(voiceStep.verify(ctx).what).toContain("failed on the sample audio");
  });

  it("errors when the sample output is off-contract", () => {
    const { ctx } = base({ exec: { stdout: { sample: '{"text":"hi"}' } } });
    expect(voiceStep.verify(ctx).what).toContain("off-contract output");
  });

  it("passes when the probe and a real sample inference are on-contract, logging the descriptor", () => {
    const { ctx, logs } = base();
    const result = voiceStep.verify(ctx);
    expect(result.status).toBe("ok");
    expect(logs.some((line) => line.includes("local speech provider:"))).toBe(true);
  });
});
