import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "migrations");

export async function runMigrations(pglite: PGlite): Promise<void> {
  const db = drizzle(pglite);
  await migrate(db, { migrationsFolder });
}
