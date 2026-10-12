import { readFileSync } from "node:fs";

import { test as base, expect } from "@playwright/test";

import { setupFile } from "./globalSetup";
import { type SetupData } from "./stack";

// React DOM-nesting / hydration warnings (e.g. "<li> cannot be a descendant of <li>"). These are
// the dev-mode runtime defects (issue #118) that unit/jsdom tests and code review miss; the suite
// runs the dev server so they surface, and fails on them.
const hydrationPattern = /hydrat|cannot be a (child|descendant)|validateDOMNesting/i;

function readSetup(): SetupData {
  return JSON.parse(readFileSync(setupFile, "utf8")) as SetupData;
}

// The seeded base URL + work ids, and a `page` that fails the test on any runtime defect: a
// console error, an uncaught page error, an app-origin HTTP 4xx/5xx, or a hydration/DOM-nesting
// warning. Asserting in fixture teardown means every test gets the guard with no per-test wiring.
export const test = base.extend<{ setup: SetupData }>({
  // Playwright requires fixtures to destructure their dependencies; this one needs none.
  // eslint-disable-next-line no-empty-pattern
  setup: async ({}, use) => {
    await use(readSetup());
  },
  page: async ({ page }, use, testInfo) => {
    const appOrigin = new URL(readSetup().baseURL).origin;
    const violations: string[] = [];

    page.on("console", (message) => {
      const type = message.type();
      const text = message.text();
      // The browser's own log line for a declared expected response (see the response guard below).
      const expectedLoad = testInfo.annotations.some(
        (annotation) =>
          annotation.type === "expected-http" &&
          text.startsWith(
            `Failed to load resource: the server responded with a status of ${annotation.description?.split(" ")[0]} `
          )
      );
      if ((type === "error" && !expectedLoad) || hydrationPattern.test(text)) {
        violations.push(`console.${type}: ${text}`);
      }
    });
    page.on("pageerror", (error) => {
      violations.push(`pageerror: ${error.message}`);
    });
    page.on("response", (response) => {
      const url = new URL(response.url());
      // A test that drives a failure path on purpose declares it: an `expected-http` annotation of exactly
      // `<status> <METHOD>` (e.g. `409 PUT`) exempts only that response.
      const signature = `${response.status()} ${response.request().method()}`;
      const expected = testInfo.annotations.some(
        (annotation) => annotation.type === "expected-http" && annotation.description === signature
      );
      if (
        response.status() >= 400 &&
        url.origin === appOrigin &&
        url.pathname !== "/favicon.ico" &&
        !expected
      ) {
        violations.push(`http ${signature} ${url.pathname}`);
      }
    });

    await use(page);

    expect(violations, `runtime defects detected:\n${violations.join("\n")}`).toEqual([]);
  }
});

export { expect };
