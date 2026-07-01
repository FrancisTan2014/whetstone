// The central step registry for v0 — one obvious, discoverable place. Adding a dependency later
// means dropping a step file in this folder and appending it here; the runner needs no change
// (open/closed). Order matters: preflight first, then install -> build (which needs install) ->
// browser -> env.

import { buildStep } from "./build.mjs";
import { envStep } from "./env.mjs";
import { installStep } from "./install.mjs";
import { playwrightStep } from "./playwright.mjs";
import { toolchainStep } from "./toolchain.mjs";
import { voiceStep } from "./voice.mjs";

/** @type {import("../step.mjs").Step[]} */
export const steps = [toolchainStep, installStep, buildStep, playwrightStep, envStep, voiceStep];
