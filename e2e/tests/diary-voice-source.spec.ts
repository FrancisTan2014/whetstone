import type { Page } from "@playwright/test";

import { VOICE_CLIP_TRANSCRIPT, voiceClipFixture } from "../audioFixture";
import { expect, test } from "../fixtures";

// #801: a ready voice diary entry must be auditable against its retained recording without leaving the
// editor. This spec proves the real journey, in a real browser against the real server: submit an actual
// WAV clip → the (env-gated, input-derived) fixture speech lane transcribes it so the capture reaches
// `ready` → open the entry's editor → a compact Voice source row above the rich body plays and seeks the
// retained recording, reveals the verbatim transcript in a collapsed disclosure, and shows the detected
// language → correcting the body persists only the editable body while the retained source is untouched.
// The native player's play/seek behaviour and Chromium's real audio decode cannot be exercised in jsdom,
// so they are driven here; the audio range serving, DTO fields, and unavailable-recording state are
// additionally covered deterministically at the server and web unit layers.

// Reach a known theme from the shell's theme toggle (labelled by its DESTINATION). Idempotent.
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

test.describe("diary voice source audit (#801)", () => {
  test("audits a ready voice entry against its retained recording, then corrects the body", async ({
    page,
    setup
  }) => {
    const { baseURL } = setup;

    // Submit a real WAV clip straight to the endpoint (Playwright has no microphone): the audio is saved
    // and a queued capture created, then the worker transcribes it. The fixture speech lane returns a
    // transcript for genuine WAV bytes, so the capture reaches `ready` and a diary entry is created.
    const submitUrl = new URL("api/diary/voice-captures", baseURL).toString();
    const accepted = await page.request.post(submitUrl, {
      data: voiceClipFixture.buffer,
      headers: { "content-type": "application/octet-stream" }
    });
    expect(accepted.status()).toBe(202);
    const { id } = (await accepted.json()) as { id: string };

    // Wait for the worker to reach the terminal `ready` state, polling the real status endpoint so the UI
    // assertions below are deterministic. Its tidied text falls back to the raw transcript (no model).
    const statusUrl = new URL(`api/diary/voice-captures/${id}`, baseURL).toString();
    await expect
      .poll(
        async () => {
          const response = await page.request.get(statusUrl);
          const body = (await response.json()) as { status: string };
          return body.status;
        },
        { timeout: 15_000 }
      )
      .toBe("ready");

    // Open the Diary timeline; the ready voice entry renders as an ordinary entry (its body is the note).
    await page.goto(`${baseURL}#/diary`);
    const entry = page.locator("li", { hasText: "recorded diary note" });
    await expect(entry).toBeVisible();

    // Open its editor. A voice entry mounts the Voice source row above the rich editor.
    await entry.getByRole("button", { name: "Edit" }).click();
    const source = page.getByRole("region", { name: "Voice source" });
    await expect(source).toBeVisible();

    // The detected language is surfaced (the fixture transcribes as English).
    await expect(source.getByText("English")).toBeVisible();

    // The retained recording plays through the native player. It decodes to a finite duration (metadata
    // loaded without a media error), plays on demand, and seeks to an arbitrary offset.
    const player = source.getByLabel("Original recording");
    await expect(player).toBeVisible();
    await expect
      .poll(() => player.evaluate((el: HTMLAudioElement) => Number.isFinite(el.duration) && el.duration > 0))
      .toBe(true);
    await player.evaluate(async (el: HTMLAudioElement) => {
      await el.play();
    });
    await expect.poll(() => player.evaluate((el: HTMLAudioElement) => !el.paused)).toBe(true);
    await player.evaluate((el: HTMLAudioElement) => {
      el.pause();
      el.currentTime = 0.5;
    });
    await expect
      .poll(() => player.evaluate((el: HTMLAudioElement) => el.currentTime))
      .toBeGreaterThan(0.4);

    // The verbatim transcript is collapsed by default; revealing the disclosure shows the exact ASR text.
    const disclosure = source.getByText("Original transcript");
    await expect(source.getByLabel("Original transcript")).toBeHidden();
    await disclosure.click();
    await expect(source.getByLabel("Original transcript")).toHaveText(VOICE_CLIP_TRANSCRIPT);

    // The source row stays legible in both themes (Day and Night).
    for (const theme of ["day", "night"] as const) {
      await setTheme(page, theme);
      await expect(source.getByText("Voice source")).toBeVisible();
    }
    await setTheme(page, "day");

    // Correct the editable body. Only the rich body is persisted — the retained source is never rewritten.
    const editor = page.getByRole("textbox", { name: "Edit entry" });
    await editor.click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Delete");
    await page.keyboard.type("A corrected reflection");
    await page.getByRole("button", { name: "Save", exact: true }).click();

    const edited = page.locator("li", { hasText: "A corrected reflection" });
    await expect(edited).toBeVisible();

    // Reopening the entry still shows the untouched retained source: the same recording and transcript.
    await edited.getByRole("button", { name: "Edit" }).click();
    const reopened = page.getByRole("region", { name: "Voice source" });
    await expect(reopened.getByLabel("Original recording")).toBeVisible();
    await reopened.getByText("Original transcript").click();
    await expect(reopened.getByLabel("Original transcript")).toHaveText(VOICE_CLIP_TRANSCRIPT);
  });
});
