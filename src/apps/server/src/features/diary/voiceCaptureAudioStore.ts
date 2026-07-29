import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { Readable } from "node:stream";

import { resolveWithinDirectory } from "../../files/sourceFileStore.js";

// The retained recording behind a voice diary entry, streamed to the owned-entry audio endpoint (#801)
// with HTTP range support so the browser's native player can seek. The stored path stays server-side —
// resolved WITHIN the voice-capture root so a tampered/legacy path can never escape it — and the reader
// exposes only the byte size and a bounded stream, never the path.

// An inclusive byte range within the recording (`start..end`, both 0-based).
export type AudioByteRange = Readonly<{ end: number; start: number }>;

// How a `Range` header resolves against a known file size: serve the whole file, one satisfiable range,
// or reject as unsatisfiable (416). A malformed or absent header falls back to `full`, per HTTP: an
// unparseable range is ignored, not an error.
export type ParsedAudioRange =
  | Readonly<{ kind: "full" }>
  | Readonly<{ kind: "range"; range: AudioByteRange }>
  | Readonly<{ kind: "unsatisfiable" }>;

// A single-range `bytes=` header: `bytes=<start>-<end>`, `bytes=<start>-`, or `bytes=-<suffix>`. A
// multi-range or otherwise malformed value does not match and is treated as no range (full).
const singleRangePattern = /^bytes=(\d*)-(\d*)$/;

// Resolve a `Range` request header against the recording's byte size. Supports the three single-range
// forms the native `<audio>` element issues while seeking; anything else (absent, multi-range, malformed)
// serves the whole file. A start past the last byte, an empty file, or a zero-length suffix is
// unsatisfiable so the endpoint answers 416 rather than streaming an empty or wrong body.
export function parseAudioRange(header: string | undefined, size: number): ParsedAudioRange {
  if (header === undefined) {
    return { kind: "full" };
  }
  const match = singleRangePattern.exec(header.trim());
  if (match === null) {
    return { kind: "full" };
  }
  const startText = match[1];
  const endText = match[2];
  if (startText === "" && endText === "") {
    return { kind: "full" };
  }

  if (startText === "") {
    const suffix = Number(endText);
    if (suffix === 0 || size === 0) {
      return { kind: "unsatisfiable" };
    }
    return { kind: "range", range: { end: size - 1, start: Math.max(0, size - suffix) } };
  }

  const start = Number(startText);
  if (start >= size) {
    return { kind: "unsatisfiable" };
  }
  const end = endText === "" ? size - 1 : Math.min(Number(endText), size - 1);
  if (end < start) {
    return { kind: "unsatisfiable" };
  }
  return { kind: "range", range: { end, start } };
}

// An opened recording: its total byte size, plus a reader for the whole file (`read(null)`) or one
// inclusive byte range (`read(range)`), backed by a bounded file stream.
export type OpenedAudio = Readonly<{
  read: (range: AudioByteRange | null) => Readable;
  size: number;
}>;

export type VoiceCaptureAudioStore = Readonly<{
  // Open a retained recording by its stored server-side path, or null when the path escapes the
  // voice-capture root or the file is missing — both answered as 404, never a stream or a leaked path.
  open: (storedPath: string) => Promise<OpenedAudio | null>;
}>;

// A voice-capture audio store rooted at the directory recordings are saved under, so a stored path is
// always confined to that root (defense-in-depth even though the path is server-generated).
export function createVoiceCaptureAudioStore(rootDir: string): VoiceCaptureAudioStore {
  async function open(storedPath: string): Promise<OpenedAudio | null> {
    let target: string;
    try {
      target = resolveWithinDirectory(rootDir, storedPath);
    } catch {
      return null;
    }

    let size: number;
    try {
      const stats = await stat(target);
      if (!stats.isFile()) {
        return null;
      }
      size = stats.size;
    } catch {
      return null;
    }

    return Object.freeze({
      read: (range: AudioByteRange | null): Readable =>
        range === null
          ? createReadStream(target)
          : createReadStream(target, { end: range.end, start: range.start }),
      size
    });
  }

  return Object.freeze({ open });
}
