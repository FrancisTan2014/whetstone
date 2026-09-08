import { type Page } from "@playwright/test";

import { selectExactTextIn } from "../select";
import { type SetupData } from "../stack";
import { expect, test } from "../fixtures";

// The Reader's explicit "Explain meanings" journey (#924/#925): the organizing core behind a
// selection's meanings, its principal branches, and a clear "Used here" marker on the branch the
// passage actually uses — reached only through an explicit action, never eagerly on selection/open.
//
// Real-stack coverage: every outcome below EXCEPT the one explicitly marked "route-stubbed" drives the
// REAL Fastify server behind a deterministic, dev/E2E-only fixture `Agent`
// (`explainFixtureAgent.ts`, wired by `e2e/stack.ts`'s `AGENT_COPILOT_EXPLAIN_FIXTURE=1`) — a real HTTP
// request, real Zod-validated contract parsing, real cache/coalescing/deadline wiring, and a real typed
// response the Reader renders. It is a fixture E2E (a canned model), NOT live provider evidence; the v2
// prompt itself already has real English/Chinese Copilot probes from #924. The one exception — the
// disabled-capability remedy — cannot be produced by this shared, single-process E2E stack (the feature
// flag is read once at server boot for the whole suite), so that ONE test narrowly stubs the read-only
// `GET /api/explain/capability` response at the network layer with `page.route`, clearly marked below.

const READING = 'article[aria-label="Reading"]';
const DESKTOP = { height: 900, width: 1280 } as const;
const MOBILE = { height: 844, width: 390 } as const;

const explainButton = (page: Page) => page.getByRole("button", { name: "Explain meanings" });
const retryButton = (page: Page) => page.getByRole("button", { name: "Try again" });

// Every paragraph is its own block, so its 480-code-unit selection-centered server context never
// bleeds into another paragraph's magic fixture headword or "coiled"/"电话" trigger text.
const DEVICE_SPRING =
  "The mechanic replaced the tightly coiled spring inside the old rusty clock before shutting the case again.";
const SEASON_SPRING =
  "Every year the garden bursts into a fresh spring with warmer afternoons beside the quiet river.";
const BREAK_TRANSPORT =
  "The diagnostics briefly reported a breaktransport fault before the system recovered on the very next retry.";
const BAD_JSON =
  "The assistant once returned badjson text instead of a real structured answer during testing.";
const TIMEOUT_TEST =
  "The request used timeouttest and never returned an answer before the deadline passed.";
const ZH_PARAGRAPH = "他明天要给我打电话，周末我们打算一起打篮球。";

async function seedMarkdownWork(
  page: Page,
  setup: SetupData,
  title: string,
  language: string,
  paragraphs: ReadonlyArray<string>
): Promise<{ readerUrl: string; workEntryId: string }> {
  const markdown = `# ${title}\n\n${paragraphs.join("\n\n")}\n`;
  const created = await page.request.post(`${setup.baseURL}api/works/markdown`, {
    data: {
      author: { mode: "new", name: `${title} Author` },
      fileName: `${title.replace(/\s+/g, "-")}.md`,
      language,
      markdown,
      title,
      workType: "essay"
    }
  });
  expect(created.ok(), `create → ${created.status()}`).toBe(true);
  const { result, status } = (await created.json()) as {
    result: { work: { entryId: string } };
    status: string;
  };
  expect(status).toBe("created");

  const readerUrl = `${setup.baseURL}#/reader?work=${encodeURIComponent(result.work.entryId)}`;
  await page.goto(readerUrl);
  await expect(page.locator(`${READING} [data-block-id]`).first()).toBeVisible();

  return { readerUrl, workEntryId: result.work.entryId };
}

// Select `word` inside the block containing `needle`, open the toolbar, then open the lookup panel —
// the same real selection → toolbar → "Look up" chain every dictionary lookup already goes through.
async function openLookupFor(page: Page, needle: string, word: string): Promise<void> {
  const block = page
    .locator(`${READING} [data-block-id]`)
    .filter({ hasText: needle })
    .first();
  const blockId = await block.getAttribute("data-block-id");
  await selectExactTextIn(page, `${READING} [data-block-id="${blockId}"]`, word);
  await expect(page.getByRole("toolbar", { name: "Annotate selection" })).toBeVisible();
  await page.getByRole("button", { name: "Look up" }).click();
  await expect(page.getByRole("dialog", { name: /^Look up:/ })).toBeVisible();
}

test.describe("Reader: Explain meanings (#924/#925)", () => {
  test.use({ viewport: DESKTOP });

  test("dictionaries stay AI-free until the explicit action, then explains the coiled-spring device sense with real request/response evidence", async ({
    page,
    setup
  }) => {
    const work = await seedMarkdownWork(page, setup, "Explain Spring Device", "en", [
      DEVICE_SPRING,
      SEASON_SPRING
    ]);

    const requestUrls: string[] = [];
    page.on("request", (request) => requestUrls.push(request.url()));

    await openLookupFor(page, "coiled spring", "spring");

    // The dictionary tabs load and render fully with no AI request of any kind — the legacy
    // `source=llm` gloss is never called, and no POST to /api/explain fires merely from opening
    // lookup, and switching dictionary tabs fires no AI request either.
    const dialog = page.getByRole("dialog", { name: /^Look up:/ });
    await expect(dialog.getByRole("tab", { name: "WordNet" })).toBeVisible();
    await dialog.getByRole("tab", { name: "Wiktionary" }).click();
    await expect(dialog.getByRole("tab", { name: "Wiktionary", selected: true })).toBeVisible();

    // Wait for the lazily-loaded Explain section to finish its mount-time capability check (proving it
    // resolved) before inspecting which requests actually fired, so this never races the chunk load.
    await expect(dialog.getByText("Explain meanings sends this selected text to Copilot")).toBeVisible();

    expect(requestUrls.some((url) => url.includes("source=llm"))).toBe(false);
    expect(requestUrls.some((url) => url.endsWith("/api/explain"))).toBe(false);
    // The read-only capability probe DOES fire on mount — it never invokes a model.
    expect(requestUrls.some((url) => url.endsWith("/api/explain/capability"))).toBe(true);

    const button = explainButton(page);
    await expect(button).toBeVisible();
    // >=44px in both dimensions (#502), measured on the real rendered control, not just its CSS rule.
    const box = await button.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);

    const [explainRequest] = await Promise.all([
      page.waitForRequest((request) => request.url().endsWith("/api/explain") && request.method() === "POST"),
      button.click()
    ]);
    const body = explainRequest.postDataJSON() as {
      blockEntryId: string;
      endOffset: number;
      selectedText: string;
      startOffset: number;
      workEntryId: string;
    };
    expect(body.selectedText).toBe("spring");
    expect(body.endOffset - body.startOffset).toBe("spring".length);
    expect(body.workEntryId).toBe(work.workEntryId);

    await expect(dialog.getByText("Asking Copilot for the semantic map…")).toBeVisible();

    // The organizing core leads for BOTH sense families (never a bare branch list), the device family
    // is marked current (the fixture keys this off the REAL resolved "coiled" context), its two
    // branches both render, and the current-passage marker sits on "leap suddenly" — exactly the
    // branch the fixture's own context-driven logic names current, not a hardcoded default.
    await expect(dialog.getByText("the season of renewal that follows winter")).toBeVisible();
    await expect(dialog.getByText("a coiled mechanism that stores and releases energy")).toBeVisible();
    await expect(dialog.getByText("mechanical coil")).toBeVisible();
    const leapBranch = dialog.locator(".explainBranch", { hasText: "leap suddenly" });
    await expect(leapBranch.getByText("Used here")).toBeVisible();
    await expect(dialog.locator(".explainBranch", { hasText: "the season" }).getByText("Used here")).toHaveCount(0);
    await expect(dialog.locator(".explainBranch", { hasText: "mechanical coil" }).getByText("Used here")).toHaveCount(0);

    // Supporting details render only the fields the fixture actually supplied (pronunciation, nuance,
    // etymology) — never usage/cultural notes it omitted.
    await expect(dialog.getByText("/sprɪŋ/")).toBeVisible();
    await expect(dialog.getByText("An everyday, neutral word in every sense")).toBeVisible();
    await expect(dialog.getByText('From Old English "springan"')).toBeVisible();
    await expect(dialog.getByText("Nuance")).toBeVisible();
    await expect(dialog.getByText("Origin")).toBeVisible();
    await expect(dialog.getByText("Usage")).toHaveCount(0);
    await expect(dialog.getByText("Culture")).toHaveCount(0);

    // The real provider-reported attribution renders as safe text, never fabricated from a requested
    // default the fixture never claimed.
    await expect(dialog.getByText("fixture-copilot-model · fixture-high")).toBeVisible();

    // The AI interpretation stays visibly separate from the dictionary evidence above it.
    await expect(dialog.getByRole("note", { name: "AI-generated explanation, may be imperfect" })).toBeVisible();
  });

  test("marks the season family current for the same headword in a different passage", async ({
    page,
    setup
  }) => {
    await seedMarkdownWork(page, setup, "Explain Spring Season", "en", [
      DEVICE_SPRING,
      SEASON_SPRING
    ]);

    await openLookupFor(page, "bursts into a fresh spring", "spring");
    const dialog = page.getByRole("dialog", { name: /^Look up:/ });
    await explainButton(page).click();

    const seasonBranch = dialog.locator(".explainBranch", { hasText: "the season" });
    await expect(seasonBranch.getByText("Used here")).toBeVisible();
    await expect(dialog.locator(".explainBranch", { hasText: "leap suddenly" }).getByText("Used here")).toHaveCount(0);
  });

  test("explains a Chinese verb with one organizing core and several branches, marking the phone-call sense", async ({
    page,
    setup
  }) => {
    await seedMarkdownWork(page, setup, "语义查词样例", "zh-CN", [ZH_PARAGRAPH]);

    await openLookupFor(page, "打电话", "打");
    const dialog = page.getByRole("dialog", { name: /^Look up:/ });
    // The Chinese dictionary tabs (萌典 leads, #272) load fully, independent of the AI action below.
    await expect(dialog.getByRole("tab", { name: "萌典" })).toBeVisible();

    await explainButton(page).click();
    await expect(dialog.getByText("用手或借助动作对某物施加力量")).toBeVisible();
    await expect(dialog.getByText("打：击打")).toBeVisible();
    await expect(dialog.getByText("打：打球")).toBeVisible();
    const callBranch = dialog.locator(".explainBranch", { hasText: "打：打电话" });
    await expect(callBranch.getByText("Used here")).toBeVisible();
    await expect(dialog.locator(".explainBranch", { hasText: "打：击打" }).getByText("Used here")).toHaveCount(0);

    await expect(dialog.getByText("dǎ")).toBeVisible();
    await expect(dialog.getByText("非常口语化")).toBeVisible();
    // A genuinely monosemous-core answer never fabricates etymology/usage/culture the model omitted.
    await expect(dialog.getByText("Origin")).toHaveCount(0);
    await expect(dialog.getByText("Usage")).toHaveCount(0);
    await expect(dialog.getByText("Culture")).toHaveCount(0);
  });

  // Route-stubbed: the ONLY non-real-request outcome in this suite. The shared single-process E2E
  // stack reads AGENT_COPILOT_EXPLAIN_ENABLED once at server boot for the whole run, so a genuinely
  // disabled capability cannot be produced by a real request within this run. The remedy text is the
  // server's own real copy (`explainConfig.ts`'s `disabledRemedy`), so the rendered message stays
  // truthful to what a real disabled deploy actually tells the learner.
  test("shows the exact disabled remedy without ever generating a turn (route-stubbed capability)", async ({
    page,
    setup
  }) => {
    const remedy =
      "Set AGENT_COPILOT_EXPLAIN_ENABLED=1 to opt in, and ensure the Copilot CLI this seam spawns is " +
      "authenticated (see docs/AGENT.md). Enabling it does not by itself prove authentication or model " +
      "generation will succeed — that is only known once a real explanation request is made.";
    await page.route("**/api/explain/capability", async (route) => {
      await route.fulfill({
        body: JSON.stringify({ enabled: false, reason: "feature_disabled", remedy }),
        contentType: "application/json",
        status: 200
      });
    });

    await seedMarkdownWork(page, setup, "Explain Disabled", "en", [DEVICE_SPRING]);
    const requestUrls: string[] = [];
    page.on("request", (request) => requestUrls.push(request.url()));

    await openLookupFor(page, "coiled spring", "spring");
    const dialog = page.getByRole("dialog", { name: /^Look up:/ });

    // Dictionaries still fully work with the capability off.
    await expect(dialog.getByRole("tab", { name: "WordNet" })).toBeVisible();
    await expect(dialog.getByText(`Explain meanings is turned off. ${remedy}`)).toBeVisible();
    await expect(explainButton(page)).toHaveCount(0);
    expect(requestUrls.some((url) => url.endsWith("/api/explain"))).toBe(false);
  });

  test("recovers from an honest transport failure via explicit retry, without losing dictionary results", async ({
    page,
    setup
  }) => {
    await seedMarkdownWork(page, setup, "Explain Break Transport", "en", [BREAK_TRANSPORT]);
    await openLookupFor(page, "breaktransport fault", "breaktransport");
    const dialog = page.getByRole("dialog", { name: /^Look up:/ });

    await explainButton(page).click();
    await expect(dialog.getByText("Could not reach Copilot. Check your connection and try again.")).toBeVisible();
    // The failed optional explanation never destroys the dictionary results rendered above it.
    await expect(dialog.getByRole("tab", { name: "WordNet" })).toBeVisible();

    await retryButton(page).click();
    await expect(dialog.getByText("a minimal recovered explanation with no optional fields")).toBeVisible();
    await expect(dialog.locator(".explainBranchLabel", { hasText: "recovered" })).toBeVisible();
    // The recovered answer carries no provider attribution the runtime never reported — never invented.
    await expect(dialog.locator(".explainProvider")).toHaveCount(0);
  });

  test("shows an honest invalid-response failure for a malformed model answer", async ({ page, setup }) => {
    await seedMarkdownWork(page, setup, "Explain Bad Json", "en", [BAD_JSON]);
    await openLookupFor(page, "badjson text", "badjson");
    const dialog = page.getByRole("dialog", { name: /^Look up:/ });

    await explainButton(page).click();
    await expect(dialog.getByText("Copilot returned an answer that could not be understood.")).toBeVisible();
    await expect(retryButton(page)).toBeVisible();
  });

  test("shows an honest timeout after the deadline, with no premature false failure", async ({
    page,
    setup
  }) => {
    await seedMarkdownWork(page, setup, "Explain Timeout", "en", [TIMEOUT_TEST]);
    await openLookupFor(page, "timeouttest and never", "timeouttest");
    const dialog = page.getByRole("dialog", { name: /^Look up:/ });

    await explainButton(page).click();
    await expect(dialog.getByText("Asking Copilot for the semantic map…")).toBeVisible();
    // The E2E harness shortens the owned deadline to 3s (`AGENT_COPILOT_EXPLAIN_TURN_TIMEOUT_MS`) so
    // this proves the truthful "timeout" outcome without waiting out the real 150s production bound —
    // and, since Playwright's own `expect` timeout (15s) comfortably exceeds it, never a false early
    // failure from a client-side timeout shorter than the SDK's own generation bound.
    await expect(dialog.getByText("The explanation is taking too long. Try again in a moment.")).toBeVisible();
    await expect(retryButton(page)).toBeVisible();
  });

  test("isolates a superseded pending request from a new selection's answer", async ({
    page,
    setup
  }) => {
    await seedMarkdownWork(page, setup, "Explain Stale Isolation", "en", [
      TIMEOUT_TEST,
      DEVICE_SPRING
    ]);

    await openLookupFor(page, "timeouttest and never", "timeouttest");
    await explainButton(page).click();
    await expect(page.getByText("Asking Copilot for the semantic map…")).toBeVisible();

    // Close the panel and select a different passage WHILE the first request is still in flight (the
    // fixture's "timeouttest" headword never resolves on its own): the parent's `key={lookup.requestId}`
    // fully remounts the panel (and the lazy `ExplainSection` inside it) on every new selection, so the
    // superseded request's own effect cleanup aborts it rather than letting it paint later.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: /^Look up:/ })).toBeHidden();

    await openLookupFor(page, "coiled spring", "spring");
    const dialog = page.getByRole("dialog", { name: /^Look up:/ });
    await explainButton(page).click();
    await expect(dialog.getByText("a coiled mechanism that stores and releases energy")).toBeVisible();
    // The superseded "timeouttest" request never paints its (eventual) timeout message under the new term.
    await expect(dialog.getByText("The explanation is taking too long")).toHaveCount(0);
  });

  test("Escape closes the lookup popover", async ({ page, setup }) => {
    await seedMarkdownWork(page, setup, "Explain Escape", "en", [DEVICE_SPRING]);
    await openLookupFor(page, "coiled spring", "spring");
    await expect(explainButton(page)).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: /^Look up:/ })).toBeHidden();
  });

  test("mobile: the bottom Sheet offers the same explicit action and result", async ({ page, setup }) => {
    await page.setViewportSize(MOBILE);
    await seedMarkdownWork(page, setup, "Explain Mobile", "en", [DEVICE_SPRING]);
    await openLookupFor(page, "coiled spring", "spring");

    const dialog = page.getByRole("dialog", { name: /^Look up:/ });
    await expect(dialog.getByRole("tab", { name: "WordNet" })).toBeVisible();
    const button = explainButton(page);
    await expect(button).toBeVisible();
    const box = await button.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);

    await button.click();
    await expect(dialog.getByText("a coiled mechanism that stores and releases energy")).toBeVisible();
    const leapBranch = dialog.locator(".explainBranch", { hasText: "leap suddenly" });
    await expect(leapBranch.getByText("Used here")).toBeVisible();
  });
});
