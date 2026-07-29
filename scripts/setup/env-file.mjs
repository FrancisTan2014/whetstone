// The single owner of reading and writing the root `.env` for setup steps. Both the voice (#346) and
// coach (#382) optional steps wire non-secret keys into `.env`, so the parse/upsert/read helpers live
// here — one place that knows the `.env` line format — instead of being duplicated per step.
//
// Node-builtins only: the step registry imports the steps during `pnpm setup` on a fresh clone before
// dependencies exist, so this cannot import the server/contracts packages.

/**
 * Parse simple `KEY=value` lines from a `.env` file's contents (commented lines ignored).
 *
 * @param {string} content
 * @returns {Record<string, string>}
 */
export function parseEnvVars(content) {
  /** @type {Record<string, string>} */
  const vars = {};
  for (const line of content.split("\n")) {
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
 * appended. Entries with an `undefined` value are skipped. Always returns newline-terminated content.
 *
 * @param {string} content
 * @param {Record<string, string | undefined>} vars
 * @returns {string}
 */
export function upsertEnvVars(content, vars) {
  const handled = new Set();
  const lines = (content.length === 0 ? [] : content.split("\n")).map((line) => {
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
  let out = lines.join("\n");
  if (!out.endsWith("\n")) {
    out += "\n";
  }
  return out;
}

/**
 * Remove `.env` lines that assign any of the given keys (active `KEY=` or commented `# KEY=`), leaving
 * every other line untouched. Used to retire a superseded configuration — e.g. the voice step drops the
 * legacy `WHISPER_*` pair once it has written the provider-neutral `LOCAL_ASR_*` pair (#800), so a stale
 * key can never be silently honoured or reported as a mixed config. Always returns newline-terminated
 * content (empty input stays empty).
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
  const kept = content.split("\n").filter((line) => {
    const match = /^\s*#?\s*([A-Z_][A-Z0-9_]*)\s*=/.exec(line);
    return !(match && removed.has(match[1]));
  });
  let out = kept.join("\n");
  if (!out.endsWith("\n")) {
    out += "\n";
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
