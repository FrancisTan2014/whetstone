// ZIP signatures. An EPUB is a ZIP whose first entry (the uncompressed `mimetype` file) makes it
// begin with a local file header; the archive ends with an end-of-central-directory (EOCD) record.
const localFileHeader = [0x50, 0x4b, 0x03, 0x04] as const;
const eocdSignature = [0x50, 0x4b, 0x05, 0x06] as const;

// The EOCD record is 22 bytes plus an optional trailing comment of up to 0xffff bytes, so it begins
// no earlier than this many bytes from the end of a valid archive.
const eocdMinSize = 22;
const maxCommentLength = 0xffff;

// Whether `signature` appears at `offset`. An out-of-range index reads `undefined`, which never
// equals a signature byte, so no explicit bounds guard is needed.
function matchesAt(bytes: Uint8Array, signature: ReadonlyArray<number>, offset: number): boolean {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

// Whether the bytes are a structurally complete ZIP archive (EPUBs are ZIPs): a leading local file
// header plus an end-of-central-directory record near the end. The EPUB library hangs (its returned
// promise never settles) and emits a process-crashing unhandled rejection when handed non-ZIP input,
// so the parser must reject such uploads before handing them over.
export function isZipArchive(bytes: Uint8Array): boolean {
  if (bytes.length < eocdMinSize || !matchesAt(bytes, localFileHeader, 0)) {
    return false;
  }

  const earliestEocd = Math.max(0, bytes.length - eocdMinSize - maxCommentLength);

  for (let offset = bytes.length - eocdMinSize; offset >= earliestEocd; offset -= 1) {
    if (matchesAt(bytes, eocdSignature, offset)) {
      return true;
    }
  }

  return false;
}
