import { expect, test } from "@playwright/test";

import { contentPresent, contrast, geometry, overlaps } from "../probes";

// Deterministic integration tests for the in-page probes (issue #314). Each test renders a static
// fixture with `page.setContent` (no app/stack navigation, no sleeps) and asserts the probe's
// numeric output, so the tester can file a visual bug on a computed value/rect, not on pixels.

test.describe("probes/contrast", () => {
  test("flags a low-contrast pair and reports its ratio", async ({ page }) => {
    await page.setContent('<p id="t" style="color:#999;background:#fff">low contrast caption</p>');

    const result = await page.evaluate(contrast, "#t");

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].text).toBe("low contrast caption");
    expect(result.failures[0].ratio).toBeLessThan(4.5);
    expect(result.failures[0].ratio).toBeCloseTo(2.85, 1);
    expect(result.minRatio).toBeLessThan(4.5);
  });

  test("passes a high-contrast pair with no failures", async ({ page }) => {
    await page.setContent('<p id="t" style="color:#000;background:#fff">readable body text</p>');

    const result = await page.evaluate(contrast, "#t");

    expect(result.failures).toEqual([]);
    expect(result.minRatio).toBeGreaterThanOrEqual(4.5);
    expect(result.minRatio).toBeCloseTo(21, 0);
  });

  test("walks ancestors for the effective background", async ({ page }) => {
    await page.setContent(
      '<div style="background:#777"><span id="t" style="color:#888">dim on grey</span></div>'
    );

    const result = await page.evaluate(contrast, "#t");

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].background).toBe("rgb(119, 119, 119)");
    expect(result.failures[0].ratio).toBeLessThan(4.5);
  });

  test("treats a transparent-over-dark text as readable via the ancestor walk", async ({
    page
  }) => {
    await page.setContent(
      '<div style="background:#000"><span id="t" style="color:#fff">light on dark</span></div>'
    );

    const result = await page.evaluate(contrast, "#t");

    expect(result.failures).toEqual([]);
    expect(result.minRatio).toBeCloseTo(21, 0);
  });
});

test.describe("probes/geometry", () => {
  test("flags an off-screen element", async ({ page }) => {
    await page.setContent(
      '<div id="t" style="position:fixed;left:-9999px;top:0;width:50px;height:50px"></div>'
    );

    const result = await page.evaluate(geometry, "#t");

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].flags).toContain("offScreen");
    expect(result.issues[0].flags).not.toContain("clipped");
  });

  test("flags an interactive target smaller than 44px", async ({ page }) => {
    await page.setContent('<button id="t" style="width:32px;height:32px">x</button>');

    const result = await page.evaluate(geometry, "#t");

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].flags).toContain("tooSmall");
    expect(result.issues[0].rect.width).toBeCloseTo(32, 0);
    expect(result.issues[0].rect.height).toBeCloseTo(32, 0);
  });

  test("raises no flags for a normal in-viewport element", async ({ page }) => {
    await page.setContent('<div id="t" style="width:100px;height:50px">ok</div>');

    const result = await page.evaluate(geometry, "#t");

    expect(result.issues).toEqual([]);
  });

  test("flags a child clipped by an overflow-hidden ancestor", async ({ page }) => {
    await page.setContent(
      '<div style="width:50px;height:50px;overflow:hidden">' +
        '<div id="t" style="width:200px;height:200px">spilling</div></div>'
    );

    const result = await page.evaluate(geometry, "#t");

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].flags).toContain("clipped");
  });

  test("overlaps is true for stacked boxes and false for separated ones", async ({ page }) => {
    await page.setContent(
      '<div class="a" style="position:absolute;left:0;top:0;width:50px;height:50px"></div>' +
        '<div class="b" style="position:absolute;left:10px;top:10px;width:50px;height:50px"></div>' +
        '<div class="c" style="position:absolute;left:0;top:0;width:50px;height:50px"></div>' +
        '<div class="d" style="position:absolute;left:500px;top:0;width:50px;height:50px"></div>'
    );

    expect(await page.evaluate(overlaps, [".a", ".b"])).toBe(true);
    expect(await page.evaluate(overlaps, [".c", ".d"])).toBe(false);
  });
});

test.describe("probes/contentPresent", () => {
  test("reports an empty zero-height surface as absent", async ({ page }) => {
    await page.setContent('<div id="t"></div>');

    const result = await page.evaluate(contentPresent, "#t");

    expect(result.present).toBe(false);
    expect(result.text).toBe("");
    expect(result.height).toBe(0);
  });

  test("reports a div with text as present", async ({ page }) => {
    await page.setContent('<div id="t">Hello there</div>');

    const result = await page.evaluate(contentPresent, "#t");

    expect(result.present).toBe(true);
    expect(result.text).toBe("Hello there");
    expect(result.height).toBeGreaterThan(0);
  });

  test("counts a zero-height element with text as present (text wins)", async ({ page }) => {
    await page.setContent('<div id="t" style="height:0;overflow:hidden">hidden text</div>');

    const result = await page.evaluate(contentPresent, "#t");

    expect(result.present).toBe(true);
    expect(result.text).toBe("hidden text");
    expect(result.height).toBe(0);
  });
});
