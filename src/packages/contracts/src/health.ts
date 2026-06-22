export const healthEndpointPath = "/health" as const;

export type HealthResponse = Readonly<{
  service: "whetstone-server";
  status: "ok";
}>;

export const healthResponseJsonSchema = {
  additionalProperties: false,
  properties: {
    service: { const: "whetstone-server", type: "string" },
    status: { const: "ok", type: "string" }
  },
  required: ["status", "service"],
  type: "object"
} as const;

export function createHealthResponse(): HealthResponse {
  return {
    service: "whetstone-server",
    status: "ok"
  };
}
