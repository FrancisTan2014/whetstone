import { expect, test } from "../fixtures";

// #647: the capture surface no longer has a 中文/EN language switch — Whisper auto-detects the spoken
// language and typed capture needs no language choice. This spec proves, in a real browser against the
// real server, that the toggle is gone and a typed capture still saves end to end without any language.
//
// The full "record Chinese and English audio through Whisper and preserve each transcript" acceptance
// scenario is not exercisable here: the E2E stack boots with models disabled (no Whisper backend) and
// Playwright has no real microphone, so STT has nothing to transcribe. That auto-detection path is
// covered deterministically by the server (worker) and web unit/integration tests instead.
test.describe("diary capture language removal (#647)", () => {
  test("Today capture has no language switch and a typed capture saves without one", async ({
    page,
    setup
  }) => {
    const { baseURL } = setup;

    await page.goto(`${baseURL}#/`);

    const capture = page.getByRole("region", { name: "Capture today" });
    await expect(capture).toBeVisible();

    // The retired 中文/EN toggle (and its stored preference) is gone from the capture surface.
    await expect(capture.getByRole("button", { name: "中文" })).toHaveCount(0);
    await expect(capture.getByRole("button", { name: "EN" })).toHaveCount(0);

    // A typed capture still saves end to end with no language choice: the box clears only on a successful
    // save against the real /api/diary/entries endpoint, which no longer accepts or requires a language.
    const box = capture.getByLabel("Capture text");
    await box.fill("today I shipped the capture-language removal");
    await capture.getByRole("button", { name: "Capture" }).click();
    await expect(box).toHaveValue("");
  });
});
