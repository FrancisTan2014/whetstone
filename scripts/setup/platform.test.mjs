import { describe, expect, it } from "vitest";

import { cmdShimSpawnOptions, resolveCommand } from "./platform.mjs";

describe("resolveCommand", () => {
  it("appends .cmd to node-bin shims on win32", () => {
    expect(resolveCommand("pnpm", "win32")).toBe("pnpm.cmd");
    expect(resolveCommand("npx", "win32")).toBe("npx.cmd");
    expect(resolveCommand("corepack", "win32")).toBe("corepack.cmd");
  });

  it("leaves non-shim commands unchanged on win32", () => {
    expect(resolveCommand("node", "win32")).toBe("node");
    expect(resolveCommand("python", "win32")).toBe("python");
  });

  it("is identity on posix platforms", () => {
    expect(resolveCommand("pnpm", "linux")).toBe("pnpm");
    expect(resolveCommand("pnpm", "darwin")).toBe("pnpm");
    expect(resolveCommand("node", "linux")).toBe("node");
  });
});

describe("cmdShimSpawnOptions", () => {
  it("passes a shell on win32 so Node can spawn the `.cmd` shim (no spawn EINVAL)", () => {
    expect(cmdShimSpawnOptions("win32")).toEqual({ stdio: "inherit", shell: true });
  });

  it("uses no shell on posix platforms", () => {
    expect(cmdShimSpawnOptions("linux")).toEqual({ stdio: "inherit", shell: false });
    expect(cmdShimSpawnOptions("darwin")).toEqual({ stdio: "inherit", shell: false });
  });
});
