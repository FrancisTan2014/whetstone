import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { healthEndpointPath } from "@whetstone/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer } from "./createServer.js";

// The single-origin deploy (#184): when `web.dir` is set, the built web client is served from the
// same Fastify origin as the API, so one process on one port serves the whole app. These tests
// assert the observable behavior — the client is served at `/` and from its asset paths — and that
// the API surface (`/health`) is not shadowed by the static wildcard.
describe("web static serving (single origin)", () => {
  let webDir: string;

  beforeEach(async () => {
    webDir = await mkdtemp(join(tmpdir(), "whetstone-web-"));
    await writeFile(join(webDir, "index.html"), "<!doctype html><title>whetstone</title>root-ok");
    await mkdir(join(webDir, "assets"), { recursive: true });
    await writeFile(join(webDir, "assets", "app.js"), "export const marker = 'asset-ok';");
    // The installable PWA (#438) is served from the same origin: the generated manifest and the
    // service worker sit at the site root so the SW controls the whole app.
    await writeFile(
      join(webDir, "manifest.webmanifest"),
      JSON.stringify({ name: "whetstone", display: "standalone" })
    );
    await writeFile(join(webDir, "sw.js"), "self.addEventListener('install', () => {});");
  });

  afterEach(async () => {
    await rm(webDir, { recursive: true, force: true });
  });

  it("serves the built client's index.html at the root", async () => {
    const server = createServer({ logger: false, web: { dir: webDir } });

    try {
      const response = await server.inject({ method: "GET", url: "/" });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("root-ok");
      expect(response.headers["content-type"]).toContain("text/html");
    } finally {
      await server.close();
    }
  });

  it("serves hashed asset paths from the built client", async () => {
    const server = createServer({ logger: false, web: { dir: webDir } });

    try {
      const response = await server.inject({ method: "GET", url: "/assets/app.js" });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("asset-ok");
    } finally {
      await server.close();
    }
  });

  it("serves the PWA manifest with the manifest content-type so the app is installable (#438)", async () => {
    const server = createServer({ logger: false, web: { dir: webDir } });

    try {
      const response = await server.inject({ method: "GET", url: "/manifest.webmanifest" });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("application/manifest+json");
    } finally {
      await server.close();
    }
  });

  it("serves the service worker from the site root so it controls the whole app scope (#438)", async () => {
    const server = createServer({ logger: false, web: { dir: webDir } });

    try {
      const response = await server.inject({ method: "GET", url: "/sw.js" });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("javascript");
    } finally {
      await server.close();
    }
  });

  it("does not let static serving shadow the API surface", async () => {
    const server = createServer({ logger: false, web: { dir: webDir } });

    try {
      const response = await server.inject({ method: "GET", url: healthEndpointPath });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: "ok" });
    } finally {
      await server.close();
    }
  });
});
