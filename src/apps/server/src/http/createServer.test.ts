import { createHealthResponse, healthEndpointPath } from "@whetstone/contracts";
import { describe, expect, it } from "vitest";

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
});
