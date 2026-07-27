import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { createFakeContext } from "../testSupport.mjs";
import {
  upsertEnvVars,
  validateWhisperContract,
  parseEnvVars,
  probeWhisperContract,
  voiceStep
} from "./voice.mjs";

const ENV_PATH = "/repo/.env";
const LAUNCHER = "/bin/whetstone-whisper";
// The compatible contract probe payload the current whetstone-whisper launcher emits for
// `--contract-version` (mirrors CONTRACT_VERSION in whisper-wrapper/whetstone_whisper/cli.py).
const CONTRACT_STDOUT = '{"contractVersion":"1"}';

// A default handler where every external call succeeds; individual tests override one branch.
function happyExec(command, args) {
  const joined = args.join(" ");
  // The launcher's cheap contract probe reports the supported version, so readiness passes.
  if (command === LAUNCHER && args[0] === "--contract-version") {
    return { code: 0, stdout: CONTRACT_STDOUT, stderr: "" };
  }
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
    const out = upsertEnvVars("", { WHISPER_BINARY: "/bin/w", WHISPER_MODEL_PATH: undefined });
    expect(out).toBe("WHISPER_BINARY=/bin/w\n");
  });
});

describe("validateWhisperContract", () => {
  const validWord = '{"word":"Help","start":0,"end":0.4}';
  const valid = `{"text":"Help","segments":[{"words":[${validWord}]}]}`;

  it("accepts the strict docs/SPEECH.md shape", () => {
    expect(validateWhisperContract(valid)).toEqual({ ok: true });
    expect(validateWhisperContract('{"text":"","segments":[]}')).toEqual({ ok: true });
  });

  it("rejects invalid JSON and non-objects", () => {
    expect(validateWhisperContract("not json").ok).toBe(false);
    expect(validateWhisperContract("42").ok).toBe(false);
    expect(validateWhisperContract("[]").ok).toBe(false);
  });

  it("rejects a missing text or segments", () => {
    expect(validateWhisperContract('{"segments":[]}').ok).toBe(false);
    expect(validateWhisperContract('{"text":"hi"}').ok).toBe(false);
  });

  it("rejects a segment that is present but malformed (no words array)", () => {
    // The runtime parseWhisperOutput requires each segment to carry a words array; setup must not
    // report ready for this output the server would reject.
    const result = validateWhisperContract('{"text":"","segments":[{}]}');
    expect(result).toMatchObject({ ok: false });
    expect(result.reason).toContain('"words"');
  });

  it("rejects a non-object segment", () => {
    expect(validateWhisperContract('{"text":"","segments":[1]}').ok).toBe(false);
  });

  it("rejects malformed words (non-object, missing word/start/end, or end before start)", () => {
    const cases = [
      '{"text":"","segments":[{"words":[1]}]}',
      '{"text":"","segments":[{"words":[{"start":0,"end":1}]}]}',
      '{"text":"","segments":[{"words":[{"word":"a","end":1}]}]}',
      '{"text":"","segments":[{"words":[{"word":"a","start":0}]}]}',
      '{"text":"","segments":[{"words":[{"word":"a","start":"0","end":1}]}]}',
      '{"text":"","segments":[{"words":[{"word":"a","start":1,"end":0.5}]}]}'
    ];
    for (const stdout of cases) {
      expect(validateWhisperContract(stdout).ok).toBe(false);
    }
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

  // The core #780 regression: a launcher file exists but the contract probe fails, so readiness must
  // report the wrapper incompatible (naming it + pointing at `pnpm setup:voice`), never "ready".
  const wiredLauncher = {
    files: [LAUNCHER],
    fileContents: { [ENV_PATH]: `WHISPER_BINARY=${LAUNCHER}\nWHISPER_MODEL_PATH=small\n` }
  };
  const probeExec = (stdout, code = 0) => (command, args) =>
    command === LAUNCHER && args[0] === "--contract-version"
      ? { code, stdout, stderr: "boom stderr that must not leak" }
      : happyExec(command, args);

  it("reports the stale wrapper incompatible when the contract probe exits nonzero (no traceback)", () => {
    const { ctx } = createFakeContext({ ...wiredLauncher, execHandler: probeExec("", 2) });
    const result = voiceStep.check(ctx);
    expect(result.status).toBe("missing");
    expect(result.what).toContain("incompatible");
    expect(result.remedy).toContain("pnpm setup:voice");
    // Doctor must not surface a traceback: the launcher's stderr never reaches the operator message.
    expect(`${result.what}${result.remedy}`).not.toContain("boom stderr");
  });

  it("reports incompatible when the probe emits malformed JSON", () => {
    const { ctx } = createFakeContext({ ...wiredLauncher, execHandler: probeExec("not json") });
    expect(voiceStep.check(ctx).what).toContain("incompatible");
  });

  it("reports incompatible when the probe reports a mismatched contract version", () => {
    const { ctx } = createFakeContext({
      ...wiredLauncher,
      execHandler: probeExec('{"contractVersion":"0"}')
    });
    const result = voiceStep.check(ctx);
    expect(result.status).toBe("missing");
    expect(result.what).toContain("incompatible");
  });
});

describe("probeWhisperContract", () => {
  const run = (stdout, code = 0) => {
    const { ctx } = createFakeContext({
      execHandler: () => ({ code, stdout, stderr: "" })
    });
    return probeWhisperContract(ctx, LAUNCHER);
  };

  it("is ok only for the exact supported contract version", () => {
    expect(run(CONTRACT_STDOUT)).toEqual({ ok: true });
  });

  it("rejects a nonzero exit, malformed output, a missing version, and a mismatch", () => {
    expect(run("", 1).ok).toBe(false);
    expect(run("not json").ok).toBe(false);
    expect(run('{"other":"1"}').ok).toBe(false);
    expect(run("42").ok).toBe(false);
    expect(run('{"contractVersion":2}').ok).toBe(false);
    expect(run('{"contractVersion":"9"}').ok).toBe(false);
  });
});

describe("voiceStep.provision", () => {
  it("reports missing (never crashes) when Python is absent", () => {
    const { ctx } = createFakeContext({ execHandler: () => ({ code: 1, stdout: "", stderr: "" }) });
    expect(voiceStep.provision(ctx).status).toBe("missing");
  });

  it("installs Python via winget after consent, then provisions Whisper", () => {
    let pythonPresent = false;
    const { ctx, confirmCalls, execCalls } = createFakeContext({
      platform: "win32",
      confirm: true,
      execHandler: (command, args) => {
        if ((command === "python" || command === "python3") && args[0] === "--version") {
          return { code: command === "python" && pythonPresent ? 0 : 1, stdout: "", stderr: "" };
        }
        if (command === "winget" && args[0] === "--version") return { code: 0, stdout: "", stderr: "" };
        if (command === "winget" && args[0] === "install") {
          pythonPresent = true;
          return { code: 0, stdout: "", stderr: "" };
        }
        return happyExec(command, args);
      }
    });
    expect(voiceStep.provision(ctx)).toEqual({ status: "ok" });
    expect(confirmCalls).toContain("Install Python 3 now? [Y/n]");
    expect(execCalls).toContainEqual(["winget", "install", "Python.Python.3"]);
  });

  it("falls back to the instruct-only Python remedy when consent is declined", () => {
    const { ctx, confirmCalls } = createFakeContext({
      platform: "win32",
      confirm: false,
      execHandler: (command, args) =>
        command === "winget" && args[0] === "--version"
          ? { code: 0, stdout: "", stderr: "" }
          : { code: 1, stdout: "", stderr: "" }
    });
    const result = voiceStep.provision(ctx);
    expect(result.status).toBe("missing");
    expect(result.remedy).toContain("Python 3");
    expect(confirmCalls).toEqual(["Install Python 3 now? [Y/n]"]);
  });

  it("falls back to the instruct-only Python remedy when no package manager is available", () => {
    const { ctx, confirmCalls } = createFakeContext({
      platform: "win32",
      confirm: true,
      execHandler: () => ({ code: 1, stdout: "", stderr: "" })
    });
    expect(voiceStep.provision(ctx).status).toBe("missing");
    expect(confirmCalls).toEqual([]); // never asked — nothing to install with
  });

  it("reports missing when Python is still off PATH after a reported install", () => {
    const { ctx } = createFakeContext({
      platform: "darwin",
      confirm: true,
      execHandler: (command, args) => {
        if (command === "brew" && args[0] === "--version") return { code: 0, stdout: "", stderr: "" };
        if (command === "brew" && args[0] === "install") return { code: 0, stdout: "", stderr: "" };
        return { code: 1, stdout: "", stderr: "" }; // python never resolves on this shell
      }
    });
    const result = voiceStep.provision(ctx);
    expect(result.status).toBe("missing");
    expect(result.remedy).toContain("Python 3");
  });

  it("maps a failing `pip install faster-whisper` to an actionable error", () => {
    const { ctx } = createFakeContext({
      execHandler: (command, args) => {
        const joined = args.join(" ");
        // faster-whisper is not importable, so provisioning attempts the install (which then fails).
        if (joined === "-c import faster_whisper") return { code: 1, stdout: "", stderr: "" };
        if (joined.includes("pip install faster-whisper")) {
          return { code: 1, stdout: "", stderr: "no network" };
        }
        return happyExec(command, args);
      }
    });
    const result = voiceStep.provision(ctx);
    expect(result.status).toBe("error");
    expect(result.remedy).toContain("ensurepip");
    expect(result.remedy).toContain("no network");
  });

  it("reinstalls only the wrapper (force-reinstall, --no-deps) when faster-whisper is already healthy (#780)", () => {
    // The stale-wrapper repair path: faster-whisper imports fine, so its install is skipped and the
    // wrapper is force-reinstalled in place — replacing a same-version stale wrapper without touching
    // the healthy speech stack.
    const { ctx, execCalls } = createFakeContext({
      execHandler: happyExec,
      fileContents: { [ENV_PATH]: "# WHISPER_BINARY=\n# WHISPER_MODEL_PATH=\n" }
    });
    expect(voiceStep.provision(ctx)).toEqual({ status: "ok" });
    // faster-whisper is never (re)installed.
    expect(execCalls.some((call) => call.join(" ").includes("pip install faster-whisper"))).toBe(
      false
    );
    // The wrapper install forces a reinstall and skips deps so faster-whisper is left untouched.
    const wrapperInstall = execCalls.find(
      (call) => call.join(" ").includes("pip") && call.join(" ").includes("whisper-wrapper")
    );
    expect(wrapperInstall).toContain("--force-reinstall");
    expect(wrapperInstall).toContain("--no-deps");
  });

  it("installs faster-whisper when its import probe fails", () => {
    const { ctx, execCalls } = createFakeContext({
      execHandler: (command, args) =>
        args.join(" ") === "-c import faster_whisper"
          ? { code: 1, stdout: "", stderr: "" }
          : happyExec(command, args),
      fileContents: { [ENV_PATH]: "# WHISPER_BINARY=\n# WHISPER_MODEL_PATH=\n" }
    });
    expect(voiceStep.provision(ctx)).toEqual({ status: "ok" });
    expect(execCalls.some((call) => call.join(" ").includes("pip install faster-whisper"))).toBe(
      true
    );
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

  it("errors with a python.org remedy when the launcher is nowhere and no user-site dir is reported", () => {
    const { ctx } = createFakeContext({
      execHandler: (command, args) =>
        args.join(" ").includes("whetstone_whisper.locate")
          ? { code: 0, stdout: "\n", stderr: "" }
          : happyExec(command, args)
    });
    const result = voiceStep.provision(ctx);
    expect(result.what).toContain("could not be located");
    expect(result.remedy).toContain("https://www.python.org/downloads");
    expect(result.remedy).toContain("Add to PATH");
  });

  it("names the Microsoft Store Python user-site Scripts dir in the remedy when locate reports one", () => {
    const userScriptsDir =
      "C:\\Users\\me\\AppData\\Local\\Packages\\PythonSoftwareFoundation.Python.3.13_qbz5n2kfra8p0\\LocalCache\\local-packages\\Python313\\Scripts";
    const { ctx } = createFakeContext({
      execHandler: (command, args) =>
        args.join(" ").includes("whetstone_whisper.locate")
          ? { code: 0, stdout: "", stderr: `${userScriptsDir}\n` }
          : happyExec(command, args)
    });
    const result = voiceStep.provision(ctx);
    expect(result.status).toBe("error");
    expect(result.what).toContain("could not be located");
    expect(result.remedy).toContain(userScriptsDir);
    expect(result.remedy).toContain("Microsoft Store Python");
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

  it("writes the resolved Whisper wiring into .env on success (no language override)", () => {
    const { ctx, files } = createFakeContext({
      execHandler: happyExec,
      fileContents: { [ENV_PATH]: "# WHISPER_BINARY=\n# WHISPER_MODEL_PATH=\n" }
    });
    expect(voiceStep.provision(ctx)).toEqual({ status: "ok" });
    const env = files.get(ENV_PATH);
    expect(env).toContain(`WHISPER_BINARY=${LAUNCHER}`);
    expect(env).toContain("WHISPER_MODEL_PATH=small");
    // Whisper always auto-detects the language (#647): no WHISPER_LANGUAGE is written.
    expect(env).not.toContain("WHISPER_LANGUAGE");
  });

  it("scaffolds .env from scratch when it does not exist", () => {
    const { ctx, files } = createFakeContext({ execHandler: happyExec });
    expect(voiceStep.provision(ctx)).toEqual({ status: "ok" });
    expect(files.get(ENV_PATH)).toContain(`WHISPER_BINARY=${LAUNCHER}`);
  });
});

describe("voiceStep.verify", () => {
  const wired = { [ENV_PATH]: `WHISPER_BINARY=${LAUNCHER}\nWHISPER_MODEL_PATH=small\n` };
  // Verify runs two launcher calls: the cheap `--contract-version` probe, then the sample inference.
  // A helper that answers the probe with the supported version and routes the sample call to `onSample`.
  const launcherExec = (onSample) => (command, args) => {
    if (command !== LAUNCHER) return { code: 0, stdout: "", stderr: "" };
    if (args[0] === "--contract-version") return { code: 0, stdout: CONTRACT_STDOUT, stderr: "" };
    return onSample();
  };

  it("errors when .env is not wired after provisioning", () => {
    const { ctx } = createFakeContext();
    expect(voiceStep.verify(ctx).what).toContain("not wired");
  });

  it("errors when the freshly installed wrapper still fails the contract probe (#780)", () => {
    const { ctx } = createFakeContext({
      fileContents: wired,
      execHandler: (command, args) =>
        command === LAUNCHER && args[0] === "--contract-version"
          ? { code: 2, stdout: "", stderr: "" }
          : { code: 0, stdout: "", stderr: "" }
    });
    const result = voiceStep.verify(ctx);
    expect(result.status).toBe("error");
    expect(result.what).toContain("incompatible");
  });

  it("errors when the wrapper exits non-zero on the sample", () => {
    const { ctx } = createFakeContext({
      fileContents: wired,
      execHandler: launcherExec(() => ({ code: 1, stdout: "", stderr: "boom" }))
    });
    expect(voiceStep.verify(ctx).what).toContain("failed on the sample");
  });

  it("errors when the wrapper emits output the runtime adapter would reject (segment without words)", () => {
    const { ctx } = createFakeContext({
      fileContents: wired,
      execHandler: launcherExec(() => ({
        code: 0,
        stdout: '{"text":"","segments":[{}]}',
        stderr: ""
      }))
    });
    expect(voiceStep.verify(ctx).what).toContain("off-contract");
  });

  it("is ok when the wrapper passes the probe AND emits valid strict contract JSON", () => {
    const { ctx } = createFakeContext({
      fileContents: wired,
      execHandler: launcherExec(() => ({
        code: 0,
        stdout: '{"text":"Help","segments":[{"words":[{"word":"Help","start":0,"end":0.4}]}]}',
        stderr: ""
      }))
    });
    expect(voiceStep.verify(ctx)).toEqual({ status: "ok" });
  });
});

// Fixture launchers executed as REAL subprocesses, so the contract probe (the heart of readiness) is
// proven at the process boundary and cannot pass merely because a mocked exec returned the right string
// (#780). Node-based (CI has Node, not Python); the real cli.py launcher is exercised end-to-end by the
// Python wrapper tests (whisper-wrapper/tests/test_cli.py). `node -e <script> <args>` runs each fixture
// as its own process, with the probe flag reaching it as process.argv.
const CURRENT_LAUNCHER =
  'const a=process.argv.slice(1);' +
  'if(a.includes("--contract-version")){process.stdout.write(JSON.stringify({contractVersion:"1"}));process.exit(0)}' +
  "process.exit(1);";
// The stale pre-#647 launcher: it predates the probe, so it rejects the unknown flag with a nonzero exit
// (and would forward the literal "auto" on a real transcribe call).
const STALE_LAUNCHER =
  'const a=process.argv.slice(1);' +
  'if(a.includes("--contract-version")){process.stderr.write("unrecognized: --contract-version");process.exit(2)}' +
  'process.stdout.write(JSON.stringify({text:"",language:"auto",segments:[]}));process.exit(0);';

function launcherProcessCtx(script) {
  return {
    exec(_command, args) {
      const result = spawnSync(process.execPath, ["-e", script, "--", ...args], {
        encoding: "utf8"
      });
      return {
        code: result.status ?? 1,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? ""
      };
    }
  };
}

describe("probeWhisperContract against real launcher processes (#780)", () => {
  it("passes the current launcher and rejects the stale one, each executed as its own process", () => {
    expect(probeWhisperContract(launcherProcessCtx(CURRENT_LAUNCHER), "whetstone-whisper")).toEqual({
      ok: true
    });
    const stale = probeWhisperContract(launcherProcessCtx(STALE_LAUNCHER), "whetstone-whisper");
    expect(stale.ok).toBe(false);
  });
});
