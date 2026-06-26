import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { bootStack, type Stack } from "./stack";

// Where globalSetup hands the running stack's base URL + seeded work ids to the test fixtures.
export const tmpDir = join(dirname(fileURLToPath(import.meta.url)), ".tmp");
export const setupFile = join(tmpDir, "setup.json");

// Playwright runs this once before the suite and uses the returned function as global teardown.
// The real stack (server + web dev server) is spawned here and stays up for the whole run.
export default async function globalSetup(): Promise<() => Promise<void>> {
  await mkdir(tmpDir, { recursive: true });
  let stack: Stack;
  try {
    stack = await bootStack();
  } catch (error) {
    await rm(tmpDir, { recursive: true, force: true });
    throw error;
  }
  await writeFile(setupFile, JSON.stringify(stack.setup, null, 2), "utf8");

  return async (): Promise<void> => {
    await stack.teardown();
    await rm(tmpDir, { recursive: true, force: true });
  };
}
