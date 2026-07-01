import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildStep } from "./build.mjs";
import { envStep } from "./env.mjs";
import { steps } from "./index.mjs";
import { installStep } from "./install.mjs";
import { playwrightStep, resolvePlaywrightCacheDir } from "./playwright.mjs";
import { parseNodeMajor, toolchainStep } from "./toolchain.mjs";
import { createFakeContext } from "../testSupport.mjs";

describe("registry", () => {
  it("orders the base steps: toolchain, install, build, playwright, env", () => {
    expect(steps.map((s) => s.id)).toEqual(["toolchain", "install", "build", "playwright", "env"]);
    for (const step of steps) {
      expect(step.optional).toBeUndefined();
    }
  });
});

describe("toolchain step", () => {
  const good = {
    "node -v": { code: 0, stdout: "v22.3.0", stderr: "" },
    "pnpm -v": { code: 0, stdout: "11.8.0", stderr: "" },
    "python --version": { code: 0, stdout: "Python 3.11.0", stderr: "" }
  };

  it("parseNodeMajor extracts the major or NaN", () => {
    expect(parseNodeMajor("v22.3.0")).toBe(22);
    expect(parseNodeMajor("22.1.0")).toBe(22);
    expect(parseNodeMajor("nonsense")).toBeNaN();
  });

  it("passes when Node >= 22, pnpm, and Python are present", () => {
    const { ctx, logs } = createFakeContext({ execResults: good });
    expect(toolchainStep.check(ctx)).toEqual({ status: "ok" });
    expect(logs.join("")).not.toContain("Python was not found");
  });

  it("reports missing Node when the version cannot be determined", () => {
    const { ctx } = createFakeContext({ execResults: { "node -v": { code: 1, stdout: "", stderr: "" } } });
    const result = toolchainStep.check(ctx);
    expect(result.status).toBe("missing");
    expect(result.what).toContain("Node.js version");
  });

  it("reports an outdated Node with an upgrade remedy", () => {
    const { ctx } = createFakeContext({
      execResults: { ...good, "node -v": { code: 0, stdout: "v20.0.0", stderr: "" } }
    });
    const result = toolchainStep.check(ctx);
    expect(result.status).toBe("missing");
    expect(result.what).toContain("too old");
    expect(result.remedy).toContain("22");
  });

  it("reports missing pnpm with a corepack remedy", () => {
    const { ctx } = createFakeContext({
      execResults: { ...good, "pnpm -v": { code: 1, stdout: "", stderr: "" } }
    });
    const result = toolchainStep.check(ctx);
    expect(result.status).toBe("missing");
    expect(result.remedy).toContain("corepack enable");
  });

  it("hints (but does not fail) when Python is absent", () => {
    const { ctx, logs } = createFakeContext({
      execResults: {
        ...good,
        "python --version": { code: 1, stdout: "", stderr: "" },
        "python3 --version": { code: 1, stdout: "", stderr: "" }
      }
    });
    expect(toolchainStep.check(ctx)).toEqual({ status: "ok" });
    expect(logs.join("")).toContain("Python was not found");
  });

  it("accepts python3 as the Python interpreter without a hint", () => {
    const { ctx, logs } = createFakeContext({
      execResults: {
        ...good,
        "python --version": { code: 1, stdout: "", stderr: "" },
        "python3 --version": { code: 0, stdout: "Python 3.12.0", stderr: "" }
      }
    });
    expect(toolchainStep.check(ctx)).toEqual({ status: "ok" });
    expect(logs.join("")).not.toContain("Python was not found");
  });
});

describe("install step", () => {
  const nodeModules = join("/repo", "node_modules");

  it("is ok when node_modules already exists", () => {
    const { ctx } = createFakeContext({ files: [nodeModules] });
    expect(installStep.check(ctx)).toEqual({ status: "ok" });
  });

  it("is missing when node_modules is absent", () => {
    const { ctx } = createFakeContext();
    expect(installStep.check(ctx).status).toBe("missing");
  });

  it("provisions via pnpm install and reports ok on success", () => {
    const { ctx, execCalls } = createFakeContext({
      execResults: { "pnpm install": { code: 0, stdout: "", stderr: "" } }
    });
    expect(installStep.provision(ctx)).toEqual({ status: "ok" });
    expect(execCalls).toContainEqual(["pnpm", "install"]);
  });

  it("maps a failing pnpm install to an actionable error with output tail", () => {
    const { ctx } = createFakeContext({
      execResults: { "pnpm install": { code: 1, stdout: "", stderr: "ERR_PNPM lockfile" } }
    });
    const result = installStep.provision(ctx);
    expect(result.status).toBe("error");
    expect(result.remedy).toContain("ERR_PNPM lockfile");
  });

  it("verify passes when node_modules now exists, errors otherwise", () => {
    expect(installStep.verify(createFakeContext({ files: [nodeModules] }).ctx)).toEqual({
      status: "ok"
    });
    expect(installStep.verify(createFakeContext().ctx).status).toBe("error");
  });
});

describe("build step", () => {
  const marker = join("/repo", "src", "packages", "domain", "dist", "index.js");

  it("is ok when the domain dist marker exists", () => {
    expect(buildStep.check(createFakeContext({ files: [marker] }).ctx)).toEqual({ status: "ok" });
  });

  it("is missing without built dist", () => {
    expect(buildStep.check(createFakeContext().ctx).status).toBe("missing");
  });

  it("provisions via pnpm build and maps failure to an error", () => {
    const okCtx = createFakeContext({ execResults: { "pnpm build": { code: 0, stdout: "", stderr: "" } } });
    expect(buildStep.provision(okCtx.ctx)).toEqual({ status: "ok" });
    expect(okCtx.execCalls).toContainEqual(["pnpm", "build"]);

    const failCtx = createFakeContext({
      execResults: { "pnpm build": { code: 1, stdout: "tsc error TS1005", stderr: "" } }
    });
    const result = buildStep.provision(failCtx.ctx);
    expect(result.status).toBe("error");
    expect(result.remedy).toContain("TS1005");
  });

  it("verify passes with the marker, errors without", () => {
    expect(buildStep.verify(createFakeContext({ files: [marker] }).ctx)).toEqual({ status: "ok" });
    expect(buildStep.verify(createFakeContext().ctx).status).toBe("error");
  });
});

describe("resolvePlaywrightCacheDir", () => {
  it("honors an explicit PLAYWRIGHT_BROWSERS_PATH", () => {
    expect(resolvePlaywrightCacheDir("linux", { PLAYWRIGHT_BROWSERS_PATH: "/custom" }, "/home")).toBe(
      "/custom"
    );
  });

  it("ignores the sentinel value 0 and uses the default", () => {
    const dir = resolvePlaywrightCacheDir("linux", { PLAYWRIGHT_BROWSERS_PATH: "0" }, "/home");
    expect(dir).toBe(join("/home", ".cache", "ms-playwright"));
  });

  it("uses LOCALAPPDATA on win32, falling back to AppData/Local", () => {
    expect(resolvePlaywrightCacheDir("win32", { LOCALAPPDATA: "C:/lad" }, "C:/home")).toBe(
      join("C:/lad", "ms-playwright")
    );
    expect(resolvePlaywrightCacheDir("win32", {}, "C:/home")).toBe(
      join("C:/home", "AppData", "Local", "ms-playwright")
    );
  });

  it("uses the macOS Caches path on darwin", () => {
    expect(resolvePlaywrightCacheDir("darwin", {}, "/Users/x")).toBe(
      join("/Users/x", "Library", "Caches", "ms-playwright")
    );
  });
});

describe("playwright step", () => {
  const cacheDir = join("/home/user", ".cache", "ms-playwright");

  it("is ok when a chromium build is cached", () => {
    const { ctx } = createFakeContext({ dirs: { [cacheDir]: ["chromium-1148", "ffmpeg-1011"] } });
    expect(playwrightStep.check(ctx)).toEqual({ status: "ok" });
  });

  it("is missing when the cache has no chromium build", () => {
    const { ctx } = createFakeContext({ dirs: { [cacheDir]: ["firefox-1"] } });
    expect(playwrightStep.check(ctx).status).toBe("missing");
  });

  it("provisions via playwright install and maps failure to an error", () => {
    const okCtx = createFakeContext({
      execResults: { "pnpm exec playwright install chromium": { code: 0, stdout: "", stderr: "" } }
    });
    expect(playwrightStep.provision(okCtx.ctx)).toEqual({ status: "ok" });
    expect(okCtx.execCalls).toContainEqual(["pnpm", "exec", "playwright", "install", "chromium"]);

    const failCtx = createFakeContext({
      execResults: {
        "pnpm exec playwright install chromium": { code: 1, stdout: "", stderr: "net timeout" }
      }
    });
    const result = playwrightStep.provision(failCtx.ctx);
    expect(result.status).toBe("error");
    expect(result.remedy).toContain("net timeout");
  });

  it("verify passes when chromium is cached, errors otherwise", () => {
    const okCtx = createFakeContext({ dirs: { [cacheDir]: ["chromium-1"] } });
    expect(playwrightStep.verify(okCtx.ctx)).toEqual({ status: "ok" });
    expect(playwrightStep.verify(createFakeContext().ctx).status).toBe("error");
  });
});

describe("env step", () => {
  const envFile = join("/repo", ".env");
  const example = join("/repo", ".env.example");

  it("is ok when .env already exists", () => {
    expect(envStep.check(createFakeContext({ files: [envFile] }).ctx)).toEqual({ status: "ok" });
  });

  it("is missing (scaffoldable) when only .env.example exists", () => {
    const result = envStep.check(createFakeContext({ files: [example] }).ctx);
    expect(result.status).toBe("missing");
  });

  it("errors when the template itself is gone", () => {
    const result = envStep.check(createFakeContext().ctx);
    expect(result.status).toBe("error");
    expect(result.what).toContain(".env.example is missing");
  });

  it("provisions by copying the example to .env", () => {
    const { ctx, copies } = createFakeContext({ files: [example] });
    expect(envStep.provision(ctx)).toEqual({ status: "ok" });
    expect(copies).toContainEqual([example, envFile]);
    expect(envStep.verify(ctx)).toEqual({ status: "ok" });
  });

  it("verify errors when .env was not created", () => {
    expect(envStep.verify(createFakeContext().ctx).status).toBe("error");
  });
});
