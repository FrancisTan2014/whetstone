import { type Locator, type Page } from "@playwright/test";

import { selectExactTextIn } from "../select";
import { type SetupData } from "../stack";
import { expect, test } from "../fixtures";

// The Reader's explicit "Explain meanings" journey (#924/#925): the organizing core behind a
// selection's meanings, its principal branches, and a clear "Used here" marker on the branch the
// passage actually uses — reached only through an explicit action, never eagerly on selection/open.
//
// Real-stack coverage: every outcome below EXCEPT the ones explicitly marked "route-stubbed" drives
// the REAL Fastify server behind a deterministic, dev/E2E-only fixture `Agent`
// (`explainFixtureAgent.ts`, wired by `e2e/stack.ts`'s `AGENT_COPILOT_EXPLAIN_FIXTURE=1`) — a real HTTP
// request, real Zod-validated contract parsing, real cache/coalescing/deadline wiring, and a real typed
// response the Reader renders. It is a fixture E2E (a canned model), NOT live provider evidence; the v2
// prompt itself already has real English/Chinese Copilot probes from #924. The route-stubbed cases
// exist ONLY where the shared single-process E2E stack genuinely cannot produce that outcome for real
// (a disabled capability, read once at server boot for the whole run; and a controlled capability-probe
// failure/recovery sequence, which needs a network-layer stub to force a rejection deterministically) —
// each is clearly marked below and never substitutes for the real-request coverage elsewhere.

const READING = 'article[aria-label="Reading"]';
const DESKTOP = { height: 900, width: 1280 } as const;
const MOBILE = { height: 844, width: 390 } as const;

const explainButton = (page: Page) => page.getByRole("button", { name: "Explain meanings" });
const retryButton = (page: Page) => page.getByRole("button", { name: "Try again" });
const lookupDialog = (page: Page) => page.getByRole("dialog", { name: /^Look up:/ });

// A real homograph (two genuinely unrelated etymologies — Old Norse "bakki" vs. Italian "banca", never
// one fabricated universal root, #925 correction) with distinct passages that key the fixture's own
// context-driven current-family/branch marker: `BANK_RIVER` triggers no marker word (first family,
// first branch); `BANK_TILT` triggers the SECOND branch of that same first family; `BANK_ACCOUNT` and
// `BANK_RELY` each trigger the second (financial) family's first and second branches respectively — so
// together they exercise every combination and a hardcoded-first-marker bug fails at least one.
const BANK_RIVER =
  "The hikers stopped to rest on the muddy bank beside the winding river before continuing home.";
const BANK_TILT = "The pilot had to bank the small aircraft in a sharp maneuver toward the runway.";
const BANK_ACCOUNT =
  "She walked into town and opened a new savings account at her local bank branch on her first payday.";
const BANK_RELY =
  "Whatever happens next, you can always bank on him to lend a steady hand when it matters most.";
const BREAK_TRANSPORT =
  "The diagnostics briefly reported a breaktransport fault before the system recovered on the very next retry.";
const BAD_JSON =
  "The assistant once returned badjson text instead of a real structured answer during testing.";
const TIMEOUT_TEST =
  "The request used timeouttest and never returned an answer before the deadline passed.";
const ZH_PARAGRAPH = "他明天要给我打电话，周末我们打算一起打篮球。";

// "bank" is a genuine WordNet homograph with 12 real senses (6 noun + 6 verb) — long enough that its
// full dictionary entry overflows the lookup popover's initial viewport, the exact shape a learner
// meets on an ordinary long entry. Used for the discoverability tests below (#925 correction): the
// action must be reachable in the INITIAL viewport before any scroll, not merely reachable via
// Playwright's implicit auto-scroll on `.click()`/`.toBeVisible()`.
const LONG_ENTRY_PASSAGE = BANK_RIVER;

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
  const block = page.locator(`${READING} [data-block-id]`).filter({ hasText: needle }).first();
  const blockId = await block.getAttribute("data-block-id");
  await selectExactTextIn(page, `${READING} [data-block-id="${blockId}"]`, word);
  await expect(page.getByRole("toolbar", { name: "Annotate selection" })).toBeVisible();
  await page.getByRole("button", { name: "Look up" }).click();
  await expect(lookupDialog(page)).toBeVisible();
}

// Whether `inner`'s box sits entirely within `outer`'s box — proves an element is reachable in the
// CURRENT visible viewport of its scrollable ancestor, without relying on `.click()`/`.toBeVisible()`'s
// own implicit auto-scroll (#925 correction: that auto-scroll previously masked that the action was not
// actually in the initial viewport for a long entry). A small epsilon absorbs sub-pixel rounding.
function isWithinViewport(
  outer: { height: number; y: number } | null,
  inner: { height: number; y: number } | null,
  epsilon = 2
): boolean {
  if (outer === null || inner === null) {
    return false;
  }
  return inner.y >= outer.y - epsilon && inner.y + inner.height <= outer.y + outer.height + epsilon;
}

async function assertReachableWithoutScrolling(dialog: Locator, target: Locator): Promise<void> {
  const dialogBox = await dialog.boundingBox();
  const targetBox = await target.boundingBox();
  expect(
    isWithinViewport(dialogBox, targetBox),
    `expected element ${JSON.stringify(targetBox)} to be within the dialog's own visible viewport ${JSON.stringify(dialogBox)} without scrolling`
  ).toBe(true);
}

test.describe("Reader: Explain meanings (#924/#925)", () => {
  test.use({ viewport: DESKTOP });

  test("dictionaries stay AI-free until the explicit action, then explains the riverside sense with real request/response evidence", async ({
    page,
    setup
  }) => {
    const work = await seedMarkdownWork(page, setup, "Explain Bank River", "en", [
      BANK_RIVER,
      BANK_ACCOUNT
    ]);

    const requestUrls: string[] = [];
    page.on("request", (request) => requestUrls.push(request.url()));

    await openLookupFor(page, "muddy bank", "bank");

    // The dictionary tabs load and render fully with no AI request of any kind — the legacy
    // `source=llm` gloss is never called, and no POST to /api/explain fires merely from opening
    // lookup, and switching dictionary tabs fires no AI request either.
    const dialog = lookupDialog(page);
    await expect(dialog.getByRole("tab", { name: "WordNet" })).toBeVisible();
    await dialog.getByRole("tab", { name: "Wiktionary" }).click();
    await expect(dialog.getByRole("tab", { name: "Wiktionary", selected: true })).toBeVisible();

    // Wait for the lazily-loaded Explain section to finish its mount-time capability check (proving it
    // resolved) before inspecting which requests actually fired, so this never races the chunk load.
    // The consent copy names BOTH the selected word/phrase AND the surrounding passage (#925
    // correction): the API sends more than the literal selection, so the disclosure must say so.
    await expect(
      dialog.getByText(
        "Explain meanings sends the selected word or phrase, and a short surrounding passage, to Copilot"
      )
    ).toBeVisible();

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
      page.waitForRequest(
        (request) => request.url().endsWith("/api/explain") && request.method() === "POST"
      ),
      button.click()
    ]);
    const body = explainRequest.postDataJSON() as {
      blockEntryId: string;
      endOffset: number;
      selectedText: string;
      startOffset: number;
      workEntryId: string;
    };
    expect(body.selectedText).toBe("bank");
    expect(body.endOffset - body.startOffset).toBe("bank".length);
    expect(body.workEntryId).toBe(work.workEntryId);

    // The loading state itself ("Asking Copilot for the semantic map…") is proven durably by the
    // timeout test below, which holds it open for the whole deadline; the fixture's synchronous "bank"
    // response can resolve before this assertion's very first poll, so asserting it here would be
    // inherently racy rather than meaningful.

    // The organizing core leads for BOTH sense families (never a bare branch list), the river family
    // is marked current (the fixture keys this off the REAL resolved context, with no marker word
    // present), its two branches both render, and the current-passage marker sits on "a riverbank or
    // lakeshore" — exactly the branch the fixture's own context-driven logic names current.
    await expect(dialog.getByText("a sloping earthen edge, as beside a river")).toBeVisible();
    await expect(dialog.getByText("an institution that holds and manages money")).toBeVisible();
    await expect(dialog.getByText("to tilt or lean sideways")).toBeVisible();
    const riverBranch = dialog.locator(".explainBranch", { hasText: "a riverbank or lakeshore" });
    await expect(riverBranch.getByText("Used here")).toBeVisible();
    await expect(
      dialog
        .locator(".explainBranch", { hasText: "to tilt or lean sideways" })
        .getByText("Used here")
    ).toHaveCount(0);
    await expect(
      dialog
        .locator(".explainBranch", { hasText: "a financial institution" })
        .getByText("Used here")
    ).toHaveCount(0);

    // Supporting details render only the fields the fixture actually supplied (pronunciation, nuance,
    // etymology) — never usage/cultural notes it omitted.
    await expect(dialog.getByText("/b\u00e6\u014bk/")).toBeVisible();
    await expect(dialog.getByText("An everyday, neutral word in every sense")).toBeVisible();
    // The etymology names TWO genuinely separate origins — never a single fabricated shared root.
    await expect(dialog.getByText(/two unrelated origins/)).toBeVisible();
    await expect(dialog.getByText("Nuance")).toBeVisible();
    await expect(dialog.getByText("Origin", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Usage")).toHaveCount(0);
    await expect(dialog.getByText("Culture")).toHaveCount(0);

    // The real provider-reported attribution renders as safe text, never fabricated from a requested
    // default the fixture never claimed.
    await expect(dialog.getByText("fixture-copilot-model · fixture-high")).toBeVisible();

    // The AI interpretation stays visibly separate from the dictionary evidence above it.
    await expect(
      dialog.getByRole("note", { name: "AI-generated explanation, may be imperfect" })
    ).toBeVisible();
  });

  // A non-first BRANCH within the SAME (first) family — proves a hardcoded "always the first branch"
  // bug would fail here even though the family marker stays on the first family.
  test("marks the tilt branch (second branch of the first family) for a passage about banking a plane", async ({
    page,
    setup
  }) => {
    await seedMarkdownWork(page, setup, "Explain Bank Tilt", "en", [BANK_TILT]);

    await openLookupFor(page, "pilot had to bank", "bank");
    const dialog = lookupDialog(page);
    await explainButton(page).click();

    const tiltBranch = dialog.locator(".explainBranch", { hasText: "to tilt or lean sideways" });
    await expect(tiltBranch.getByText("Used here")).toBeVisible();
    await expect(
      dialog
        .locator(".explainBranch", { hasText: "a riverbank or lakeshore" })
        .getByText("Used here")
    ).toHaveCount(0);
  });

  // A non-first FAMILY — proves a hardcoded "always the first family" bug would fail here.
  test("marks the financial family/institution branch for a passage about opening an account", async ({
    page,
    setup
  }) => {
    await seedMarkdownWork(page, setup, "Explain Bank Account", "en", [BANK_ACCOUNT]);

    await openLookupFor(page, "opened a new savings account", "bank");
    const dialog = lookupDialog(page);
    await explainButton(page).click();

    const institutionBranch = dialog.locator(".explainBranch", {
      hasText: "a financial institution"
    });
    await expect(institutionBranch.getByText("Used here")).toBeVisible();
    await expect(
      dialog
        .locator(".explainBranch", { hasText: "a riverbank or lakeshore" })
        .getByText("Used here")
    ).toHaveCount(0);
  });

  // The SECOND branch of the SECOND family — the deepest, most-likely-to-be-hardcoded-wrong case.
  test("marks the financial family's rely-on branch for a passage about banking on someone", async ({
    page,
    setup
  }) => {
    await seedMarkdownWork(page, setup, "Explain Bank Rely", "en", [BANK_RELY]);

    await openLookupFor(page, "you can always bank on", "bank");
    const dialog = lookupDialog(page);
    await explainButton(page).click();

    const relyBranch = dialog.locator(".explainBranch", { hasText: "to rely on" });
    await expect(relyBranch.getByText("Used here")).toBeVisible();
    await expect(
      dialog
        .locator(".explainBranch", { hasText: "a financial institution" })
        .getByText("Used here")
    ).toHaveCount(0);
  });

  test("explains a Chinese verb with one organizing core and several branches, marking the phone-call sense", async ({
    page,
    setup
  }) => {
    await seedMarkdownWork(page, setup, "语义查词样例", "zh-CN", [ZH_PARAGRAPH]);

    await openLookupFor(page, "打电话", "打");
    const dialog = lookupDialog(page);
    // The Chinese dictionary tabs (萌典 leads, #272) load fully, independent of the AI action below.
    await expect(dialog.getByRole("tab", { name: "萌典" })).toBeVisible();

    await explainButton(page).click();
    await expect(dialog.getByText("用手或借助动作对某物施加力量")).toBeVisible();
    await expect(dialog.getByText("打：击打")).toBeVisible();
    await expect(dialog.getByText("打：打球")).toBeVisible();
    const callBranch = dialog.locator(".explainBranch", { hasText: "打：打电话" });
    await expect(callBranch.getByText("Used here")).toBeVisible();
    await expect(
      dialog.locator(".explainBranch", { hasText: "打：击打" }).getByText("Used here")
    ).toHaveCount(0);
    // #925 correction: every branch connection is Chinese when the response language is zh — never
    // left over in English from a differently-languaged fixture.
    await expect(dialog.getByText("用手或工具击打某物的字面动作")).toBeVisible();
    await expect(dialog.getByText("从击打引申为发起电话通话")).toBeVisible();

    // Scoped to the Explain result's own supporting-details list (`.explainDetails`), never the bare
    // dialog: a dictionary tab (e.g. 萌典) can independently render its own "dǎ ㄉㄚˇ" pronunciation in
    // the SAME dialog depending on which tab happens to resolve first, which would otherwise make a
    // bare `dialog.getByText("dǎ")` ambiguous (a strict-mode violation) — an artifact of which
    // dictionary tab wins the race, not of the Explain result itself.
    const explainDetails = dialog.locator(".explainDetails");
    await expect(explainDetails.getByText("dǎ", { exact: true })).toBeVisible();
    await expect(dialog.getByText("非常口语化")).toBeVisible();
    // A genuinely monosemous-core answer never fabricates etymology/usage/culture the model omitted.
    await expect(explainDetails.getByText("Origin")).toHaveCount(0);
    await expect(explainDetails.getByText("Usage")).toHaveCount(0);
    await expect(explainDetails.getByText("Culture")).toHaveCount(0);
  });

  // Route-stubbed: the shared single-process E2E stack reads AGENT_COPILOT_EXPLAIN_ENABLED once at
  // server boot for the whole run, so a genuinely disabled capability cannot be produced by a real
  // request within this run. The remedy text is the server's own real copy (`explainConfig.ts`'s
  // `disabledRemedy`), so the rendered message stays truthful to what a real disabled deploy actually
  // tells the learner.
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

    await seedMarkdownWork(page, setup, "Explain Disabled", "en", [BANK_RIVER]);
    const requestUrls: string[] = [];
    page.on("request", (request) => requestUrls.push(request.url()));

    await openLookupFor(page, "muddy bank", "bank");
    const dialog = lookupDialog(page);

    // Dictionaries still fully work with the capability off.
    await expect(dialog.getByRole("tab", { name: "WordNet" })).toBeVisible();
    await expect(dialog.getByText(`Explain meanings is turned off. ${remedy}`)).toBeVisible();
    await expect(explainButton(page)).toHaveCount(0);
    expect(requestUrls.some((url) => url.endsWith("/api/explain"))).toBe(false);
  });

  // A genuine capability-probe HTTP failure followed by a successful retry is proven at the component
  // level instead (`ExplainSection.test.tsx`: "retries a failed capability probe by re-fetching
  // capability only..."), never here: the shared harness's `e2e/fixtures.ts` deliberately fails any
  // test whose page produces an app-origin 4xx/5xx (a blanket, suite-wide runtime-defect policy this
  // one feature must not carve an exception into), and this exact scenario needs a genuine 500 to
  // exercise the failure half. The component test already asserts the same exact-call-count/no-POST
  // evidence deterministically, with no such conflict.

  // Route-stubbed: the capability was toggled off between the mount-time check and the click — a race
  // the shared real stack cannot reliably force. Proves the #925 correction: the POST's own "disabled"
  // response carries no remedy, so the Reader must re-fetch the REAL current capability (never a
  // second POST) and show ITS remedy, not a generic failure.
  test("recovers a disabled-mid-flight race with the real remedy, without a second POST (route-stubbed)", async ({
    page,
    setup
  }) => {
    const remedy = "Set AGENT_COPILOT_EXPLAIN_ENABLED=1 to opt in.";
    // A phase gate, not a call-count threshold (StrictMode's mount-effect double-invoke would make an
    // exact "call 1 vs call 2" count fragile/wrong): every capability probe stays enabled until the
    // POST itself flips it, mirroring the real mid-flight race regardless of how many probes StrictMode
    // makes during mount.
    let capabilityEnabled = true;
    let capabilityCalls = 0;
    await page.route("**/api/explain/capability", async (route) => {
      capabilityCalls += 1;
      const body = capabilityEnabled
        ? { enabled: true }
        : { enabled: false, reason: "feature_disabled", remedy };
      await route.fulfill({
        body: JSON.stringify(body),
        contentType: "application/json",
        status: 200
      });
    });
    let explainPostCalls = 0;
    let callsBeforeRecovery = 0;
    await page.route("**/api/explain", async (route) => {
      if (route.request().method() === "POST") {
        explainPostCalls += 1;
        callsBeforeRecovery = capabilityCalls;
        // The capability toggled off between the mount-time check and this very POST landing.
        capabilityEnabled = false;
        await route.fulfill({
          body: JSON.stringify({ status: "disabled" }),
          contentType: "application/json",
          status: 200
        });
        return;
      }
      await route.continue();
    });

    await seedMarkdownWork(page, setup, "Explain Disabled Race", "en", [BANK_RIVER]);
    await openLookupFor(page, "muddy bank", "bank");
    const dialog = lookupDialog(page);

    await explainButton(page).click();

    await expect(dialog.getByText(`Explain meanings is turned off. ${remedy}`)).toBeVisible();
    expect(explainPostCalls).toBe(1);
    // The recovery re-fetches capability EXACTLY once more — never a burst, never a second POST.
    expect(capabilityCalls).toBe(callsBeforeRecovery + 1);
  });

  test("recovers from an honest transport failure via explicit retry, without losing dictionary results", async ({
    page,
    setup
  }) => {
    await seedMarkdownWork(page, setup, "Explain Break Transport", "en", [BREAK_TRANSPORT]);
    await openLookupFor(page, "breaktransport fault", "breaktransport");
    const dialog = lookupDialog(page);

    await explainButton(page).click();
    await expect(
      dialog.getByText("Could not reach Copilot. Check your connection and try again.")
    ).toBeVisible();
    // The failed optional explanation never destroys the dictionary results rendered above it.
    await expect(dialog.getByRole("tab", { name: "WordNet" })).toBeVisible();

    await retryButton(page).click();
    await expect(
      dialog.getByText("a minimal recovered explanation with no optional fields")
    ).toBeVisible();
    await expect(dialog.locator(".explainBranchLabel", { hasText: "recovered" })).toBeVisible();
    // The recovered answer carries no provider attribution the runtime never reported — never invented.
    await expect(dialog.locator(".explainProvider")).toHaveCount(0);
  });

  test("shows an honest invalid-response failure for a malformed model answer, retaining a retry button", async ({
    page,
    setup
  }) => {
    await seedMarkdownWork(page, setup, "Explain Bad Json", "en", [BAD_JSON]);
    await openLookupFor(page, "badjson text", "badjson");
    const dialog = lookupDialog(page);

    await explainButton(page).click();
    await expect(
      dialog.getByText("Copilot returned an answer that could not be understood.")
    ).toBeVisible();
    await expect(retryButton(page)).toBeVisible();
  });

  // Proves the #925 correction's client half end to end: the entry point is no longer silently
  // removed for a genuinely over-300-code-unit selection (`explainTarget.ts` no longer duplicates the
  // server's cap). This deliberately never invokes it — a real backend 400 for this exact case is
  // already the shared harness's blanket "no unexpected app-origin 4xx" runtime-defect policy
  // (`e2e/fixtures.ts`), which this suite must not weaken or route around — so the resulting
  // `invalid_request` message/no-retry mapping itself is proven at the component level instead
  // (`ExplainSection.test.tsx`, a mocked `ExplainRequestError`).
  test("keeps the explicit action visible and enabled for a genuinely over-300-character selection", async ({
    page,
    setup
  }) => {
    const longRun = "z".repeat(310);
    const paragraph = `Before the long run there is context. ${longRun} And after the long run there is more context.`;
    await seedMarkdownWork(page, setup, "Explain Over Limit", "en", [paragraph]);

    await openLookupFor(page, "Before the long run", longRun);

    const button = explainButton(page);
    await expect(button).toBeVisible();
    await expect(button).toBeEnabled();
  });

  test("shows an honest timeout after the deadline, with no premature false failure", async ({
    page,
    setup
  }) => {
    await seedMarkdownWork(page, setup, "Explain Timeout", "en", [TIMEOUT_TEST]);
    await openLookupFor(page, "timeouttest and never", "timeouttest");
    const dialog = lookupDialog(page);

    await explainButton(page).click();
    await expect(dialog.getByText("Asking Copilot for the semantic map…")).toBeVisible();
    // The E2E harness shortens the owned deadline to 3s (`AGENT_COPILOT_EXPLAIN_TURN_TIMEOUT_MS`) so
    // this proves the truthful "timeout" outcome without waiting out the real 150s production bound —
    // and, since Playwright's own `expect` timeout (15s) comfortably exceeds it, never a false early
    // failure from a client-side timeout shorter than the SDK's own generation bound.
    await expect(
      dialog.getByText("The explanation is taking too long. Try again in a moment.")
    ).toBeVisible();
    await expect(retryButton(page)).toBeVisible();
  });

  test("isolates a superseded pending request from a new selection's answer", async ({
    page,
    setup
  }) => {
    await seedMarkdownWork(page, setup, "Explain Stale Isolation", "en", [
      TIMEOUT_TEST,
      BANK_RIVER
    ]);

    await openLookupFor(page, "timeouttest and never", "timeouttest");
    await explainButton(page).click();
    await expect(page.getByText("Asking Copilot for the semantic map…")).toBeVisible();

    // Close the panel and select a different passage WHILE the first request is still in flight (the
    // fixture's "timeouttest" headword never resolves on its own): the parent's `key={lookup.requestId}`
    // fully remounts the panel (and the lazy `ExplainSection` inside it) on every new selection, so the
    // superseded request's own effect cleanup aborts it rather than letting it paint later.
    await page.keyboard.press("Escape");
    await expect(lookupDialog(page)).toBeHidden();

    await openLookupFor(page, "muddy bank", "bank");
    const dialog = lookupDialog(page);
    await explainButton(page).click();
    await expect(dialog.getByText("a sloping earthen edge, as beside a river")).toBeVisible();
    // The superseded "timeouttest" request never paints its (eventual) timeout message under the new term.
    await expect(dialog.getByText("The explanation is taking too long")).toHaveCount(0);
  });

  // #925 correction: invoking Explain, then switching to a DIFFERENT dictionary tab while the answer
  // may still be in flight, must never have the eventual background result steal the view back —
  // dictionary tab selection and the Explain slot are independent siblings, never a shared/exclusive
  // view, so the learner's own tab choice survives the result's later arrival.
  test("switching dictionary tabs after invoking Explain does not lose that tab selection when the result later arrives", async ({
    page,
    setup
  }) => {
    await seedMarkdownWork(page, setup, "Explain No View Steal", "en", [BANK_RIVER]);
    await openLookupFor(page, "muddy bank", "bank");
    const dialog = lookupDialog(page);

    await explainButton(page).click();
    await dialog.getByRole("tab", { name: "Wiktionary" }).click();
    await expect(dialog.getByRole("tab", { name: "Wiktionary", selected: true })).toBeVisible();

    await expect(dialog.getByText("a sloping earthen edge, as beside a river")).toBeVisible();
    // The background result's arrival must never revert the learner's own tab choice.
    await expect(dialog.getByRole("tab", { name: "Wiktionary", selected: true })).toBeVisible();
  });

  // #925 correction: a long WordNet entry (12 real senses) previously buried the action and its result
  // below the entire dictionary entry. `boundingBox()` measures CURRENT position with no implicit
  // scroll (unlike `.click()`/`.toBeVisible()`), so this proves the action is reachable in the initial
  // popover viewport BEFORE any scroll or click, and that the result stays a focused, core-first view
  // (not appended after dozens of senses) immediately after invoking it.
  test("the explicit action and its result are reachable in the initial viewport of a long entry, before any scroll (desktop)", async ({
    page,
    setup
  }) => {
    await seedMarkdownWork(page, setup, "Explain Long Entry Desktop", "en", [LONG_ENTRY_PASSAGE]);
    await openLookupFor(page, "muddy bank", "bank");
    const dialog = lookupDialog(page);

    // Confirm this really is a long entry (many WordNet senses) before proving discoverability against it.
    await expect(dialog.getByRole("tab", { name: "WordNet" })).toBeVisible();
    const senseCount = await dialog.locator(".lookupSense").count();
    expect(senseCount).toBeGreaterThan(5);

    await assertReachableWithoutScrolling(dialog, explainButton(page));

    await explainButton(page).click();
    await assertReachableWithoutScrolling(
      dialog,
      dialog.getByText("a sloping earthen edge, as beside a river")
    );
  });

  test("the explicit action and its result are reachable in the initial viewport of a long entry, before any scroll (mobile)", async ({
    page,
    setup
  }) => {
    await page.setViewportSize(MOBILE);
    await seedMarkdownWork(page, setup, "Explain Long Entry Mobile", "en", [LONG_ENTRY_PASSAGE]);
    await openLookupFor(page, "muddy bank", "bank");
    const dialog = lookupDialog(page);

    await expect(dialog.getByRole("tab", { name: "WordNet" })).toBeVisible();
    const senseCount = await dialog.locator(".lookupSense").count();
    expect(senseCount).toBeGreaterThan(5);

    await assertReachableWithoutScrolling(dialog, explainButton(page));

    await explainButton(page).click();
    await assertReachableWithoutScrolling(
      dialog,
      dialog.getByText("a sloping earthen edge, as beside a river")
    );
  });

  test("Escape closes the lookup popover", async ({ page, setup }) => {
    await seedMarkdownWork(page, setup, "Explain Escape", "en", [BANK_RIVER]);
    await openLookupFor(page, "muddy bank", "bank");
    await expect(explainButton(page)).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(lookupDialog(page)).toBeHidden();
  });

  test("mobile: the bottom Sheet offers the same explicit action and result", async ({
    page,
    setup
  }) => {
    await page.setViewportSize(MOBILE);
    await seedMarkdownWork(page, setup, "Explain Mobile", "en", [BANK_RIVER]);
    await openLookupFor(page, "muddy bank", "bank");

    const dialog = lookupDialog(page);
    await expect(dialog.getByRole("tab", { name: "WordNet" })).toBeVisible();
    const button = explainButton(page);
    await expect(button).toBeVisible();
    const box = await button.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);

    await button.click();
    await expect(dialog.getByText("a sloping earthen edge, as beside a river")).toBeVisible();
    const riverBranch = dialog.locator(".explainBranch", { hasText: "a riverbank or lakeshore" });
    await expect(riverBranch.getByText("Used here")).toBeVisible();
  });
});
