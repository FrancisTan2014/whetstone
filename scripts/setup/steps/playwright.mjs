// Base step 4 — the Playwright Chromium browser used by the E2E gate (`pnpm e2e`).
//
// Readiness is verified against Playwright's own supported signal, not a loose cache scan. Playwright
// pins the browser to an exact revision for the installed `playwright` package; `playwright install
// chromium --dry-run` prints that exact revision's install location (e.g. `.../ms-playwright/
// chromium-1228`). We check that *specific* directory exists. This avoids a false pass on a machine
// whose shared cache holds a chromium build from a *different* Playwright version (an unrelated
// `chromium-<old>`): the required revision's directory is still absent, so the step provisions
// instead of leaving `pnpm e2e` to fail later. Provisioning shells out to Playwright's own
// idempotent installer.

import { error, missing, ok, withOutputTail } from "../step.mjs";

/**
 * Extract the Chromium *browser* install location from `playwright install --dry-run` output. The
 * dry run lists several packages (chromium, ffmpeg, chromium_headless_shell, winldd); only the
 * browser directory is named `chromium-<revision>` (a hyphen — the headless shell uses an
 * underscore), so match that and ignore the rest.
 *
 * @param {string} dryRunOutput
 * @returns {string | null}  The exact install directory, or null when it cannot be found.
 */
export function parseChromiumInstallLocation(dryRunOutput) {
  for (const line of dryRunOutput.split("\n")) {
    const match = /Install location:\s*(.+?)\s*$/.exec(line);
    if (match && /[\\/]chromium-\d+$/.test(match[1])) {
      return match[1];
    }
  }
  return null;
}

/**
 * The exact revision's install directory for the installed package, via Playwright's dry run, or
 * null when Playwright cannot report it.
 *
 * @param {import("../step.mjs").SetupContext} ctx
 * @returns {string | null}
 */
function requiredChromiumLocation(ctx) {
  const result = ctx.exec("pnpm", ["exec", "playwright", "install", "chromium", "--dry-run"]);
  if (result.code !== 0) {
    return null;
  }
  return parseChromiumInstallLocation(result.stdout);
}

/**
 * @param {import("../step.mjs").SetupContext} ctx
 * @returns {boolean}
 */
function chromiumInstalled(ctx) {
  const location = requiredChromiumLocation(ctx);
  return location !== null && ctx.fs.exists(location);
}

/** @type {import("../step.mjs").Step} */
export const playwrightStep = {
  id: "playwright",
  title: "Playwright Chromium (for pnpm e2e)",
  check(ctx) {
    if (chromiumInstalled(ctx)) {
      return ok();
    }
    return missing(
      "The Chromium revision this package's Playwright requires is not installed.",
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
    if (chromiumInstalled(ctx)) {
      return ok();
    }
    return error(
      "The required Chromium revision still could not be verified after installation.",
      "Run `pnpm exec playwright install chromium` manually and inspect its output."
    );
  }
};
