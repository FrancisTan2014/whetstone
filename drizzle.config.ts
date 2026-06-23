import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  out: "./src/apps/server/src/db/migrations",
  schema: "./src/apps/server/src/db/schema.ts"
});
