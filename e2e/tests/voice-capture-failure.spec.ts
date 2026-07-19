import type { Page } from "@playwright/test";

import { contrast } from "../probes";
import { expect, test } from "../fixtures";

// #675: a failed voice capture must explain what happened and offer a safe next step. This spec proves,
// in a real browser against the real server, the end-to-end failure path the booted stack can actually
// produce: the E2E stack runs with speech models disabled (the deterministic fake transcribes to empty),
// so a submitted recording fails with the `voice_setup_required` category. The card then renders the
// category's actionable copy, offers "Retry transcription" (this category is recoverable), and lets the
// learner discard the capture through a two-step inline confirm — after which it leaves the list.
//
// The other three categories (`no_speech`, `transcription_failed`, `recording_missing`) are not
// producible from a browser session (they need a configured speech engine, an adapter throw, or a
// deleted audio file), so their copy + retryability are covered deterministically at the server (worker)
// and web (CaptureCard) unit layers instead.

// Reach a known theme from the shell's theme toggle (labelled by its DESTINATION: "Switch to Night" shows
// in Day, "Switch to Day" shows in Night). Idempotent — only clicks when a flip is needed.
async function setTheme(page: Page, target: "day" | "night"): Promise<void> {
  const isNight = await page.evaluate(() => document.documentElement.classList.contains("dark"));
  if (isNight === (target === "night")) {
    return;
  }
  await page.getByRole("button", { name: isNight ? "Switch to Day" : "Switch to Night" }).click();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.classList.contains("dark")))
    .toBe(target === "night");
}

const SETUP_REQUIRED_COPY =
  "Voice transcription isn't set up. Run `pnpm setup:voice`, then retry transcription.";

test.describe("voice capture failure categories (#675)", () => {
  test("a failed capture explains what happened, offers retry, and can be discarded", async ({
    page,
    setup
  }) => {
    const { baseURL } = setup;
    const submitUrl = new URL("api/diary/voice-captures", baseURL).toString();

    // Submit a recording straight to the real endpoint (Playwright has no microphone): the raw audio is
    // saved and a `queued` capture is created, then the background worker transcribes it. With speech
    // unconfigured the transcript is empty, so the worker fails it as `voice_setup_required`.
    const accepted = await page.request.post(submitUrl, {
      data: Buffer.from("fake-clip-bytes"),
      headers: { "content-type": "application/octet-stream" }
    });
    expect(accepted.status()).toBe(202);
    const { id } = (await accepted.json()) as { id: string };

    // Wait for the worker to reach the terminal failed state (its status DTO carries the discriminated
    // failure), polling the real status endpoint so the UI assertions below are deterministic.
    const statusUrl = new URL(`api/diary/voice-captures/${id}`, baseURL).toString();
    await expect
      .poll(
        async () => {
          const response = await page.request.get(statusUrl);
          const body = (await response.json()) as {
            failure: { code: string; retryable: boolean } | null;
          };
          return body.failure?.code ?? null;
        },
        { timeout: 15_000 }
      )
      .toBe("voice_setup_required");

    // Open Today's capture surface, where the client rebuilds its pending/failed rows from the server.
    await page.goto(`${baseURL}#/`);
    await page.getByRole("button", { name: "New diary entry" }).click();
    const capture = page.getByRole("region", { name: "Capture today" });
    await expect(capture).toBeVisible();

    // The failed row is an alert carrying the category's plain-language copy — never a raw model/adapter
    // string — plus a "Retry transcription" affordance (this category is recoverable).
    const failedRow = capture.getByRole("alert");
    await expect(failedRow).toContainText(SETUP_REQUIRED_COPY);
    await expect(failedRow.getByRole("button", { name: "Retry transcription" })).toBeVisible();

    // The failed copy stays legible in both themes (WCAG AA text contrast >= 4.5:1), Day and Night.
    for (const theme of ["day", "night"] as const) {
      await setTheme(page, theme);
      const { minRatio } = await page.evaluate(contrast, '[role="alert"] span');
      expect(minRatio, `failure copy contrast in ${theme}`).toBeGreaterThanOrEqual(4.5);
    }

    // Discard is a guarded two-step inline confirm (no lost data by a single stray tap): the first tap
    // reveals the confirm, the second removes the capture and its saved audio.
    await failedRow.getByRole("button", { name: "Remove failed capture" }).click();
    await failedRow.getByRole("button", { name: "Remove", exact: true }).click();

    // The capture leaves the list: the pending/failed row is gone and it no longer resolves server-side.
    await expect(capture.getByRole("alert")).toHaveCount(0);
    await expect.poll(async () => (await page.request.get(statusUrl)).status()).toBe(404);
  });
});
