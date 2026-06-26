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
  fail(`${label} did not become ready at ${url} within ${timeoutMs}ms (last status ${lastStatus}).`);
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
  await run("pnpm", ["build"], { cwd: root, shell: process.platform === "win32" });
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

async function applyTheme(page, theme) {
  const wantDark = theme === "night";
  // Poll until the theme matches: read the CURRENT state each loop and click the correctly-labelled
  // toggle, so a freshly loaded page that is still applying its persisted theme can't race us into
  // clicking a button that just changed label. The reader's theme toggle now lives in the chrome,
  // which is hidden on narrow screens until a center tap — reveal it by tapping the reading area.
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const isDark = await page.evaluate(() =>
      document.documentElement.classList.contains("dark")
    );
    if (isDark === wantDark) {
      return;
    }
    const toggle = page.getByRole("button", { name: isDark ? "Switch to Day" : "Switch to Night" });
    if (await toggle.isVisible().catch(() => false)) {
      await toggle.click().catch(() => {});
    } else {
      await page
        .locator('article[aria-label="Reading"]')
        .click({ position: { x: 8, y: 8 } })
        .catch(() => {});
    }
    await page.waitForTimeout(150);
  }
  throw new Error(`Could not switch theme to ${theme}.`);
}

// Let the staggered card / entrance springs settle so a shot is not caught mid-fade.
async function settle(page) {
  await page.waitForTimeout(600);
}

async function captureLibraryAndReaders(browser, base, works) {
  for (const viewport of viewports) {
    for (const theme of themes) {
      const context = await browser.newContext({
        colorScheme: "light",
        viewport: { height: viewport.height, width: viewport.width }
      });
      try {
        // A fresh page per capture avoids stale content from a prior work leaking into the
        // shot; the chosen theme persists across pages via localStorage within the context.
        const libraryPage = await context.newPage();
        await libraryPage.goto(base, { waitUntil: "load" });
        await applyTheme(libraryPage, theme);
        for (const work of works) {
          await libraryPage
            .getByRole("heading", { name: work.title })
            .first()
            .waitFor({ timeout: 15000 });
        }
        await settle(libraryPage);
        await shot(libraryPage, `library.${theme}.${viewport.name}`);
        await libraryPage.close();

        for (const work of works) {
          const readerPage = await context.newPage();
          await readerPage.goto(`${base}#/reader?work=${encodeURIComponent(work.entryId)}`, {
            waitUntil: "load"
          });
          await applyTheme(readerPage, theme);
          await readerPage
            .locator('article[aria-label="Reading"] [data-block-id]')
            .first()
            .waitFor({ timeout: 15000 });
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
    const page = await context.newPage();
    await page.goto(`${base}#/reader?work=${encodeURIComponent(work.entryId)}`, {
      waitUntil: "load"
    });
    await page.locator('article[aria-label="Reading"] [data-block-id]').first().waitFor({
      timeout: 15000
    });

    // Select a word inside the longest (paragraph) block and raise mouseup so the reader's
    // capture handler opens the selection toolbar.
    await page.evaluate(() => {
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
    });

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
      .locator("textarea, input[type=text]")
      .first()
      .fill("A note captured by the screenshot harness.");
    await page.getByRole("button", { name: "Save note" }).click();

    await page.locator('[data-has-notes="true"]').first().waitFor({ timeout: 10000 });
    await page.getByRole("status").waitFor({ timeout: 10000 });
    await settle(page);
    await shot(page, "note-saved.day.desktop");
  } finally {
    await context.close();
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

  await captureLibraryAndReaders(browser, base, works);
  const englishWork = works.find((work) => work.lang === "en");
  await captureAnnotation(browser, base, englishWork);

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
