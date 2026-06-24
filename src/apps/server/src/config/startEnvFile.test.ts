import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// This config dir is src/apps/server/src/config; the package dir (where pnpm runs the
// `start` script, so where Node resolves --env-file-if-exists) is two levels up, and the
// repository root — where .env.example and QUICK_START tell users to create .env — is three
// levels above that.
const configDir = path.dirname(fileURLToPath(import.meta.url));
const serverPackageDir = path.resolve(configDir, "..", "..");
const repositoryRoot = path.resolve(serverPackageDir, "..", "..", "..");

type ServerPackageJson = Readonly<{ scripts: Readonly<{ start: string }> }>;

describe("server start script env file", () => {
  it("loads the repository-root .env so the documented MW keys are picked up", () => {
    const pkg = JSON.parse(
      readFileSync(path.join(serverPackageDir, "package.json"), "utf8")
    ) as ServerPackageJson;

    const match = /--env-file-if-exists=(\S+)/.exec(pkg.scripts.start);

    if (match === null) {
      throw new Error("start script must load an env file via --env-file-if-exists.");
    }

    // Node resolves the flag relative to the script's cwd (the server package dir); it must
    // therefore point at the repository-root .env, not a server-local one.
    const resolved = path.resolve(serverPackageDir, match[1] ?? "");
    expect(resolved).toBe(path.join(repositoryRoot, ".env"));
  });
});
