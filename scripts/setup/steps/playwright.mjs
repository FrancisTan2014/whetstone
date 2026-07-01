// Base step 4 — the Playwright Chromium browser used by the E2E gate (`pnpm e2e`). Readiness is a
// filesystem check of Playwright's browser cache (a `chromium-*` entry), which is accurate across
// platforms/cache locations and needs no fragile inline-script quoting; a re-run with the browser
// present skips the download. Provisioning shells out to Playwright's own idempotent installer.

import { join } from "node:path";

import { error, missing, ok, withOutputTail } from "../step.mjs";

/**
 * Resolve Playwright's browser cache directory. Mirrors Playwright's own resolution: an explicit
 * `PLAYWRIGHT_BROWSERS_PATH` wins (unless `0`, which means "next to the package" — treated as the
 * default cache for this heuristic), otherwise the per-OS cache location.
 *
 * @param {NodeJS.Platform} platform
 * @param {Record<string, string | undefined>} env
 * @param {string} home
 * @returns {string}
 */
export function resolvePlaywrightCacheDir(platform, env, home) {
  const override = env.PLAYWRIGHT_BROWSERS_PATH;
  if (override && override !== "0") {
    return override;
  }
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    return join(localAppData, "ms-playwright");
  }
  if (platform === "darwin") {
    return join(home, "Library", "Caches", "ms-playwright");
  }
  return join(home, ".cache", "ms-playwright");
}

/**
 * @param {import("../step.mjs").SetupContext} ctx
 * @returns {boolean}
 */
function chromiumPresent(ctx) {
  const cacheDir = resolvePlaywrightCacheDir(ctx.platform, ctx.env, ctx.home);
  return ctx.fs.readDir(cacheDir).some((name) => name.startsWith("chromium"));
}

/** @type {import("../step.mjs").Step} */
export const playwrightStep = {
  id: "playwright",
  title: "Playwright Chromium (for pnpm e2e)",
  check(ctx) {
    if (chromiumPresent(ctx)) {
      return ok();
    }
    return missing(
      "The Playwright Chromium browser is not installed.",
      "Run `pnpm exec playwright install chromium`."
    );
  },
  provision(ctx) {
    const result = ctx.exec("pnpm", ["exec", "playwright", "install", "chromium"]);
    if (result.code !== 0) {
      return error(
        "`playwright install chromium` failed.",
        withOutputTail(
          "Re-run `pnpm exec playwright install chromium`; this step downloads a browser, so check your network/proxy.",
          result
        )
      );
    }
    return ok();
  },
  verify(ctx) {
    if (chromiumPresent(ctx)) {
      return ok();
    }
    return error(
      "Chromium still could not be found in the Playwright cache after installation.",
      "Run `pnpm exec playwright install chromium` manually and inspect its output."
    );
  }
};
