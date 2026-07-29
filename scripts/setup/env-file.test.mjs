import { describe, expect, it } from "vitest";

import { createFakeContext } from "./testSupport.mjs";
import { envPath, parseEnvVars, readEnv, removeEnvVars, upsertEnvVars } from "./env-file.mjs";

describe("parseEnvVars", () => {
  it("reads active KEY=value lines and ignores comments", () => {
    const vars = parseEnvVars("# EXPLAIN_MODEL=\nCOACH_CONVERSE_TIER=cheap\nHOST=127.0.0.1\n");
    expect(vars).toEqual({ COACH_CONVERSE_TIER: "cheap", HOST: "127.0.0.1" });
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
});
