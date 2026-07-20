// A Work's origin explicitly owns its content authority and editing policy (#695). Provenance rows say
// where material came from and ownership rows say whose chronology it belongs to; neither may double as
// a hidden Work type. Origin is the single, required discriminator every creation, query, and write path
// reads to enforce the right lifecycle:
//   - `imported`: externally sourced EPUB/PDF/Markdown, managed by replacement/re-ingestion;
//   - `manual`:   learner-curated source material, edited from the Library;
//   - `authored`: the learner's own writing, edited from Writing.
// Origin is orthogonal to Work type: an imported essay and an authored essay share the `essay` type but
// differ in origin. This lives in `domain` so schema, contracts, server, and client share one definition
// instead of scattering string literals.
export const workOrigins = ["imported", "manual", "authored"] as const;

export type WorkOrigin = (typeof workOrigins)[number];

const workOriginSet: ReadonlySet<unknown> = new Set(workOrigins);

export function isWorkOrigin(value: unknown): value is WorkOrigin {
  return workOriginSet.has(value);
}

// The origins a learner may create directly from the Library: manual metadata, or an imported upload
// shell that ingestion later fills. `authored` is deliberately excluded — an owned Work is minted only by
// the Writing path (which also stamps its ownership facet), so the generic works endpoint can never be
// used to forge an owned Work by asking for `authored`.
export const libraryCreateOrigins = ["imported", "manual"] as const;

export type LibraryCreateOrigin = (typeof libraryCreateOrigins)[number];

const libraryCreateOriginSet: ReadonlySet<unknown> = new Set(libraryCreateOrigins);

export function isLibraryCreateOrigin(value: unknown): value is LibraryCreateOrigin {
  return libraryCreateOriginSet.has(value);
}
