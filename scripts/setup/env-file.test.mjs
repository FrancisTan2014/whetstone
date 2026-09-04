import { describe, expect, it } from "vitest";

import { createFakeContext } from "./testSupport.mjs";
import { envPath, parseEnvVars, readEnv, removeEnvVars, upsertEnvVars } from "./env-file.mjs";

describe("parseEnvVars", () => {
  it("reads active KEY=value lines and ignores comments", () => {
    const vars = parseEnvVars("# EXPLAIN_MODEL=\nCOACH_CONVERSE_TIER=cheap\nHOST=127.0.0.1\n");
    expect(vars).toEqual({ COACH_CONVERSE_TIER: "cheap", HOST: "127.0.0.1" });
  });

  // #915: a Windows `.env` is CRLF; splitting on "\n" left a trailing "\r" that defeated the value
  // regex's `$` anchor, so every line failed to match and the whole file read as empty. CRLF must
  // parse identically to LF (acceptance #1), with values trimmed exactly as before (acceptance #5).
  it("parses CRLF content identically to LF, trimming values", () => {
    const lf = "# EXPLAIN_MODEL=\nCOACH_CONVERSE_TIER=cheap\nHOST=127.0.0.1\n";
    const crlf = lf.replace(/\n/g, "\r\n");
    expect(parseEnvVars(crlf)).toEqual(parseEnvVars(lf));
    expect(parseEnvVars(crlf)).toEqual({ COACH_CONVERSE_TIER: "cheap", HOST: "127.0.0.1" });
  });

  it("parses a final CRLF line that has no trailing newline", () => {
    expect(parseEnvVars("HOST=127.0.0.1\r\nWHISPER_MODEL_PATH=small")).toEqual({
      HOST: "127.0.0.1",
      WHISPER_MODEL_PATH: "small"
    });
  });
});

describe("upsertEnvVars", () => {
  it("uncomments a template line in place", () => {
    const out = upsertEnvVars("# EXPLAIN_MODEL=\n", { EXPLAIN_MODEL: "qwen2.5" });
    expect(out).toBe("EXPLAIN_MODEL=qwen2.5\n");
  });

  it("replaces an existing active value", () => {
    const out = upsertEnvVars("COACH_ANALYZE_TIER=strong\n", { COACH_ANALYZE_TIER: "cheap" });
    expect(out).toBe("COACH_ANALYZE_TIER=cheap\n");
  });

  it("appends a key that is not present and terminates with a newline", () => {
    const out = upsertEnvVars("HOST=127.0.0.1", { EXPLAIN_MODEL: "qwen2.5" });
    expect(out).toBe("HOST=127.0.0.1\nEXPLAIN_MODEL=qwen2.5\n");
  });

  it("skips undefined values", () => {
    const out = upsertEnvVars("", { EXPLAIN_MODEL: "qwen2.5", COACH_CONVERSE_TIER: undefined });
    expect(out).toBe("EXPLAIN_MODEL=qwen2.5\n");
  });

  // #915 acceptance #3: preserve the file's existing CRLF ending on write. The old code rebuilt the
  // rewritten line without its "\r" while untouched lines kept theirs, silently mixing endings.
  it("preserves CRLF when rewriting a line, with no mixed endings", () => {
    const out = upsertEnvVars("# EXPLAIN_MODEL=\r\nHOST=127.0.0.1\r\n", { EXPLAIN_MODEL: "qwen2.5" });
    expect(out).toBe("EXPLAIN_MODEL=qwen2.5\r\nHOST=127.0.0.1\r\n");
    // After stripping every CRLF pair, no stray CR or LF remains — i.e. endings are uniform.
    expect(out.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  });

  it("appends a new key with the file's CRLF ending and terminates with CRLF", () => {
    const out = upsertEnvVars("HOST=127.0.0.1\r\nPORT=3000", { EXPLAIN_MODEL: "qwen2.5" });
    expect(out).toBe("HOST=127.0.0.1\r\nPORT=3000\r\nEXPLAIN_MODEL=qwen2.5\r\n");
  });
});

describe("removeEnvVars", () => {
  it("leaves empty content empty", () => {
    expect(removeEnvVars("", ["WHISPER_BINARY"])).toBe("");
  });

  it("drops active and commented lines for the given keys, keeping the rest", () => {
    const out = removeEnvVars(
      "WHISPER_BINARY=/bin/w\n# WHISPER_MODEL=small\nHOST=127.0.0.1\n",
      ["WHISPER_BINARY", "WHISPER_MODEL"]
    );
    expect(out).toBe("HOST=127.0.0.1\n");
  });

  it("terminates the result with a newline when the input does not", () => {
    expect(removeEnvVars("HOST=127.0.0.1", ["WHISPER_BINARY"])).toBe("HOST=127.0.0.1\n");
  });

  // #915 acceptance #3: dropping a key from CRLF content must keep endings uniform, not mix them.
  it("drops keys from CRLF content and keeps endings uniform", () => {
    const out = removeEnvVars(
      "WHISPER_BINARY=/bin/w\r\n# WHISPER_MODEL=small\r\nHOST=127.0.0.1\r\n",
      ["WHISPER_BINARY", "WHISPER_MODEL"]
    );
    expect(out).toBe("HOST=127.0.0.1\r\n");
  });

  it("terminates CRLF content with CRLF when the input has no trailing newline", () => {
    const out = removeEnvVars("HOST=127.0.0.1\r\nWHISPER_BINARY=/bin/w", ["WHISPER_BINARY"]);
    expect(out).toBe("HOST=127.0.0.1\r\n");
  });
});

describe("CRLF round-trip", () => {
  // #915 acceptance #4: upsert a key into CRLF content, parse the result, and get the value back.
  it("upserts a key into CRLF content and parses it back", () => {
    const out = upsertEnvVars("HOST=127.0.0.1\r\n# WHISPER_MODEL_PATH=\r\n", {
      WHISPER_MODEL_PATH: "small"
    });
    expect(out).toBe("HOST=127.0.0.1\r\nWHISPER_MODEL_PATH=small\r\n");
    expect(parseEnvVars(out)).toEqual({ HOST: "127.0.0.1", WHISPER_MODEL_PATH: "small" });
  });
});

describe("envPath", () => {
  it("resolves the root .env path", () => {
    const { ctx } = createFakeContext({ root: "/repo" });
    expect(envPath(ctx)).toBe("/repo/.env");
  });
});

describe("readEnv", () => {
  it("returns an empty map when .env does not exist", () => {
    const { ctx } = createFakeContext();
    expect(readEnv(ctx)).toEqual({});
  });

  it("parses the existing .env into a KEY=value map", () => {
    const { ctx } = createFakeContext({
      fileContents: { "/repo/.env": "EXPLAIN_MODEL=qwen2.5\n# COACH_API_KEY=\n" }
    });
    expect(readEnv(ctx)).toEqual({ EXPLAIN_MODEL: "qwen2.5" });
  });

  // #915 acceptance #2: a real CRLF `.env` must resolve the same configuration as its LF twin, so a
  // configured capability is not misread as missing on Windows.
  it("reads a CRLF .env into the same map as its LF twin", () => {
    const lf = "WHISPER_BINARY=/opt/whisper\nWHISPER_MODEL_PATH=small\n";
    const lfCtx = createFakeContext({ fileContents: { "/repo/.env": lf } }).ctx;
    const crlfCtx = createFakeContext({
      fileContents: { "/repo/.env": lf.replace(/\n/g, "\r\n") }
    }).ctx;
    expect(readEnv(crlfCtx)).toEqual(readEnv(lfCtx));
    expect(readEnv(crlfCtx)).toEqual({
      WHISPER_BINARY: "/opt/whisper",
      WHISPER_MODEL_PATH: "small"
    });
  });
});
