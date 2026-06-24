# Quick start

Run whetstone v0 locally and walk through the first reading-and-note flow: create an
author/source, create a work, add reading content, open the reader, select text, and save a
templated note.

This guide covers what exists today: the library admin, the continuous reader, and selected-text
note capture. It does not describe features that are not implemented yet.

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

| Variable           | Default           | Purpose                                                                                                                                         |
| ------------------ | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `HOST`             | `127.0.0.1`       | Address the API server binds to.                                                                                                                |
| `PORT`             | `3000`            | Port the API server listens on (the web dev proxy targets `3000`).                                                                              |
| `LOG_LEVEL`        | `info`            | Pino log level (`fatal`/`error`/`warn`/`info`/`debug`/`trace`/`silent`).                                                                        |
| `DATABASE_DIR`     | _(unset)_         | Directory PGlite persists the database to. **Unset means in-memory** — the database is ephemeral and discarded when the server stops.           |
| `SOURCE_FILES_DIR` | `./.data/sources` | Directory where uploaded source files are retained for provenance (resolved relative to the server's working directory; created automatically). |

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

### Data directory

The fastest first run needs no configuration: with `DATABASE_DIR` unset, the database runs
in-memory and is discarded when the server stops — fine for trying the app out.

To keep your data between restarts, set `DATABASE_DIR` to a directory. Two caveats make an
**absolute path to an already-existing folder** the reliable choice:

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

## 3. Run the API server

Environment configuration (step 2) is optional — with no variables set, the server runs with an
in-memory database on `127.0.0.1:3000`. Build the server (this also copies its database migrations)
and start it:

```powershell
pnpm --filter @whetstone/server build
pnpm --filter @whetstone/server start
```

The server applies migrations and seeds the v0 note templates on boot, then listens on
`http://127.0.0.1:3000`. Health check:

```powershell
curl http://127.0.0.1:3000/health
```

## 4. Run the web client

In a second terminal, start the Vite dev server:

```powershell
pnpm --filter @whetstone/web dev
```

Open the printed URL (by default `http://127.0.0.1:5173`). The dev server proxies all `/api`
requests to the API server on port `3000`, so keep the server from step 3 running.

## 5. First user flow

With both the server and web client running, open the web app. The page shows the **Library admin**,
the **Work content** panel, and the **Reader**.

1. **Create or select an author/source.** In _Library admin → Authors and sources_, enter a name
   and choose **Add author or source**.
2. **Create a work.** In _Works_, enter a title, pick a type and language, then either select your
   author/source or choose **New author or source…** and name one inline. Choose **Create work**.
3. **Add reading content.** In the _Work content_ panel, select your work, then add Markdown content
   in one of two ways:
   - paste Markdown into the **Markdown** box and choose **Add Markdown content**, or
   - choose a `.md` file and choose **Upload file**.

   The Markdown is split into ordered **reading units** (one per heading section) and **blocks**
   (paragraphs, list items, and so on). They appear in the panel as you add them.

4. **Open the reader.** In the _Reader_ section, choose your work from the list. It renders as one
   continuous scroll.
5. **Select text.** Select a word or phrase inside a block. Releasing the selection opens the note
   editor with your selected text anchored to that block.
6. **Create and save a note.** Pick a note template (a size-based default is preselected), fill in at
   least one field, and choose **Save note**. A "Note saved." confirmation appears.

## 6. Validation

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
```
