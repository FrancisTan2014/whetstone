import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

// Serve the built web client (the Vite `dist`) from the same Fastify origin as `/api`, so one
// process on one port serves the whole app (#184 single origin). The web client uses relative
// `/api` calls and a hash router, so no SPA history fallback is needed: the browser only ever
// requests `/` (index.html) plus hashed asset paths. The explicit `/health` and `/api/*` routes
// are registered separately and, being literal/parametric, take precedence over this plugin's
// `/*` wildcard, so static serving never shadows the API.
export function registerWebStatic(server: FastifyInstance, webDir: string): void {
  void server.register(fastifyStatic, { root: webDir });
}
