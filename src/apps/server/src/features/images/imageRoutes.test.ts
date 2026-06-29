import { describe, expect, it, vi } from "vitest";

import type { ImageResource } from "../../files/imageResourceStore.js";
import { createServer } from "../../http/createServer.js";

const validId = "a".repeat(64);
const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 8, 7]);

function buildServer(read: (id: string) => Promise<ImageResource | undefined>) {
  return createServer({ images: { imageResourceStore: { read } }, logger: false });
}

describe("GET /api/images/:id", () => {
  it("serves the stored bytes with the recorded content type and an immutable cache header", async () => {
    const read = vi.fn().mockResolvedValue({ bytes: pngBytes, contentType: "image/png" });
    const server = buildServer(read);

    try {
      const response = await server.inject({ method: "GET", url: `/api/images/${validId}` });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe("image/png");
      expect(response.headers["cache-control"]).toContain("immutable");
      expect(new Uint8Array(response.rawPayload)).toEqual(pngBytes);
      expect(read).toHaveBeenCalledWith(validId);
    } finally {
      await server.close();
    }
  });

  it("serves an allowlisted SVG with its content type", async () => {
    const read = vi
      .fn()
      .mockResolvedValue({ bytes: new Uint8Array([1]), contentType: "image/svg+xml" });
    const server = buildServer(read);

    try {
      const response = await server.inject({ method: "GET", url: `/api/images/${validId}` });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe("image/svg+xml");
    } finally {
      await server.close();
    }
  });

  it("returns 404 for a non-allowlisted content type such as HTML", async () => {
    const read = vi
      .fn()
      .mockResolvedValue({ bytes: new Uint8Array([1]), contentType: "text/html" });
    const server = buildServer(read);

    try {
      const response = await server.inject({ method: "GET", url: `/api/images/${validId}` });

      expect(response.statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("returns 404 for an unknown id", async () => {
    const read = vi.fn().mockResolvedValue(undefined);
    const server = buildServer(read);

    try {
      const response = await server.inject({ method: "GET", url: `/api/images/${validId}` });

      expect(response.statusCode).toBe(404);
      expect(read).toHaveBeenCalledWith(validId);
    } finally {
      await server.close();
    }
  });

  it("returns 404 for an invalid id without touching the store (no path traversal)", async () => {
    const read = vi.fn();
    const server = buildServer(read);

    try {
      const response = await server.inject({ method: "GET", url: "/api/images/not-a-hash" });

      expect(response.statusCode).toBe(404);
      expect(read).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});
