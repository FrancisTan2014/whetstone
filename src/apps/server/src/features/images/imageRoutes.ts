import type { FastifyInstance } from "fastify";

import {
  isAllowedImageContentType,
  isImageResourceId,
  type ImageResourceStore
} from "../../files/imageResourceStore.js";

const notFoundBody = { error: "not_found" } as const;

export type ImageDependencies = Readonly<{
  imageResourceStore: Pick<ImageResourceStore, "read">;
}>;

// Read-only image serving. The id is a content hash, validated before the store touches the
// filesystem, so there is no path traversal and no remote fetch — only a previously stored
// resource can be served. The recorded content type is re-checked against the allowlist at the
// boundary, so SVG (or any non-raster type) is refused even if it somehow reached the store. An
// invalid id, an unknown id, and a non-allowlisted type all return 404 so the endpoint never
// reveals or serves anything outside the boundary. Content-addressed bytes are immutable, so the
// response is safely cacheable forever.
export function registerImageRoutes(
  server: FastifyInstance,
  dependencies: ImageDependencies
): void {
  server.get("/api/images/:id", async (request, reply) => {
    const { id } = request.params as { id: string };

    if (!isImageResourceId(id)) {
      return reply.code(404).send(notFoundBody);
    }

    const resource = await dependencies.imageResourceStore.read(id);

    if (resource === undefined || !isAllowedImageContentType(resource.contentType)) {
      return reply.code(404).send(notFoundBody);
    }

    return reply
      .code(200)
      .header("content-type", resource.contentType)
      .header("cache-control", "public, max-age=31536000, immutable")
      .send(Buffer.from(resource.bytes));
  });
}
