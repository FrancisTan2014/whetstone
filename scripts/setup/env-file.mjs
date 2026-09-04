// The single owner of reading and writing the root `.env` for setup steps. Both the voice (#346) and
// coach (#382) optional steps wire non-secret keys into `.env`, so the parse/upsert/read helpers live
// here — one place that knows the `.env` line format — instead of being duplicated per step.
//
// Node-builtins only: the step registry imports the steps during `pnpm setup` on a fresh clone before
// dependencies exist, so this cannot import the server/contracts packages.

// `.env` files use CRLF on Windows and LF elsewhere. Split on either so a CRLF file parses and rewrites
// identically to its LF twin: a bare `content.split("\n")` leaves a trailing `\r` on every line, and
// since `.` never matches `\r`, that `\r` defeats the value regex's `$` anchor and the whole file reads
// as empty (#915). A classic-Mac lone `\r` (no following `\n`) is intentionally out of scope.
const LINE_SPLIT = /\r?\n/;

/**
 * The line ending to rewrite a `.env` with. We deliberately PRESERVE the file's existing convention
 * rather than forcing LF: a Windows contributor's `.env` is CRLF, and upserting a single key must not
 * silently convert the whole file's line endings. Any CRLF present means treat the file as CRLF,
 * otherwise LF; the chosen ending is then applied to every line, so the result is never mixed. (Before
 * #915 a rewritten line was rebuilt without its `\r` while untouched lines kept theirs, which silently
 * mixed endings.) An empty file has no ending to preserve and defaults to LF.
 *
 * @param {string} content
 * @returns {string}
 */
function detectEol(content) {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Parse simple `KEY=value` lines from a `.env` file's contents (commented lines ignored).
 *
 * @param {string} content
 * @returns {Record<string, string>}
 */
export function parseEnvVars(content) {
  /** @type {Record<string, string>} */
  const vars = {};
  for (const line of content.split(LINE_SPLIT)) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match) {
      vars[match[1]] = match[2].trim();
    }
  }
  return vars;
}

/**
 * Upsert `KEY=value` entries into `.env` contents: an existing active *or commented* `KEY=` line is
 * rewritten in place (uncommenting the `.env.example` template line), otherwise the entry is
 * appended. Entries with an `undefined` value are skipped. Always returns content terminated with the
 * file's existing line ending (CRLF preserved, else LF; see `detectEol`).
 *
 * @param {string} content
 * @param {Record<string, string | undefined>} vars
 * @returns {string}
 */
export function upsertEnvVars(content, vars) {
  const eol = detectEol(content);
  const handled = new Set();
  const lines = (content.length === 0 ? [] : content.split(LINE_SPLIT)).map((line) => {
    const match = /^\s*#?\s*([A-Z_][A-Z0-9_]*)\s*=/.exec(line);
    if (match && vars[match[1]] !== undefined) {
      handled.add(match[1]);
      return `${match[1]}=${vars[match[1]]}`;
    }
    return line;
  });
  for (const [key, value] of Object.entries(vars)) {
    if (value !== undefined && !handled.has(key)) {
      lines.push(`${key}=${value}`);
    }
  }
  let out = lines.join(eol);
  if (!out.endsWith(eol)) {
    out += eol;
  }
  return out;
}

/**
 * Remove `.env` lines that assign any of the given keys (active `KEY=` or commented `# KEY=`), leaving
 * every other line untouched. Used to retire a superseded configuration — e.g. the voice step drops the
 * legacy `WHISPER_*` pair once it has written the provider-neutral `LOCAL_ASR_*` pair (#800), so a stale
 * key can never be silently honoured or reported as a mixed config. Always returns content terminated
 * with the file's existing line ending (CRLF preserved, else LF; see `detectEol`); empty input stays
 * empty.
 *
 * @param {string} content
 * @param {string[]} keys
 * @returns {string}
 */
export function removeEnvVars(content, keys) {
  const removed = new Set(keys);
  if (content.length === 0) {
    return content;
  }
  const eol = detectEol(content);
  const kept = content.split(LINE_SPLIT).filter((line) => {
    const match = /^\s*#?\s*([A-Z_][A-Z0-9_]*)\s*=/.exec(line);
    return !(match && removed.has(match[1]));
  });
  let out = kept.join(eol);
  if (!out.endsWith(eol)) {
    out += eol;
  }
  return out;
}

/**
 * The root `.env` path for the repository the setup context runs in.
 *
 * @param {import("./step.mjs").SetupContext} ctx
 * @returns {string}
 */
export function envPath(ctx) {
  return `${ctx.root}/.env`;
}

/**
 * Read the current `.env` as a `KEY=value` map, or `{}` when the file does not exist yet.
 *
 * @param {import("./step.mjs").SetupContext} ctx
 * @returns {Record<string, string>}
 */
export function readEnv(ctx) {
  const path = envPath(ctx);
  return ctx.fs.exists(path) ? parseEnvVars(ctx.fs.readText(path)) : {};
}
