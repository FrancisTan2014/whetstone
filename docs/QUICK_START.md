# Quick start

Run whetstone v0 locally and walk through the first reading-and-note flow: create an
author/source, create a work, add reading content, open the reader, select text, and save a
templated note.

This guide covers what exists today: the library admin, the continuous reader, and selected-text
note capture. It does not describe features that are not implemented yet.

## Set up and run (one command)

A fresh clone reaches a working app with **one command**, then one to run it:

```powershell
pnpm setup   # bootstrap: toolchain, install, build, E2E browser, .env — plus voice + local coach (consent-gated)
pnpm dev     # run the whole stack
```

`pnpm setup` runs a small set of declarative steps idempotently and is **self-guiding on failure**:
if a step can't complete it prints exactly *what* went wrong and the *precise remedy*, then exits
non-zero — fix it and re-run `pnpm setup`, which resumes from where it stopped (already-ready steps
are skipped). To just check readiness without changing anything:

```powershell
pnpm setup:doctor   # report each capability as ready / optional-missing / failed; never mutates
```

Heavy/system capabilities (voice, local coach, PDF ingestion) are **included in the base `pnpm
setup`**, but each system install stays **consent-gated**: on a terminal you press **Y** before
Ollama/Python/OCRmyPDF is installed; decline (or run non-interactively, e.g. CI) and that step falls
back to instruct-only and the run still exits 0 — nothing installs silently. For a lean run that
skips voice/coach/PDF entirely (fast iteration, reader-only, CI), use the opt-out:

```powershell
pnpm setup:minimal   # base only: toolchain, install, build, E2E browser, .env — no voice/coach/pdf, no prompts
```

You can also (re)run a single capability on its own with `pnpm setup:voice`, `pnpm setup:coach`,
`pnpm setup:pdf`, or `pnpm setup:all` (every capability). The canonical set: `pnpm setup` (full,
consent-gated) / `pnpm setup:minimal` (lean) / `pnpm setup:doctor` (probe only).

> **Why baked-in scripts and not a flag on `pnpm setup`?** `setup` is a **built-in pnpm command**, so
> `pnpm setup` with any flag is routed to pnpm's built-in and fails with `Unknown option`. The
> capability scripts (`setup:minimal`, `setup:voice`, `setup:coach`, `setup:pdf`, `setup:all`,
> `setup:doctor`) bake the flag in and don't collide. For a raw flag/env combo, use the explicit run
> form: `pnpm run setup -- --<flag>` (e.g. `pnpm run setup -- --yes` for unattended consent).

### Voice input (optional)

Spoken practice transcribes locally with Whisper. The base `pnpm setup` already installs it
(consent-gated); if you ran `pnpm setup:minimal`, or declined the prompt, voice stays off — a spoken
turn transcribes to empty and the server logs a one-line boot warning telling you how to enable it.
To (re)run just this capability:

```powershell
pnpm setup:voice   # installs faster-whisper + the whetstone-whisper wrapper, fetches the model, writes WHISPER_* to .env
```

Pick a different model with `WHISPER_MODEL` (default `small`, multilingual): e.g.
`WHISPER_MODEL=base.en pnpm run setup -- --voice` for English-only. After it finishes, restart `pnpm dev`
and speaking yields a real transcript. Details and the STT contract: [docs/SPEECH.md](./SPEECH.md).

### PDF ingestion (optional)

Uploading a `.pdf` converts it to Markdown with the local **Docling** worker behind an
**OCRmyPDF/Tesseract** pre-pass for scanned pages. Unlike voice/coach there is **no runtime fake**, so
if the toolchain is absent a perfectly valid PDF fails to convert — the app now says so distinctly
("PDF ingestion isn't set up on the server yet. Run `pnpm setup:pdf`…") instead of blaming the file,
and a genuinely corrupt/unsupported PDF still reads as "We couldn't read this PDF." Check or enable the
lane with:

```powershell
pnpm setup:doctor   # reports the PDF lane: which of Python / Docling / OCRmyPDF / Tesseract is missing
pnpm setup:pdf      # installs Python (consent-gated) + the Docling pip package; OCRmyPDF/Tesseract are consent-gated where a clean install exists, else instruct-only
```

`setup:pdf` auto-installs what it safely can (Python via winget/brew after a Y, then `pip install
docling`) and reports the exact remedy for the heavier system tools (OCRmyPDF + Tesseract) where no
clean one-command install exists (notably Windows). Nothing installs silently; a declined or
non-interactive run stays green and prints how to finish by hand.

No separate database server is required: v0 uses an embedded PostgreSQL engine
([PGlite](https://github.com/electric-sql/pglite)) that runs in-process, so `setup` provisions no
Postgres — you only need Node and pnpm.

The rest of this guide explains the same steps in detail (useful when a `setup` step reports a
problem, or to run pieces by hand).

## Prerequisites

- **Node.js >= 22** (`node -v`).
- **pnpm 11.8.0** — the version is pinned in `package.json` (`packageManager`). The simplest way to
  get the matching version is Corepack, which ships with Node:

  ```powershell
  corepack enable
  ```

No separate database server is required: v0 uses an embedded PostgreSQL engine
([PGlite](https://github.com/electric-sql/pglite)) that runs in-process, so you only need Node and
pnpm.

## 1. Install dependencies

> These next steps are what `pnpm setup` above does for you; run them by hand only if you skipped
> `pnpm setup` or a setup step reported a problem.

From the repository root:

```powershell
pnpm install
```

The workspace uses TypeScript project references and shared packages (`@whetstone/domain`,
`@whetstone/contracts`). Build them once so the server and web app can resolve them:

```powershell
pnpm build
```

The filtered app `dev`/`build` scripts also compile their referenced packages first, so a fresh
install plus the steps below works without any extra setup.

## 2. Configure the server (optional environment variables)

The server reads configuration from environment variables at startup. The `start` script loads
a `.env` file from the repository root if one exists (via Node's `--env-file-if-exists`), and you
can also set overrides in your shell before starting the server. All variables below are optional
and have sensible defaults.

| Variable           | Default           | Purpose                                                                                                                                                                                                                 |
| ------------------ | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HOST`             | `127.0.0.1`       | Address the API server binds to.                                                                                                                                                                                        |
| `PORT`             | `3000`            | Port the API server listens on (the web dev proxy targets `3000`).                                                                                                                                                      |
| `LOG_LEVEL`        | `info`            | Pino log level (`fatal`/`error`/`warn`/`info`/`debug`/`trace`/`silent`).                                                                                                                                                |
| `DATABASE_DIR`     | _(unset)_         | Directory PGlite persists the database to. **Unset means in-memory** — ephemeral, discarded when the server stops. The `dev` script (below) defaults this to a git-ignored local folder so dev data survives a restart. |
| `SOURCE_FILES_DIR` | `./.data/sources` | Directory where uploaded source files are retained for provenance (resolved relative to the server's working directory; created automatically).                                                                         |

### Vocabulary lookup keys (optional)

The reader's **Look up** action resolves English definitions through a provider chain:
Merriam-Webster's Learner's Dictionary, then Collegiate, then the free
[dictionaryapi.dev](https://dictionaryapi.dev) fallback. **No keys are required** — with none
set, lookups use the free fallback.

To enable the Merriam-Webster sources, copy the committed `.env.example` to `.env` at the
repository root and paste your own keys (get free non-commercial keys at
[dictionaryapi.com](https://dictionaryapi.com/)):

```powershell
Copy-Item .env.example .env
```

| Variable                         | Purpose                                                       |
| -------------------------------- | ------------------------------------------------------------- |
| `MERRIAM_WEBSTER_LEARNERS_KEY`   | Merriam-Webster Learner's Dictionary key (primary source).    |
| `MERRIAM_WEBSTER_COLLEGIATE_KEY` | Merriam-Webster Collegiate Dictionary key (broader fallback). |

The server start script loads `.env` via Node's built-in `--env-file-if-exists=.env`, so a
missing `.env` is fine (no extra dependency, nothing to fail in CI). Each Merriam-Webster
source is skipped when its key is absent. Never commit `.env` or real keys — `.gitignore`
ignores `.env`/`.env.*` and allows only `.env.example`.

### Coaching model (optional)

The speaking coach runs on a **local Ollama LLM** when configured, and falls back to a deterministic
fake when it isn't — so no model is required for the loop or the `pnpm validate` gate. The base
`pnpm setup` already provisions it (consent-gated); to (re)run just this capability end to end:

```powershell
pnpm setup:coach   # installs Ollama (with a Y/N prompt), pulls the converse + 解释 models, writes the coach env to .env
```

It installs Ollama itself (consent-gated — an explicit `Y`, or `--yes` for unattended), pulls the
converse model (`llama3.1:8b`) and the 文言 explain model (`qwen2.5`), and writes `COACH_MODEL`,
`EXPLAIN_MODEL`, `COACH_CONVERSE_TIER=cheap`, and `COACH_ANALYZE_TIER=cheap` to `.env` — a
**fully-local coach** (no cloud key, no data leaving the machine). Pick a different converse model with
`COACH_MODEL`, or a different explain model with `EXPLAIN_MODEL`; setup pulls, verifies, and persists
the exact model you choose, so the server serves it too. After it finishes, restart the server.

With no `COACH_API_KEY`, the coach still runs its cheap/local tier for real; because `pnpm setup
--coach` writes `COACH_ANALYZE_TIER=cheap`, every call is local (no cloud call). Any call still routed
to `strong` without a key falls back to the deterministic fake.

| Variable        | Default   | Purpose                                                             |
| --------------- | --------- | ------------------------------------------------------------------- |
| `COACH_*_TIER`  | see docs  | Per-call tier override (`cheap` = local Ollama / `strong` = cloud). |
| `COACH_API_KEY` | _(unset)_ | Cloud key — only for the optional cloud judge (see below).          |

**Optional cloud judge (manual):** to route the end-of-round _analyze_ (judge) call to a stronger
cloud model instead of local, set `COACH_API_KEY` (never commit it) and `COACH_ANALYZE_TIER=strong`,
then start the server:

```bash
export COACH_API_KEY=sk-...
export COACH_ANALYZE_TIER=strong
pnpm --filter @whetstone/server start
```

On boot the server probes the local model and logs the result; if Ollama is down or the model is
unpulled it **warns with an `ollama pull` hint and keeps running on the fake** (no crash). Full
detail — tiers, routing, and the boot health check — is in [docs/COACH.md](./COACH.md).

### Lookup "AI 解释" tab (optional, Chinese only)

For a Chinese selection, the reader's lookup popover offers an optional **"AI 解释 / Explain in context"**
tab that sends the selected span plus its surrounding block to a **local** model and shows a short,
clearly **AI-generated** contextual gloss — useful for classical-Chinese terms, 成語, allusions, and
proper nouns the bundled dictionaries structurally miss. It reuses the same local Ollama daemon as the
coach and is wired by the same `pnpm setup:coach` (which pulls `EXPLAIN_MODEL`, default `qwen2.5`,
and writes it to `.env`). To point it at a different 文言-strong model, pull it and set `EXPLAIN_MODEL`:

```bash
ollama pull qwen2.5
export EXPLAIN_MODEL=qwen2.5
```

**Unset ⇒ the tab is absent/honest**: with no model configured it shows a plain "unavailable" state
(never a hang, never a fabricated entry), the dictionary tabs still work, and `pnpm validate` stays
green with no model. No cloud key is required. The gloss is a labeled reading aid, never an
authoritative dictionary entry, and creates no note.

### Data directory

For the iterative dev loop, run the server with `pnpm --filter @whetstone/server dev`. It
**persists the database by default** to a git-ignored folder (`src/apps/server/.data/db`,
created automatically), so ingested works and blocks survive a server restart (file-watch
reload, crash, or a manual restart) and notes you add afterward keep working. Without
persistence, a restart wipes every block while the browser still shows the work, so the next
note save fails with `block_not_found` (404).

The fastest one-off first run still needs no configuration: `pnpm --filter @whetstone/server
start` (and the raw binary) leaves `DATABASE_DIR` unset, so the database runs in-memory and is
discarded when the server stops — fine for trying the app out. To force the in-memory database
even under `dev`, set `DATABASE_DIR` to an empty string (`$env:DATABASE_DIR = ""`).

To choose your own persistent location (with either `dev` or `start`), set `DATABASE_DIR`
yourself — an explicit value always wins. Two caveats make an **absolute path to an
already-existing folder** the reliable choice:

- The `pnpm --filter @whetstone/server start` command runs with its working directory set to the
  server package (`src/apps/server`), so a _relative_ path resolves there, not at the repo root.
- PGlite does not create missing parent directories, so the folder (and its parent) must already
  exist.

Create the folder first, then point `DATABASE_DIR` at it (the `.data/` folder is git-ignored):

```powershell
New-Item -ItemType Directory -Force -Path "$PWD\.data\db" | Out-Null
$env:DATABASE_DIR = "$PWD\.data\db"
```

On macOS/Linux: `mkdir -p "$PWD/.data/db"` then `export DATABASE_DIR="$PWD/.data/db"`.

### Where Markdown is stored

- **Uploaded `.md` files** are written to `SOURCE_FILES_DIR` (default `./.data/sources`) under a
  server-generated name (`<id>.md`) and kept for provenance only.
- **Manually entered Markdown** is retained as provenance text in the database, not as a file.

In both cases the content the reader shows comes from **blocks stored in the database**, not from
these files — the retained source is kept only so you can trace where content came from.

## 3. Run the app (one command)

For the iterative dev loop, a single command from the repository root brings up the whole
stack — the API server **from source with reload** and the web dev server — together:

```powershell
pnpm dev
```

This builds the shared packages (`@whetstone/domain`, `@whetstone/contracts`) once, then runs
the API server via `tsx watch` and the Vite web dev server, streaming both logs to the
terminal. Because the server runs from **source with reload**, a server route you just changed
is live on the next request **without a manual `pnpm build`** — no more stale `dist/` returning
404s for endpoints the source already has. The server persists its database to a git-ignored
local folder by default (see [Data directory](#data-directory)), so ingested content and notes
survive each reload. Press Ctrl-C to stop both.

The server listens on `http://127.0.0.1:3000` and the web app on `http://127.0.0.1:5173` (the
web dev server proxies all `/api` requests to the server). Environment configuration (step 2)
is optional. Health check:

```powershell
curl http://127.0.0.1:3000/health
```

### Run the server and web separately (alternative)

You can also run the two halves in their own terminals. The server's `dev` script runs from
source with reload, just like `pnpm dev`:

```powershell
pnpm --filter @whetstone/server dev
```

```powershell
pnpm --filter @whetstone/web dev
```

For a throwaway run with an in-memory database (discarded when the server stops), use the
production `start` path instead — it serves the built `dist`, so build it first and rebuild
after server changes:

```powershell
pnpm --filter @whetstone/server build
pnpm --filter @whetstone/server start
```

The server applies migrations and seeds the v0 note templates on boot. Open the web app's
printed URL (by default `http://127.0.0.1:5173`) and keep the server running.

### Host runtime config (native shells)

The web app resolves every API call through one host-runtime contract instead of assuming
same-origin `/api`, so the same bundle runs as browser web, a desktop shell, or an iOS shell (#445).

- **Browser web (default):** nothing is injected, so the app uses `platform="web"` and
  `apiBaseUrl="/api"` — the Vite dev proxy (above) forwards `/api` to the server, unchanged.
- **Native shell (desktop/iOS):** the shell runs from a local app origin where same-origin `/api` is
  wrong, so it injects the config on `window` **before** the web bundle boots:

  ```html
  <script>
    window.__WHETSTONE_HOST_CONFIG__ = {
      platform: "ios", // or "desktop"
      apiBaseUrl: "https://your-api-host.example/api" // absolute for native
    };
  </script>
  ```

  `src/main.tsx` validates this once at startup (`bootstrapApiRuntime`). Valid config is trusted
  inward and every `apiUrl(...)` call targets it; invalid config fails loud with a blocking startup
  screen that states what is wrong and how to fix it — it never silently falls back to a fake default.
  Both shells ship: the desktop shell (Tauri) in § 7 and the iOS shell (Capacitor) in § 8.

## 4. First user flow

With both the server and web client running, open the web app. The page shows the **Library admin**,
the **Work content** panel, and the **Reader**.

> **Fastest path — the shelf's one Upload front door.** On the Library shelf, the single **Upload**
> control accepts `.epub`, `.pdf`, and `.md` and creates a **new Work** from the file. An EPUB ingests
> straight away (its embedded metadata is authoritative); a PDF or Markdown file first opens the
> **Add work** sheet, pre-filled with the title from the filename, so you can confirm the metadata
> before it ingests. The manual steps below remain available for building a work by hand.

1. **Create or select an author/source.** In _Library admin → Authors and sources_, enter a name
   and choose **Add author or source**.
2. **Create a work.** In _Works_, enter a title, pick a type and language, then either select your
   author/source or choose **New author or source…** and name one inline. Choose **Create work**.
3. **Add reading content.** In the _Work content_ panel, select your work, then paste Markdown into
   the **Markdown** box and choose **Add Markdown content**. (To bring in a whole file — `.epub`,
   `.pdf`, or `.md` — use the shelf's **Upload** control instead; it creates a new Work.)

   The Markdown is split into ordered **reading units** (one per heading section) and **blocks**
   (paragraphs, list items, and so on). They appear in the panel as you add them.

4. **Open the reader.** In the _Reader_ section, choose your work from the list. It renders as one
   continuous scroll.
5. **Select text.** Select a word or phrase inside a block. Releasing the selection opens the note
   editor with your selected text anchored to that block.
6. **Create and save a note.** Pick a note template (a size-based default is preselected), fill in at
   least one field, and choose **Save note**. A "Note saved." confirmation appears.

## 5. Validation

Run the full gate before opening a pull request (it mirrors CI):

```powershell
pnpm validate
```

`pnpm validate` runs each step in turn; you can also run them individually:

```powershell
pnpm typecheck   # tsc project references
pnpm lint        # ESLint + Prettier check
pnpm test        # Vitest with 100% coverage thresholds
pnpm build       # build all packages and apps
pnpm smoke       # boot the web dev server and check every dependency resolves at serve time
pnpm e2e         # Playwright E2E smoke: boot the real stack and drive the core reader loop in a browser
```

The `pnpm e2e` step needs the Chromium browser installed once (CI does this automatically):

```powershell
pnpm exec playwright install chromium
```

## 6. Deploying to a phone-reachable URL (optional)

To run whetstone continuously on a Mac and reach it from your phone over HTTPS, follow
[docs/DEPLOY.md](./DEPLOY.md). For a **stable URL that survives reboots**, the default fast path is
**Tailscale `serve`** — a private, tailnet-only `https://<machine>.<tailnet>.ts.net` over a direct
WireGuard connection (near-LAN speed, no public exposure), asserted by the deploy CI via the
`TAILSCALE_SERVE_ENABLED` repo variable. A **named Cloudflare Tunnel** (`whetstone.<your-domain>`) is
the alternative if you own a Cloudflare domain, and **Tailscale Funnel** is the opt-in way to share
publicly — never a random `trycloudflare.com` quick tunnel. Any tokens/keys stay in the host's
environment; nothing secret is committed. See
[DEPLOY.md § 5 — A stable, fast URL (Tailscale `serve`)](./DEPLOY.md#5-a-stable-fast-url-tailscale-serve--recommended).

## 7. Desktop app (Tauri, Windows/macOS)

whetstone ships as a **native desktop app** (`src/apps/desktop/`) using a Tauri v2 shell around the
same web core — no Electron. The window loads the **bundled** web build (not a remote URL) and injects
the host runtime config (`platform="desktop"` + your `apiBaseUrl`) before the web app boots.

**Prerequisites (once):** the Rust toolchain (`rustup`, `cargo`) and the Tauri platform prerequisites
for your OS — on Windows the **WebView2 runtime** (preinstalled on Windows 10/11) and the MSVC build
tools; on macOS the Xcode command-line tools. See
[tauri.app/start/prerequisites](https://tauri.app/start/prerequisites/). Then `pnpm install` at the
repo root pulls the `@tauri-apps/cli`.

**Configure the API base URL.** Native builds require an explicit, absolute `apiBaseUrl` (an empty or
relative value triggers the fail-loud startup screen from #445). Set it via the
`WHETSTONE_API_BASE_URL` environment variable:

```powershell
# Point the desktop shell at a reachable API server (dev: the local server via the Vite proxy)
$env:WHETSTONE_API_BASE_URL = "http://localhost:5173/api"   # dev
# $env:WHETSTONE_API_BASE_URL = "https://whetstone.example.ts.net/api"  # packaged, your server
```

**Dev run** (against a local server — start the API server first, e.g. `pnpm dev` in another
terminal):

```powershell
pnpm --filter @whetstone/desktop dev
```

This launches the Vite web dev server (`beforeDevCommand`) and opens the desktop window pointing at it.

**Production package build** (produces installers under `src/apps/desktop/src-tauri/target/release/bundle/`):

```powershell
pnpm --filter @whetstone/web build      # ensure the web dist exists (also run by beforeBuildCommand)
pnpm --filter @whetstone/desktop build
```

The build embeds the current web `dist`. Bake a default API base into a packaged build by setting
`WHETSTONE_API_BASE_URL` in the environment before `build`.

**Desktop shell tests** (pure Rust config/navigation helpers):

```powershell
pnpm --filter @whetstone/desktop test   # cargo test --lib
```

**macOS packaging** uses the same commands (`pnpm --filter @whetstone/desktop build`) and is CI-ready;
code-signing and store distribution are out of scope here.

## 8. iOS app (Capacitor, macOS only)

whetstone also ships as a **native iOS app** (`src/apps/mobile/`) using a
[Capacitor](https://capacitorjs.com/) shell around the same web core. The app embeds the **bundled**
web build (it does not load a remote URL) and injects the host runtime config (`platform="ios"` + your
absolute `apiBaseUrl`) into the packaged `index.html` before the web app boots, so every API call
targets your server (the on-device app has no local Ollama/Whisper — Practice and lookup call the
server APIs). External links (e.g. the reader's dictionary lookups) open in **Safari**, not the app
webview.

> **Windows note.** The native iOS project is generated and built with Apple tooling, so **§ 8 requires
> macOS** (Xcode + CocoaPods + an Apple Developer account). The cross-platform pieces — the Capacitor
> config, the host-config injection logic, the `Info.plist` permission patch, and their unit tests —
> live in this repo and run anywhere; generating the `ios/` Xcode project and the simulator/TestFlight
> steps below can only be executed on a Mac. The steps that are macOS-only are marked **(macOS)**.

**Prerequisites (macOS, once):** Xcode (with the iOS SDK and command-line tools), CocoaPods
(`sudo gem install cocoapods`), and an Apple Developer account for device/TestFlight builds. Then
`pnpm install` at the repo root pulls the Capacitor CLI and libraries.

**Configure the API base URL.** iOS builds require an explicit, absolute `apiBaseUrl` (an empty or
relative value fails loud — the sync step aborts with the fix, and the runtime shows the #445 startup
screen). Set it via `WHETSTONE_API_BASE_URL`:

```bash
export WHETSTONE_API_BASE_URL="https://whetstone.example.ts.net/api"   # your reachable server
```

**First-time platform generation (macOS):**

```bash
pnpm --filter @whetstone/mobile add:ios   # generates src/apps/mobile/ios and applies the mic permission
```

**Microphone permission is applied automatically (AC #4).** Practice records voice, so iOS requires an
`NSMicrophoneUsageDescription`. Rather than a manual edit, `add:ios` and `sync` run a checked-in patch
(`scripts/applyIosPermissions.ts`, unit-tested) that ensures this key is present in
`src/apps/mobile/ios/App/App/Info.plist` (idempotent). The committed iOS project keeps the permission,
so a clean checkout following these scripts is TestFlight-ready. To (re)apply it on its own:

```bash
pnpm --filter @whetstone/mobile apply:permissions
```

**Build, sync, and open (macOS):**

```bash
pnpm --filter @whetstone/mobile sync      # build web, `cap sync ios`, inject host config, apply mic permission
pnpm --filter @whetstone/mobile open:ios  # opens the project in Xcode
```

In Xcode, select a simulator or a connected device and press **Run**. `sync` embeds the current web
`dist` and bakes in `WHETSTONE_API_BASE_URL`; re-run it after any web change.

**Mobile shell tests** (pure host-config + permission glue; run anywhere including Windows/CI, part of
`pnpm test`):

```bash
pnpm exec vitest run src/apps/mobile
```

### TestFlight handoff checklist (macOS)

1. Set a distributable `WHETSTONE_API_BASE_URL` (a public/tailnet server the phone can reach), then
   `pnpm --filter @whetstone/mobile sync`.
2. In Xcode → **Signing & Capabilities**, select your Apple Developer team and set a unique bundle
   identifier (defaults to `com.whetstone.app`).
3. `NSMicrophoneUsageDescription` is applied automatically by `add:ios`/`sync` (above) — no manual edit.
4. Set the version/build number, choose **Any iOS Device (arm64)**, then **Product → Archive**.
5. In the Organizer, **Distribute App → App Store Connect → Upload**.
6. In App Store Connect, add the build to **TestFlight**, complete export-compliance answers, and
   invite testers.

App Store submission assets, review, and legal are out of scope here. Android is a non-goal.
