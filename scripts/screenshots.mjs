// Manual screenshot harness (run via `pnpm screenshots`). It boots the REAL stack against an
// ephemeral in-memory PGlite database, ingests the fixture EPUBs through the live ingestion
// pipeline, serves the production web build via `vite preview` (with /api proxied to the
// server), and drives headless Chromium with the `playwright` library to capture a labeled PNG
// at each stage of the walking-skeleton loop.
//
// This is a screenshot GENERATOR, not a test suite: it asserts only that each stage rendered
// (a required element appeared). It is deliberately NOT wired into `pnpm validate` or CI so it
// cannot become a flaky merge gate. Requires a one-time browser install:
//   pnpm exec playwright install chromium
//
// Exit 0 = every stage captured. Non-zero = a stage failed (server/preview/ingest/selector);
// the server, preview server, and browser are always torn down.

/* global document, window, NodeFilter, MouseEvent */

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webDir = path.join(root, "src", "apps", "web");
const serverEntry = path.join(root, "src", "apps", "server", "dist", "index.js");
const viteBin = path.join(webDir, "node_modules", "vite", "bin", "vite.js");
const outDir = path.join(root, "artifacts", "screenshots");

const skipBuild = process.argv.includes("--no-build");

// The two public-domain fixtures, in capture order. `lang` is only a filename label.
const fixtures = [
  { file: "aesop-fables.epub", lang: "en" },
  { file: "three-character-classic.epub", lang: "zh" }
];

const viewports = [
  { height: 800, name: "desktop", width: 1280 },
  { height: 844, name: "mobile", width: 390 }
];

const themes = ["day", "night"];

const cleanups = [];
async function runCleanups() {
  for (const fn of cleanups.reverse()) {
    try {
      await fn();
    } catch (error) {
      console.error(`teardown error: ${error.message}`);
    }
  }
}

function fail(message) {
  throw new Error(message);
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url, { label, timeoutMs = 30000 }) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      await response.text().catch(() => {});
      lastStatus = response.status;
      if (response.status >= 200 && response.status < 400) {
        return;
      }
    } catch {
      lastStatus = 0;
    }
    await sleep(300);
  }
  fail(
    `${label} did not become ready at ${url} within ${timeoutMs}ms (last status ${lastStatus}).`
  );
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`))
    );
  });
}

async function buildWorkspace() {
  if (skipBuild) {
    console.log("Skipping build (--no-build).");
    return;
  }
  console.log("Building workspace (pnpm build)…");
  // Build with the PWA/service worker disabled (#438): the screenshot harness serves the built dist,
  // and an active SW would precache and later serve stale assets across runs.
  await run("pnpm", ["build"], {
    cwd: root,
    env: { ...process.env, WHETSTONE_DISABLE_PWA: "true" },
    shell: process.platform === "win32"
  });
}

async function startServer(port, sourceFilesDir) {
  const env = { ...process.env, HOST: "127.0.0.1", LOG_LEVEL: "warn", PORT: String(port) };
  // Ephemeral in-memory PGlite: DATABASE_DIR must be unset. Provenance files go to a temp dir.
  delete env.DATABASE_DIR;
  env.SOURCE_FILES_DIR = sourceFilesDir;

  const logs = [];
  const child = spawn(process.execPath, [serverEntry], { cwd: root, env });
  child.stdout.on("data", (chunk) => logs.push(chunk.toString()));
  child.stderr.on("data", (chunk) => logs.push(chunk.toString()));
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });
  cleanups.push(
    () =>
      new Promise((resolve) => {
        if (exited) {
          return resolve();
        }
        child.once("exit", () => resolve());
        child.kill();
      })
  );

  try {
    await waitForHttp(`http://127.0.0.1:${port}/health`, { label: "API server" });
  } catch (error) {
    console.error(`\n--- server output ---\n${logs.join("")}\n---------------------`);
    throw error;
  }
}

async function ingestFixture(serverPort, file) {
  const bytes = await readFile(path.join(root, "fixtures", "epub", file));
  const response = await fetch(`http://127.0.0.1:${serverPort}/api/works/epub`, {
    body: bytes,
    headers: { "content-type": "application/epub+zip" },
    method: "POST"
  });
  if (response.status !== 201 && response.status !== 200) {
    const detail = await response.text().catch(() => "");
    fail(`Ingesting ${file} returned HTTP ${response.status}: ${detail}`);
  }
  const result = await response.json();
  const work = result.work;
  if (work?.entryId === undefined) {
    fail(`Ingesting ${file} returned no work entryId.`);
  }
  return { entryId: work.entryId, title: work.title };
}

async function startPreview(previewPort, serverPort) {
  const env = { ...process.env, WHETSTONE_API_PROXY: `http://127.0.0.1:${serverPort}` };
  const child = spawn(
    process.execPath,
    [viteBin, "preview", "--host", "127.0.0.1", "--port", String(previewPort), "--strictPort"],
    { cwd: webDir, env, stdio: "ignore" }
  );
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });
  cleanups.push(
    () =>
      new Promise((resolve) => {
        if (exited) {
          return resolve();
        }
        child.once("exit", () => resolve());
        child.kill();
      })
  );

  const base = `http://127.0.0.1:${previewPort}/`;
  await waitForHttp(base, { label: "web preview" });
  return base;
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(outDir, `${name}.png`) });
  console.log(`captured ${name}.png`);
}

async function applyTheme(context, base, theme) {
  // Set the server-owned theme preference (the source of truth, #234) directly rather than driving the
  // in-app toggle. On a mobile reader the toggle is hidden behind a chrome reveal whose tap
  // intermittently failed to flip the theme, aborting the whole run; and because the preference is
  // shared across the ephemeral server, a prior Night capture would otherwise leave a later "day"
  // capture rendering Night. Setting it server-side makes every page load the intended theme
  // deterministically and keeps each capture's day/night label honest.
  const endpoint = `${base}api/preferences`;
  const read = await context.request.get(endpoint);
  const stored = read.ok() ? ((await read.json()).preferences ?? {}) : {};
  const response = await context.request.put(endpoint, {
    data: {
      readingSize: stored.readingSize ?? "md",
      theme,
      timeZone: stored.timeZone ?? "UTC"
    }
  });
  if (!response.ok()) {
    fail(`Setting the ${theme} theme preference returned HTTP ${response.status()}.`);
  }
}

// Wait for the app to reconcile the (already persisted) server theme onto the root element after
// `fetchPreferences` resolves on mount — no interaction, so no chrome-reveal race.
async function waitForTheme(page, theme) {
  const wantDark = theme === "night";
  try {
    await page.waitForFunction(
      (dark) => document.documentElement.classList.contains("dark") === dark,
      wantDark,
      { timeout: 15000 }
    );
  } catch {
    fail(`The ${theme} theme did not apply within 15000ms.`);
  }
}

// Let the staggered card / entrance springs settle so a shot is not caught mid-fade.
async function settle(page) {
  await page.waitForTimeout(600);
}

// Select the first real word inside the longest block and raise mouseup, so the reader's capture
// handler opens the selection toolbar. Runs in the page; shared by the annotation walkthrough and the
// note-editor width captures. Relies on the file-level `document`/`window`/`NodeFilter`/`MouseEvent`
// globals declared for the page context.
function selectFirstWord() {
  const blocks = Array.from(document.querySelectorAll("[data-block-id]"));
  if (blocks.length === 0) {
    throw new Error("no rendered blocks to select");
  }
  const block = blocks.reduce((best, candidate) =>
    (candidate.textContent ?? "").length > (best.textContent ?? "").length ? candidate : best
  );
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node && (node.textContent ?? "").trim().length < 3) {
    node = walker.nextNode();
  }
  if (node === null) {
    throw new Error("no text node to select");
  }
  const text = node.textContent ?? "";
  const match = text.match(/\S+/);
  const start = text.indexOf(match[0]);
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, start + match[0].length);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  block.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
}

// Wait for the locator that marks a route/stage as rendered, naming the route + stage on timeout so a
// failed capture points straight at the remedy (which route/stage to inspect).
async function waitForStage(locator, { route, stage, timeoutMs = 15000 }) {
  try {
    await locator.waitFor({ timeout: timeoutMs });
  } catch (error) {
    fail(`${stage} did not render at ${route} within ${timeoutMs}ms (${error.message}).`);
  }
}

async function captureHomeAndReaders(browser, base, works) {
  const libraryUrl = `${base}#/library`;
  for (const viewport of viewports) {
    for (const theme of themes) {
      const context = await browser.newContext({
        colorScheme: "light",
        viewport: { height: viewport.height, width: viewport.width }
      });
      try {
        // Persist the theme server-side once for this context (the source of truth); every page below
        // then loads it deterministically.
        await applyTheme(context, base, theme);

        // A fresh page per capture avoids stale content from a prior work leaking into the
        // shot; the chosen theme is read from the shared server preference on each load.

        // Today is the app's landing page at the root route (#319), so root captures Today.
        const todayPage = await context.newPage();
        await todayPage.goto(base, { waitUntil: "load" });
        await waitForTheme(todayPage, theme);
        await waitForStage(todayPage.getByRole("heading", { level: 1, name: "Today" }), {
          route: "/",
          stage: `Today (${theme}/${viewport.name})`
        });
        await settle(todayPage);
        await shot(todayPage, `today.${theme}.${viewport.name}`);
        await todayPage.close();

        // The Library moved off the root route to #/library when Today became the landing (#319).
        const libraryPage = await context.newPage();
        await libraryPage.goto(libraryUrl, { waitUntil: "load" });
        await waitForTheme(libraryPage, theme);
        for (const work of works) {
          await waitForStage(libraryPage.getByRole("heading", { name: work.title }).first(), {
            route: "#/library",
            stage: `Library (${theme}/${viewport.name}) — "${work.title}"`
          });
        }
        await settle(libraryPage);
        await shot(libraryPage, `library.${theme}.${viewport.name}`);
        await libraryPage.close();

        for (const work of works) {
          const readerPage = await context.newPage();
          await readerPage.goto(`${base}#/reader?work=${encodeURIComponent(work.entryId)}`, {
            waitUntil: "load"
          });
          await waitForTheme(readerPage, theme);
          await waitForStage(
            readerPage.locator('article[aria-label="Reading"] [data-block-id]').first(),
            {
              route: `#/reader?work=${work.entryId}`,
              stage: `Reader (${work.lang}/${theme}/${viewport.name})`
            }
          );
          await settle(readerPage);
          await shot(readerPage, `reader.${work.lang}.${theme}.${viewport.name}`);
          await readerPage.close();
        }
      } finally {
        await context.close();
      }
    }
  }
}

async function captureAnnotation(browser, base, work) {
  const context = await browser.newContext({
    colorScheme: "light",
    viewport: { height: 800, width: 1280 }
  });
  try {
    await applyTheme(context, base, "day");
    const page = await context.newPage();
    await page.goto(`${base}#/reader?work=${encodeURIComponent(work.entryId)}`, {
      waitUntil: "load"
    });
    await waitForStage(page.locator('article[aria-label="Reading"] [data-block-id]').first(), {
      route: `#/reader?work=${work.entryId}`,
      stage: "Annotation (day/desktop) reader"
    });

    // Select a word inside the longest (paragraph) block and raise mouseup so the reader's
    // capture handler opens the selection toolbar.
    await page.evaluate(selectFirstWord);

    await page.getByRole("toolbar", { name: "Annotate selection" }).waitFor({ timeout: 10000 });
    await settle(page);
    await shot(page, "selection.day.desktop");

    await page.getByRole("button", { name: "Add note" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ timeout: 10000 });
    await page.getByText("New note").first().waitFor({ timeout: 10000 });
    await settle(page);
    await shot(page, "note-editor.day.desktop");

    await dialog
      .getByRole("textbox", { name: "Note body" })
      .fill("A note captured by the screenshot harness.");
    await page.getByRole("button", { name: "Save note" }).click();

    // A saved note has no success toast (#300) — the persisted highlight is the only confirmation.
    // Wait for the block to be marked and its highlight decoration (`.noteMark`, #313) to render, then
    // capture that state rather than a toast that no longer appears.
    await page.locator('[data-has-notes="true"]').first().waitFor({ timeout: 10000 });
    await waitForStage(page.locator(".noteMark").first(), {
      route: "#/reader (annotation)",
      stage: "Saved-note highlight"
    });
    await settle(page);
    await shot(page, "note-saved.day.desktop");
  } finally {
    await context.close();
  }
}

// The note editor's desktop working width (#646) and its mobile bottom sheet, captured at the
// viewports the acceptance criteria call out (768/1280/1440 desktop + mobile) so the wide side panel
// and the full-width mobile sheet are both eyeball-verifiable in the artifacts.
const noteEditorViewports = [
  { height: 900, name: "desktop-768", width: 768 },
  { height: 800, name: "desktop-1280", width: 1280 },
  { height: 900, name: "desktop-1440", width: 1440 },
  { height: 844, name: "mobile", width: 390 }
];

async function captureNoteEditorWidths(browser, base, work) {
  for (const viewport of noteEditorViewports) {
    const context = await browser.newContext({
      colorScheme: "light",
      hasTouch: viewport.name === "mobile",
      isMobile: viewport.name === "mobile",
      viewport: { height: viewport.height, width: viewport.width }
    });
    try {
      await applyTheme(context, base, "day");
      const page = await context.newPage();
      await page.goto(`${base}#/reader?work=${encodeURIComponent(work.entryId)}`, {
        waitUntil: "load"
      });
      await waitForStage(page.locator('article[aria-label="Reading"] [data-block-id]').first(), {
        route: `#/reader?work=${work.entryId}`,
        stage: `Note editor width (${viewport.name}) reader`
      });

      await page.evaluate(selectFirstWord);
      await page.getByRole("toolbar", { name: "Annotate selection" }).waitFor({ timeout: 10000 });
      await page.getByRole("button", { name: "Add note" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor({ timeout: 10000 });
      await page.getByText("New note").first().waitFor({ timeout: 10000 });
      await settle(page);
      await shot(page, `note-editor.day.${viewport.name}`);
    } finally {
      await context.close();
    }
  }
}

// The saved-note Note/Cards workspace (#700). The issue requires the visual gate to cover the new
// workspace beyond new-note capture: a saved *anchored* note's Note mode, its Cards list, a card's
// detail, that card's review history, and the delete confirmation — each at 1280px and 390px in Day
// and Night. This runs AFTER `captureAnnotation`, which leaves exactly one saved anchored note on the
// English work; we reopen that note directly from its inline underline (#644) and walk the workspace,
// enrolling a card on the first pass (later passes reuse the persisted card) and always cancelling the
// delete with "Keep note" so the note survives every subsequent pass.
const workspaceViewports = [
  { height: 800, name: "desktop", width: 1280 },
  { height: 844, name: "mobile", width: 390 }
];

async function captureNoteWorkspace(browser, base, work) {
  const noteMark = 'article[aria-label="Reading"] span.noteMark';
  for (const viewport of workspaceViewports) {
    for (const theme of themes) {
      const context = await browser.newContext({
        colorScheme: "light",
        hasTouch: viewport.name === "mobile",
        isMobile: viewport.name === "mobile",
        viewport: { height: viewport.height, width: viewport.width }
      });
      try {
        await applyTheme(context, base, theme);
        const page = await context.newPage();
        await page.goto(`${base}#/reader?work=${encodeURIComponent(work.entryId)}`, {
          waitUntil: "load"
        });
        await waitForTheme(page, theme);
        const label = `${theme}/${viewport.name}`;
        await waitForStage(page.locator(noteMark).first(), {
          route: "#/reader (workspace)",
          stage: `Saved-note underline (${label})`
        });

        // Reopen the saved anchored note directly from its inline underline; a single non-overlapping
        // note opens its editor with no chooser (#644).
        await page.locator(noteMark).first().click();
        const editor = page.getByRole("dialog", { name: "Edit note" });
        await waitForStage(editor, { route: "workspace", stage: `Edit note dialog (${label})` });

        // 1) Saved anchored Note mode (the default tab).
        await settle(page);
        await shot(page, `note-workspace-note.${theme}.${viewport.name}`);

        // 2) Cards list — enroll a card on the first pass; later passes reuse the persisted card.
        await editor.getByRole("tab", { name: "Cards" }).click();
        const cardsPanel = editor.getByRole("tabpanel", { name: "Cards" });
        await cardsPanel.locator("p.noteCardsEmpty, ul.noteCardsRows").first().waitFor({
          timeout: 15000
        });
        if (await cardsPanel.locator("p.noteCardsEmpty").isVisible()) {
          // An anchored note confirms the exact snapshot as a read-only Question — two clicks of the
          // one "Add to review" affordance (open the confirm, then confirm) enroll a single due card.
          await cardsPanel.getByRole("button", { name: "Add to review" }).click();
          await cardsPanel.getByRole("button", { name: "Add to review" }).click();
        }
        await cardsPanel.locator("ul.noteCardsRows button").first().waitFor({ timeout: 15000 });
        await settle(page);
        await shot(page, `note-workspace-cards.${theme}.${viewport.name}`);

        // 3) Card detail.
        await cardsPanel.locator("ul.noteCardsRows button").first().click();
        await waitForStage(cardsPanel.getByRole("button", { name: "Back to cards" }), {
          route: "workspace/cards",
          stage: `Card detail (${label})`
        });
        await settle(page);
        await shot(page, `note-workspace-card-detail.${theme}.${viewport.name}`);

        // 4) Card review history.
        await cardsPanel.getByRole("button", { name: "Review history" }).click();
        await waitForStage(cardsPanel.getByRole("heading", { name: "Review history" }), {
          route: "workspace/cards/history",
          stage: `Card history (${label})`
        });
        await settle(page);
        await shot(page, `note-workspace-card-history.${theme}.${viewport.name}`);
        await cardsPanel.getByRole("button", { name: "Back to card" }).click();

        // 5) Delete confirmation — captured, then cancelled with "Keep note" so the note survives the
        // remaining passes (the header overflow persists across the Cards sub-screens).
        await editor.getByRole("button", { name: "Note actions" }).click();
        await page.getByRole("menuitem", { name: "Delete note" }).click();
        await waitForStage(editor.getByRole("region", { name: "Delete note" }), {
          route: "workspace",
          stage: `Delete confirmation (${label})`
        });
        await settle(page);
        await shot(page, `note-workspace-delete.${theme}.${viewport.name}`);
        await editor.getByRole("button", { name: "Keep note" }).click();

        await editor.getByRole("button", { name: "Close" }).click();
      } finally {
        await context.close();
      }
    }
  }
}

async function main() {
  await buildWorkspace();
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const sourceFilesDir = await mkdtemp(path.join(tmpdir(), "whetstone-shots-"));
  cleanups.push(() => rm(sourceFilesDir, { recursive: true, force: true }));

  const serverPort = await getFreePort();
  await startServer(serverPort, sourceFilesDir);

  const works = [];
  for (const fixture of fixtures) {
    const work = await ingestFixture(serverPort, fixture.file);
    works.push({ ...work, lang: fixture.lang });
    console.log(`ingested ${fixture.file} -> ${work.title} (${work.entryId})`);
  }

  const previewPort = await getFreePort();
  const base = await startPreview(previewPort, serverPort);

  const browser = await chromium.launch();
  cleanups.push(() => browser.close());

  await captureHomeAndReaders(browser, base, works);
  const englishWork = works.find((work) => work.lang === "en");
  // Capture the note-editor widths first: they only open the editor (never save), so they leave no
  // annotation behind. The annotation walkthrough then saves onto the same first word cleanly — running
  // it first would annotate that word and disable "Add note" for the width captures' overlapping
  // selection (#163).
  await captureNoteEditorWidths(browser, base, englishWork);
  await captureAnnotation(browser, base, englishWork);
  // The annotation walkthrough leaves one saved anchored note; the workspace captures reopen it and
  // walk the new Note/Cards states (#700).
  await captureNoteWorkspace(browser, base, englishWork);

  console.log(`\nAll screenshots written to ${path.relative(root, outDir)}`);
}

let failed = false;
try {
  await main();
} catch (error) {
  failed = true;
  console.error(`\nScreenshots FAILED — ${error.message}`);
} finally {
  await runCleanups();
}
process.exit(failed ? 1 : 0);
