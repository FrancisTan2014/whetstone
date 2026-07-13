import { createHealthResponse, healthEndpointPath } from "@whetstone/contracts";
import { describe, expect, it } from "vitest";

import { DEFAULT_USER_ID, type CurrentUserProvider } from "../identity/currentUser.js";
import { createServer } from "./createServer.js";

describe("createServer", () => {
  it("responds to health checks with the shared contract", async () => {
    const server = createServer({ logger: false });

    try {
      const response = await server.inject({ method: "GET", url: healthEndpointPath });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(createHealthResponse());
    } finally {
      await server.close();
    }
  });

  it("decorates the server with the default current-user provider resolving DEFAULT_USER_ID", async () => {
    const server = createServer({ logger: false });

    try {
      expect(server.currentUser.getCurrentUserId()).toBe(DEFAULT_USER_ID);
    } finally {
      await server.close();
    }
  });

  it("lets a handler resolve the current user via the injected provider, overridden by a fake", async () => {
    const fake: CurrentUserProvider = { getCurrentUserId: () => "user-from-fake" };
    const server = createServer({ currentUser: fake, logger: false });
    server.get("/test/current-user", (request) => ({
      userId: request.server.currentUser.getCurrentUserId()
    }));

    try {
      const response = await server.inject({ method: "GET", url: "/test/current-user" });

      expect(response.json()).toEqual({ userId: "user-from-fake" });
    } finally {
      await server.close();
    }
  });

  it("no longer serves the retired reading→Practice nudge routes (#601)", async () => {
    const server = createServer({ logger: false });

    try {
      const get = await server.inject({ method: "GET", url: "/api/nudge" });
      const dismiss = await server.inject({
        method: "POST",
        url: "/api/nudge/harvest-chunk-note-1/dismiss"
      });

      expect(get.statusCode).toBe(404);
      expect(dismiss.statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });
});
