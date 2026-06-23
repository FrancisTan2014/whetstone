import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

import * as schema from "./schema.js";

export type DbClient = ReturnType<typeof drizzle<typeof schema>>;

export function createDbClient(pglite: PGlite): DbClient {
  return drizzle(pglite, { schema });
}
