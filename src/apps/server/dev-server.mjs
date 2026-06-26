// Local development entrypoint, run via `tsx watch` (see the package `dev` script) so the
// server runs from TypeScript **source** and reloads on change. That means a newly landed
// route is live without a manual `build` — no more stale `dist/` serving 404s for endpoints
// the source already has.
//
// It also defaults the PGlite database to a git-ignored on-disk directory so ingested works
// and blocks survive a server restart (file-watch reload, crash, or a manual restart). The
// in-memory default would wipe them, which left the browser holding now-stale block ids and
// made the next note save fail with `block_not_found` (404).
//
// Persistence is opt-out: an explicit DATABASE_DIR (e.g. from .env) still wins, and setting
// DATABASE_DIR to an empty string forces the ephemeral in-memory database. Tests and the
// screenshot harness run the built dist/index.js directly with DATABASE_DIR unset, so they
// stay ephemeral and are unaffected by this entrypoint. Production runs `start`
// (`node dist/index.js`), never this file.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = dirname(fileURLToPath(import.meta.url));
const defaultDatabaseDir = join(serverDir, ".data", "db");

if (process.env.DATABASE_DIR === undefined) {
  // PGlite does not create missing parent directories, so make sure the folder exists.
  mkdirSync(defaultDatabaseDir, { recursive: true });
  process.env.DATABASE_DIR = defaultDatabaseDir;
}

// Import the TypeScript source (not dist) so `tsx watch` reloads on source changes.
await import("./src/index.ts");
