// Dev-server smoke test for @whetstone/web.
//
// `pnpm build` (rolldown) and the unit tests (vitest/jsdom) resolve modules from their real on-disk
// location, so a production build can be green while `vite dev` is broken. Vite's dev server is a
// different path: it pre-bundles dependencies into `node_modules/.vite/deps` and resolves their
// imports at serve time -- where a transitive *bare* import that pnpm has not hoisted to a place the
// web app can reach (e.g. `tslib` pulled in by @radix-ui/react-dialog) fails. CI only ran `build`, so
// that class of dev-only breakage reached main undetected.
//
// Done in two phases so the check is not racing Vite's cold-start optimizer (which answers a transient
// HTTP 504 "retry while bundling" that is indistinguishable from a real failure):
//   1. warm up -- boot a throwaway dev server so Vite pre-bundles every dependency into a stable cache.
//   2. verify  -- a fresh dev server reads that cache and fetches each optimized dependency over HTTP,
//      running Vite's real serve-time import-analysis; an unresolved import answers HTTP 500. (Note:
//      a fetch is required -- server.transformRequest resolves through Vite's full resolver, which
//      finds the dep in .pnpm and masks the bug the browser actually hits.)
// Exit 0 = dev server resolves everything; 1 = a dev-only resolution problem.

import { createServer } from 'vite';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const metaPathFor = (server) => path.join(server.config.cacheDir, 'deps', '_metadata.json');

async function readMeta(metaPath) {
  try {
    return JSON.parse(await readFile(metaPath, 'utf8'));
  } catch {
    return null;
  }
}

async function getStatus(url) {
  try {
    const res = await fetch(url);
    await res.text().catch(() => {});
    return res.status;
  } catch {
    return 0; // server not accepting connections
  }
}

// Phase 1: force Vite to pre-bundle dependencies, then wait until the optimizer's hash stops changing.
async function warmUp() {
  const server = await createServer({ root, logLevel: 'silent', server: { host: '127.0.0.1' } });
  try {
    await server.listen();
    try {
      await server.transformRequest('/src/main.tsx'); // drives dep discovery + optimization
    } catch {
      // A mid-optimize "reload" signal here is expected; we only care that bundling was triggered.
    }
    const metaPath = metaPathFor(server);
    let prev = null;
    let stable = 0;
    for (let i = 0; i < 120 && stable < 4; i++) {
      const hash = (await readMeta(metaPath))?.browserHash ?? null;
      stable = hash && hash === prev ? stable + 1 : 0;
      prev = hash;
      await sleep(250);
    }
  } finally {
    await server.close();
  }
}

// Phase 2: a fresh server reads the warm cache; fetch each optimized dep over HTTP. A warm cache means
// no cold-start 504 race, so a dep that stays non-2xx after retries is a genuine resolution failure.
async function verify() {
  const problems = [];
  const server = await createServer({ root, logLevel: 'warn', server: { host: '127.0.0.1' } });
  try {
    await server.listen();
    const base = server.resolvedUrls.local[0];
    const metaPath = metaPathFor(server);
    let meta = await readMeta(metaPath);
    if (!meta) return ['dependency optimizer produced no metadata'];
    const optimized = Object.entries(meta.optimized ?? {});
    if (optimized.length === 0) return ['no optimized dependencies were produced'];

    for (const [id, info] of optimized) {
      let status = 0;
      for (let attempt = 0; attempt < 10; attempt++) {
        meta = (await readMeta(metaPath)) ?? meta;
        status = await getStatus(`${base}node_modules/.vite/deps/${path.basename(info.file)}?v=${meta.browserHash}`);
        if (status >= 200 && status < 400) break;
        await sleep(400); // transient 504 while (re)bundling; retry with the fresh hash
      }
      if (!(status >= 200 && status < 400)) {
        problems.push(`optimized dep "${id}" (${path.basename(info.file)}) -> HTTP ${status}`);
      }
    }
    return problems;
  } finally {
    await server.close();
  }
}

let failed = false;
try {
  await warmUp();
  const problems = await verify();
  if (problems.length > 0) {
    failed = true;
    console.error(`\nDev smoke FAILED -- ${problems.length} problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
  } else {
    console.log('Dev smoke OK -- the dev server pre-bundled and resolved every dependency.');
  }
} catch (err) {
  failed = true;
  console.error(`Dev smoke FAILED -- ${err.message}`);
}

process.exit(failed ? 1 : 0);
