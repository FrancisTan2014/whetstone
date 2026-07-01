import { describe, expect, it } from "vitest";

import { createFakeContext } from "../testSupport.mjs";
import {
  parseContractShape,
  parseEnvVars,
  upsertEnvVars,
  voiceStep
} from "./voice.mjs";

const ENV_PATH = "/repo/.env";
const LAUNCHER = "/bin/whetstone-whisper";

// A default handler where every external call succeeds; individual tests override one branch.
function happyExec(command, args) {
  const joined = args.join(" ");
  if (args[0] === "--version") return { code: 0, stdout: "Python 3.11", stderr: "" };
  if (joined === "-c import faster_whisper") return { code: 0, stdout: "", stderr: "" };
  if (joined.includes("pip install faster-whisper")) return { code: 0, stdout: "", stderr: "" };
  if (joined.includes("pip install") && joined.includes("whisper-wrapper")) {
    return { code: 0, stdout: "", stderr: "" };
  }
  if (joined.includes("whetstone_whisper.locate")) {
    return { code: 0, stdout: `${LAUNCHER}\n`, stderr: "" };
  }
  if (joined.includes("whetstone_whisper.fetch")) return { code: 0, stdout: "", stderr: "" };
  return { code: 0, stdout: "", stderr: "" };
}

describe("parseEnvVars", () => {
  it("reads active KEY=value lines and ignores comments", () => {
    const vars = parseEnvVars("# WHISPER_BINARY=\nWHISPER_MODEL_PATH=small\nHOST=127.0.0.1\n");
    expect(vars).toEqual({ WHISPER_MODEL_PATH: "small", HOST: "127.0.0.1" });
  });
});

describe("upsertEnvVars", () => {
  it("uncomments a template line in place", () => {
    const out = upsertEnvVars("# WHISPER_BINARY=\n", { WHISPER_BINARY: "/bin/w" });
    expect(out).toBe("WHISPER_BINARY=/bin/w\n");
  });

  it("replaces an existing active value", () => {
    const out = upsertEnvVars("WHISPER_MODEL_PATH=old\n", { WHISPER_MODEL_PATH: "small" });
    expect(out).toBe("WHISPER_MODEL_PATH=small\n");
  });

  it("appends a key that is not present and terminates with a newline", () => {
    const out = upsertEnvVars("HOST=127.0.0.1", { WHISPER_BINARY: "/bin/w" });
    expect(out).toBe("HOST=127.0.0.1\nWHISPER_BINARY=/bin/w\n");
  });

  it("skips undefined values", () => {
    const out = upsertEnvVars("", { WHISPER_BINARY: "/bin/w", WHISPER_LANGUAGE: undefined });
    expect(out).toBe("WHISPER_BINARY=/bin/w\n");
  });
});

describe("parseContractShape", () => {
  it("accepts the docs/SPEECH.md shape", () => {
    expect(parseContractShape('{"text":"","segments":[]}')).toEqual({ ok: true });
  });

  it("rejects invalid JSON", () => {
    expect(parseContractShape("not json")).toMatchObject({ ok: false });
  });

  it("rejects a non-object", () => {
    expect(parseContractShape("42")).toMatchObject({ ok: false });
  });

  it("rejects a missing text field", () => {
    expect(parseContractShape('{"segments":[]}')).toMatchObject({ ok: false });
  });

  it("rejects a missing segments array", () => {
    expect(parseContractShape('{"text":"hi"}')).toMatchObject({ ok: false });
  });
});

describe("voiceStep.check", () => {
  it("reports missing when Python is absent, without crashing", () => {
    const { ctx } = createFakeContext({ execHandler: () => ({ code: 1, stdout: "", stderr: "" }) });
    const result = voiceStep.check(ctx);
    expect(result.status).toBe("missing");
    expect(result.remedy).toContain("Python 3");
  });

  it("reports missing when faster-whisper is not importable", () => {
    const { ctx } = createFakeContext({
      execHandler: (command, args) =>
        args.join(" ") === "-c import faster_whisper"
          ? { code: 1, stdout: "", stderr: "" }
          : { code: 0, stdout: "", stderr: "" }
    });
    expect(voiceStep.check(ctx).what).toContain("faster-whisper");
  });

  it("reports missing when WHISPER_* is not in .env", () => {
    const { ctx } = createFakeContext({ execHandler: happyExec });
    expect(voiceStep.check(ctx).what).toContain(".env");
  });

  it("reports missing when the launcher file is gone", () => {
    const { ctx } = createFakeContext({
      execHandler: happyExec,
      fileContents: { [ENV_PATH]: "WHISPER_BINARY=/gone\nWHISPER_MODEL_PATH=small\n" }
    });
    expect(voiceStep.check(ctx).what).toContain("launcher is missing");
  });

  it("is ok when faster-whisper, the launcher, and .env are all present", () => {
    const { ctx } = createFakeContext({
      execHandler: happyExec,
      files: [LAUNCHER],
      fileContents: { [ENV_PATH]: `WHISPER_BINARY=${LAUNCHER}\nWHISPER_MODEL_PATH=small\n` }
    });
    expect(voiceStep.check(ctx)).toEqual({ status: "ok" });
  });
});

describe("voiceStep.provision", () => {
  it("reports missing (never crashes) when Python is absent", () => {
    const { ctx } = createFakeContext({ execHandler: () => ({ code: 1, stdout: "", stderr: "" }) });
    expect(voiceStep.provision(ctx).status).toBe("missing");
  });

  it("maps a failing `pip install faster-whisper` to an actionable error", () => {
    const { ctx } = createFakeContext({
      execHandler: (command, args) =>
        args.join(" ").includes("pip install faster-whisper")
          ? { code: 1, stdout: "", stderr: "no network" }
          : happyExec(command, args)
    });
    const result = voiceStep.provision(ctx);
    expect(result.status).toBe("error");
    expect(result.remedy).toContain("ensurepip");
    expect(result.remedy).toContain("no network");
  });

  it("maps a failing wrapper install to an error", () => {
    const { ctx } = createFakeContext({
      execHandler: (command, args) =>
        args.join(" ").includes("whisper-wrapper")
          ? { code: 1, stdout: "", stderr: "build failed" }
          : happyExec(command, args)
    });
    expect(voiceStep.provision(ctx).what).toContain("whetstone-whisper wrapper");
  });

  it("errors when the launcher cannot be located after install", () => {
    const { ctx } = createFakeContext({
      execHandler: (command, args) =>
        args.join(" ").includes("whetstone_whisper.locate")
          ? { code: 0, stdout: "\n", stderr: "" }
          : happyExec(command, args)
    });
    expect(voiceStep.provision(ctx).what).toContain("could not be located");
  });

  it("maps a model-download failure to an actionable error", () => {
    const { ctx } = createFakeContext({
      env: { WHISPER_MODEL: "small" },
      execHandler: (command, args) =>
        args.join(" ").includes("whetstone_whisper.fetch")
          ? { code: 1, stdout: "", stderr: "connection reset" }
          : happyExec(command, args)
    });
    const result = voiceStep.provision(ctx);
    expect(result.what).toContain('model "small"');
    expect(result.remedy).toContain("smaller model");
  });

  it("writes the resolved Whisper wiring into .env on success", () => {
    const { ctx, files } = createFakeContext({
      execHandler: happyExec,
      env: { WHISPER_LANGUAGE: "zh" },
      fileContents: { [ENV_PATH]: "# WHISPER_BINARY=\n# WHISPER_MODEL_PATH=\n# WHISPER_LANGUAGE=\n" }
    });
    expect(voiceStep.provision(ctx)).toEqual({ status: "ok" });
    const env = files.get(ENV_PATH);
    expect(env).toContain(`WHISPER_BINARY=${LAUNCHER}`);
    expect(env).toContain("WHISPER_MODEL_PATH=small");
    expect(env).toContain("WHISPER_LANGUAGE=zh");
  });

  it("scaffolds .env from scratch when it does not exist", () => {
    const { ctx, files } = createFakeContext({ execHandler: happyExec });
    expect(voiceStep.provision(ctx)).toEqual({ status: "ok" });
    expect(files.get(ENV_PATH)).toContain(`WHISPER_BINARY=${LAUNCHER}`);
  });
});

describe("voiceStep.verify", () => {
  const wired = { [ENV_PATH]: `WHISPER_BINARY=${LAUNCHER}\nWHISPER_MODEL_PATH=small\n` };

  it("errors when .env is not wired after provisioning", () => {
    const { ctx } = createFakeContext();
    expect(voiceStep.verify(ctx).what).toContain("not wired");
  });

  it("errors when the wrapper exits non-zero on the sample", () => {
    const { ctx } = createFakeContext({
      fileContents: wired,
      execHandler: (command) =>
        command === LAUNCHER ? { code: 1, stdout: "", stderr: "boom" } : { code: 0, stdout: "", stderr: "" }
    });
    expect(voiceStep.verify(ctx).what).toContain("failed on the sample");
  });

  it("errors when the wrapper emits off-contract output", () => {
    const { ctx } = createFakeContext({
      fileContents: wired,
      execHandler: (command) =>
        command === LAUNCHER
          ? { code: 0, stdout: "not json", stderr: "" }
          : { code: 0, stdout: "", stderr: "" }
    });
    expect(voiceStep.verify(ctx).what).toContain("off-contract");
  });

  it("is ok when the wrapper emits valid contract JSON", () => {
    const { ctx } = createFakeContext({
      fileContents: wired,
      execHandler: (command) =>
        command === LAUNCHER
          ? { code: 0, stdout: '{"text":"","segments":[]}', stderr: "" }
          : { code: 0, stdout: "", stderr: "" }
    });
    expect(voiceStep.verify(ctx)).toEqual({ status: "ok" });
  });
});
