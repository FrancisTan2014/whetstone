import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

import { hashBytes, resolveWithinDirectory } from "./sourceFileStore.js";

// The image types the reader may store and serve. Raster types are stored as-is; SVG is allowed only
// because every SVG is sanitized at ingest (scripts/handlers/external refs stripped) before it enters
// the store. This allowlist is the security boundary for image bytes that originate from untrusted
// EPUB content; any other type is rejected.
export const imageContentTypeAllowlist = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml"
] as const;

export type ImageContentType = (typeof imageContentTypeAllowlist)[number];

export function isAllowedImageContentType(contentType: string): contentType is ImageContentType {
  return (imageContentTypeAllowlist as ReadonlyArray<string>).includes(contentType);
}

// An image resource id is the sha256 hex digest of its bytes: a 64-char lowercase hex string.
// Validating an incoming id against this shape before any filesystem access means a request id
// can never be a path segment that traverses out of the store directory.
const imageResourceIdPattern = /^[a-f0-9]{64}$/;

export function isImageResourceId(id: string): boolean {
  return imageResourceIdPattern.test(id);
}

export type StoreImageInput = Readonly<{ bytes: Uint8Array; contentType: string }>;

export type StoredImageResource = Readonly<{ id: string }>;

export type ImageResource = Readonly<{ bytes: Uint8Array; contentType: string }>;

// The image-resource boundary: store image bytes once (content-addressed, so identical bytes
// share one id and one file) and read them back. Injected like other infra so consumers test
// against a fake with no disk I/O.
export type ImageResourceStore = Readonly<{
  read: (id: string) => Promise<ImageResource | undefined>;
  store: (input: StoreImageInput) => Promise<StoredImageResource>;
}>;

async function writeAtomic(path: string, data: Uint8Array | string): Promise<void> {
  const tempPath = `${path}.tmp`;
  await writeFile(tempPath, data);
  await rename(tempPath, path);
}

async function readOptional(path: string): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await readFile(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

// Filesystem-backed image store. Bytes live at `{dir}/{sha256}` and the recorded content type at
// the sidecar `{dir}/{sha256}.type`. Disallowed content types are refused at write time; SVG is
// allowed but must be sanitized by the caller (figureImageResolver) before reaching the store. Reads
// return undefined for any missing or unreadable resource so the serving endpoint maps them to 404.
export function createImageResourceStore(directory: string): ImageResourceStore {
  function bytesPath(id: string): string {
    return resolveWithinDirectory(directory, id);
  }

  function typePath(id: string): string {
    return resolveWithinDirectory(directory, `${id}.type`);
  }

  async function store(input: StoreImageInput): Promise<StoredImageResource> {
    if (!isAllowedImageContentType(input.contentType)) {
      throw new Error(`Unsupported image content type: ${input.contentType}`);
    }

    const id = hashBytes(input.bytes);
    await mkdir(directory, { recursive: true });
    await writeAtomic(bytesPath(id), input.bytes);
    await writeAtomic(typePath(id), input.contentType);

    return Object.freeze({ id });
  }

  async function read(id: string): Promise<ImageResource | undefined> {
    if (!isImageResourceId(id)) {
      return undefined;
    }

    const bytes = await readOptional(bytesPath(id));

    if (bytes === undefined) {
      return undefined;
    }

    const recordedType = await readOptional(typePath(id));

    if (recordedType === undefined) {
      return undefined;
    }

    return Object.freeze({ bytes, contentType: new TextDecoder().decode(recordedType) });
  }

  return Object.freeze({ read, store });
}
