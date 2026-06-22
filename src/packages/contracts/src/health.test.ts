import { describe, expect, it } from "vitest";

import { createHealthResponse, healthEndpointPath, healthResponseJsonSchema } from "./health.js";

describe("health contract", () => {
  it("defines the shared health route response", () => {
    expect(healthEndpointPath).toBe("/health");
    expect(createHealthResponse()).toEqual({ service: "whetstone-server", status: "ok" });
    expect(healthResponseJsonSchema.required).toEqual(["status", "service"]);
  });
});
