import { createHash } from "node:crypto";

import { projectNoteMaterial } from "@whetstone/document";

// The server-side SHA-256 fingerprint of a Note's exact material (#711). The canonical semantic
// projection lives in the browser-safe `@whetstone/document` package; only the hash is derived here,
// so the document package imports no Node APIs. The fingerprint is DELIBERATELY only a lookup
// accelerator — never product identity — so callers must always confirm a candidate with full
// projected-value equality (`projectNoteMaterial`), because a SHA-256 collision, while astronomically
// unlikely, must never be trusted as a match.

// The SHA-256 (lowercase hex) of an already-computed canonical projection string. Split from the
// document-composing helper so the owner-scoped query can hash the projection it already holds without
// projecting twice.
export function fingerprintFromProjection(projection: string): string {
  return createHash("sha256").update(projection, "utf8").digest("hex");
}

// Project a validated Note body to its canonical material, then fingerprint it. Throws the projection's
// own `DocumentValidationError` (invalid document or unsafe link) or `BlankNoteMaterialError` (a
// body-bearing note that carries no material) BEFORE any hash is derived, so an unrepresentable body
// aborts the write/backfill loudly rather than minting a fingerprint over nothing.
export function fingerprintNoteMaterial(bodyDoc: unknown): string {
  return fingerprintFromProjection(projectNoteMaterial(bodyDoc));
}
