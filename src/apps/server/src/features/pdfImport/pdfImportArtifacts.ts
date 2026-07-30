import type { PdfImageArtifactRef, RangeConversion, StructuredDocItem } from "@whetstone/contracts";

import { hashBytes } from "../../files/sourceFileStore.js";

// Adoption of the worker's rendered-figure artifacts into a trusted, publishable form (#807). The Python
// worker writes each renderable picture as a PNG into the range's artifact directory and emits only a
// manifest ref (path + png + sha256 + byte length + pixel dimensions). This module is the server-side
// gate that decides, per attempt, which of those refs to TRUST onto a canonical figure and which to drop
// back to the #806 unresolved-placeholder path — and treats any integrity mismatch as loud corruption.
//
// The rules (PRODUCT.md "Preserve extractable PDF figures"):
//   - Every ref's file must read, and its bytes must match the manifest EXACTLY (sha256, byte length, and
//     the PNG's own IHDR width/height). A mismatch is `fatal` — a tampered/lost artifact is infra
//     corruption, never a silent drop or a wrong-image serve.
//   - A single artifact over `MAX_ARTIFACT_BYTES` (16 MiB) or one that would push the attempt's adopted
//     total over `MAX_ATTEMPT_ARTIFACT_BYTES` (128 MiB) is OVER-BOUND: its ref is stripped so the picture
//     maps to a #806 placeholder. Over-bound is a normal content outcome, not a failure.
//   - An adopted ref's path is rewritten from the worker-relative name (`fig-0.png`) to the stage-relative
//     path (`<rangeIndex>/fig-0.png`) publication reads it back through.

// The per-picture PNG byte ceiling, in lockstep with MAX_PICTURE_ARTIFACT_BYTES in pdf_to_docling.py. The
// worker already refuses to emit a ref above this; the server re-checks so a hand-forged ref cannot smuggle
// an oversized artifact past the bound.
export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
// The total adopted-artifact byte budget for one import attempt. Once the running total would exceed this,
// every further picture falls back to a #806 placeholder, so a figure-dense document can never make an
// import consume unbounded image storage.
export const MAX_ATTEMPT_ARTIFACT_BYTES = 128 * 1024 * 1024;

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Reads one worker-relative artifact file name (e.g. `fig-0.png`) from this range's artifact directory.
// Injected by the runner so this module stays free of `fs` and testable with an in-memory map.
export type ArtifactReader = (fileName: string) => Promise<Uint8Array>;

export type AdoptRangeArtifactsInput = Readonly<{
  payload: RangeConversion;
  rangeIndex: number;
  // The bytes already adopted by earlier committed ranges of this attempt, so the 128 MiB budget is
  // enforced across the whole attempt (a resume seeds this from the committed ranges).
  adoptedBytesSoFar: number;
  readArtifact: ArtifactReader;
}>;

export type AdoptRangeArtifactsResult =
  | Readonly<{ status: "ok"; payload: RangeConversion; adoptedBytes: number }>
  | Readonly<{ status: "fatal"; detail: string }>;

// Read the PNG's own pixel dimensions from its IHDR chunk, or null when the bytes are not a PNG whose
// header we can read. Adoption uses this to prove the manifest's width/height match the actual image, so a
// ref cannot claim a different size than the bytes it points at.
export function readPngDimensions(
  bytes: Uint8Array
): Readonly<{ width: number; height: number }> | null {
  // 8-byte signature + 4-byte length + "IHDR" + 4-byte width + 4-byte height => need at least 24 bytes.
  if (bytes.byteLength < 24) {
    return null;
  }
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (bytes[index] !== PNG_SIGNATURE[index]) {
      return null;
    }
  }
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) {
    return null; // not the IHDR chunk type
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

// A picture item somewhere in the body tree that carries an artifact ref, kept in document order so the
// per-attempt byte budget is consumed deterministically (earlier pictures win the budget).
type PendingPicture = Readonly<{ item: StructuredDocItem; ref: PdfImageArtifactRef }>;

function collectPictures(items: readonly StructuredDocItem[], into: PendingPicture[]): void {
  for (const item of items) {
    if (item.imageArtifact !== undefined) {
      into.push({ item, ref: item.imageArtifact });
    }
    collectPictures(item.children, into);
  }
}

type Decision = Readonly<{ kind: "adopt"; path: string }> | Readonly<{ kind: "strip" }>;

function rewriteItems(
  items: readonly StructuredDocItem[],
  decisions: ReadonlyMap<StructuredDocItem, Decision>
): StructuredDocItem[] {
  return items.map((item) => {
    const children = rewriteItems(item.children, decisions);
    const decision = decisions.get(item);
    if (decision === undefined) {
      return { ...item, children };
    }
    if (decision.kind === "strip") {
      const { imageArtifact: _dropped, ...rest } = item;
      return { ...rest, children };
    }
    return { ...item, children, imageArtifact: { ...item.imageArtifact!, path: decision.path } };
  });
}

// Validate every rendered-figure artifact this range's payload references against the files on disk, then
// decide per picture whether to ADOPT it (trusted onto the figure, path rewritten to the stage-relative
// form) or STRIP it (over-bound -> #806 placeholder). Returns the adjusted payload and the newly adopted
// byte count, or `fatal` on the first integrity mismatch. Pure except for the injected `readArtifact`.
export async function adoptRangeArtifacts(
  input: AdoptRangeArtifactsInput
): Promise<AdoptRangeArtifactsResult> {
  const pictures: PendingPicture[] = [];
  collectPictures(input.payload.body, pictures);
  if (pictures.length === 0) {
    return { status: "ok", payload: input.payload, adoptedBytes: 0 };
  }

  const decisions = new Map<StructuredDocItem, Decision>();
  let runningTotal = input.adoptedBytesSoFar;
  let newlyAdopted = 0;

  for (const { item, ref } of pictures) {
    let bytes: Uint8Array;
    try {
      bytes = await input.readArtifact(ref.path);
    } catch (cause) {
      return {
        status: "fatal",
        detail: `artifact "${ref.path}" could not be read: ${describe(cause)}`
      };
    }
    if (bytes.byteLength !== ref.byteLength) {
      return {
        status: "fatal",
        detail: `artifact "${ref.path}" is ${bytes.byteLength} bytes, manifest claims ${ref.byteLength}`
      };
    }
    if (hashBytes(bytes) !== ref.sha256) {
      return {
        status: "fatal",
        detail: `artifact "${ref.path}" sha256 does not match its manifest`
      };
    }
    const dimensions = readPngDimensions(bytes);
    if (dimensions === null) {
      return { status: "fatal", detail: `artifact "${ref.path}" is not a readable PNG` };
    }
    if (dimensions.width !== ref.width || dimensions.height !== ref.height) {
      return {
        status: "fatal",
        detail: `artifact "${ref.path}" is ${dimensions.width}x${dimensions.height}, manifest claims ${ref.width}x${ref.height}`
      };
    }

    const overSingle = ref.byteLength > MAX_ARTIFACT_BYTES;
    const overAttempt = runningTotal + ref.byteLength > MAX_ATTEMPT_ARTIFACT_BYTES;
    if (overSingle || overAttempt) {
      decisions.set(item, { kind: "strip" });
      continue;
    }
    runningTotal += ref.byteLength;
    newlyAdopted += ref.byteLength;
    decisions.set(item, { kind: "adopt", path: `${input.rangeIndex}/${ref.path}` });
  }

  const adjusted: RangeConversion = {
    ...input.payload,
    body: rewriteItems(input.payload.body, decisions)
  };
  return { status: "ok", payload: adjusted, adoptedBytes: newlyAdopted };
}

// Sum the adopted-artifact byte lengths across already-committed ranges, so a resumed attempt seeds its
// 128 MiB budget from what earlier ranges already adopted (their payloads keep only adopted refs).
export function sumAdoptedArtifactBytes(ranges: readonly RangeConversion[]): number {
  let total = 0;
  const add = (items: readonly StructuredDocItem[]): void => {
    for (const item of items) {
      if (item.imageArtifact !== undefined) {
        total += item.imageArtifact.byteLength;
      }
      add(item.children);
    }
  };
  for (const range of ranges) {
    add(range.body);
  }
  return total;
}

// The adopted (path-rewritten) artifacts of one range's adjusted payload, so publication knows exactly
// which PNGs to read back from the stage and store. Only adopted refs remain on the payload; stripped ones
// were removed, so this is precisely the set to persist.
export type AdoptedArtifact = Readonly<{ path: string; sha256: string; byteLength: number }>;

export function collectAdoptedArtifacts(document: {
  readonly body: readonly StructuredDocItem[];
}): readonly AdoptedArtifact[] {
  const adopted: AdoptedArtifact[] = [];
  const walk = (items: readonly StructuredDocItem[]): void => {
    for (const item of items) {
      if (item.imageArtifact !== undefined) {
        adopted.push({
          path: item.imageArtifact.path,
          sha256: item.imageArtifact.sha256,
          byteLength: item.imageArtifact.byteLength
        });
      }
      walk(item.children);
    }
  };
  walk(document.body);
  return adopted;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
