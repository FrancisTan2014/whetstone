// Boots the REAL stack for the E2E smoke suite, mirroring scripts/screenshots.mjs: a real
// Fastify server backed by an ephemeral in-memory PGlite (DATABASE_DIR unset), seeded with a
// fixture EPUB plus a small Markdown work, behind the Vite dev server (so the app runs in React
// development mode and emits hydration / DOM-nesting warnings the suite then fails on). The
// workspace must already be built (`pnpm build`) — globalSetup does not build, because
// `pnpm validate` / CI build first.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = join(root, "src", "apps", "server", "dist", "index.js");
const webDir = join(root, "src", "apps", "web");
const viteBin = join(webDir, "node_modules", "vite", "bin", "vite.js");
const epubFixture = join(root, "fixtures", "epub", "aesop-fables.epub");

// A small deterministic Markdown work giving the reader one of every block the annotation tests
// need: a paragraph, a blockquote, and a list (the EPUB fixtures are heading/paragraph only).
const markdownSource = [
  "# Smoke Chapter",
  "",
  "The quick brown fox jumps over the lazy dog beside the wide river today.",
  "",
  "> A blockquote about a clever fox and a hungry lion deep in the quiet forest.",
  "",
  "- First list item mentions a falcon gliding above the valley.",
  "- Second list item mentions a turtle walking the long sandy shore."
].join("\n");

export type WorkRef = Readonly<{ entryId: string; title: string }>;
export type SetupData = Readonly<{ baseURL: string; epub: WorkRef; markdown: WorkRef }>;
export type Stack = Readonly<{ setup: SetupData; teardown: () => Promise<void> }>;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url: string, label: string, timeoutMs = 60000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      await response.text().catch(() => undefined);
      lastStatus = response.status;
      if (response.status >= 200 && response.status < 400) {
        return;
      }
    } catch {
      lastStatus = 0;
    }
    await sleep(300);
  }
  throw new Error(`${label} did not become ready at ${url} within ${timeoutMs}ms (last ${lastStatus}).`);
}

function killChild(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
    child.kill();
  });
}

async function startServer(port: number, sourceFilesDir: string): Promise<ChildProcess> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOST: "127.0.0.1",
    LOG_LEVEL: "warn",
    PORT: String(port),
    SOURCE_FILES_DIR: sourceFilesDir
  };
  // Ephemeral in-memory PGlite: DATABASE_DIR must be unset so each run starts clean.
  delete env.DATABASE_DIR;

  const logs: string[] = [];
  const child = spawn(process.execPath, [serverEntry], { cwd: root, env });
  child.stdout?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
  try {
    await waitForHttp(`http://127.0.0.1:${port}/health`, "API server");
  } catch (error) {
    await killChild(child);
    throw new Error(`${(error as Error).message}\n--- server output ---\n${logs.join("")}`, {
      cause: error
    });
  }
  return child;
}

async function startWebServer(port: number, serverPort: number): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [viteBin, "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    {
      cwd: webDir,
      env: { ...process.env, WHETSTONE_API_PROXY: `http://127.0.0.1:${serverPort}` },
      stdio: "ignore"
    }
  );
  await waitForHttp(`http://127.0.0.1:${port}/`, "web dev server");
  return child;
}

function api(serverPort: number, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`http://127.0.0.1:${serverPort}${path}`, init);
}

async function seedEpub(serverPort: number): Promise<WorkRef> {
  const bytes = await readFile(epubFixture);
  const response = await api(serverPort, "/api/works/epub", {
    body: bytes,
    headers: { "content-type": "application/epub+zip" },
    method: "POST"
  });
  if (response.status !== 201 && response.status !== 200) {
    throw new Error(`Seeding EPUB returned HTTP ${response.status}: ${await response.text()}`);
  }
  const body = (await response.json()) as { work?: WorkRef };
  if (body.work?.entryId === undefined) {
    throw new Error("Seeding EPUB returned no work entryId.");
  }
  return body.work;
}

async function seedMarkdown(serverPort: number): Promise<WorkRef> {
  const createResponse = await api(serverPort, "/api/works", {
    body: JSON.stringify({
      author: { mode: "new", name: "Smoke Author" },
      language: "en",
      title: "Smoke Markdown",
      workType: "essay"
    }),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
  if (createResponse.status !== 201) {
    throw new Error(`Creating Markdown work returned HTTP ${createResponse.status}.`);
  }
  const created = (await createResponse.json()) as { work: WorkRef };
  const ingestResponse = await api(serverPort, `/api/works/${created.work.entryId}/content`, {
    body: JSON.stringify({ kind: "manual", markdown: markdownSource }),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
  if (ingestResponse.status !== 201 && ingestResponse.status !== 200) {
    throw new Error(`Ingesting Markdown returned HTTP ${ingestResponse.status}.`);
  }
  return created.work;
}

export async function bootStack(): Promise<Stack> {
  const children: ChildProcess[] = [];
  const sourceFilesDir = await mkdtemp(join(tmpdir(), "whetstone-e2e-"));

  const teardown = async (): Promise<void> => {
    for (const child of children.reverse()) {
      await killChild(child);
    }
    await rm(sourceFilesDir, { recursive: true, force: true });
  };

  try {
    const serverPort = await freePort();
    children.push(await startServer(serverPort, sourceFilesDir));
    const epub = await seedEpub(serverPort);
    const markdown = await seedMarkdown(serverPort);

    const webPort = await freePort();
    children.push(await startWebServer(webPort, serverPort));

    return { setup: { baseURL: `http://127.0.0.1:${webPort}/`, epub, markdown }, teardown };
  } catch (error) {
    await teardown();
    throw error;
  }
}
