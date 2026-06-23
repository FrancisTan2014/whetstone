// EPUB OPF metadata is structurally typed here (not imported from the parser) so the
// domain stays decoupled from the ingestion library. Only the fields v0 needs are read.
export type RawEpubCreator = Readonly<{ contributor?: string }>;

export type RawEpubMetadata = Readonly<{
  creator?: ReadonlyArray<RawEpubCreator>;
  language?: string;
  title?: string;
}>;

// Normalized work metadata used to create a Work from an EPUB. Missing or blank OPF
// fields fall back to explicit placeholders rather than producing empty work rows.
export type NormalizedEpubMetadata = Readonly<{
  author: string;
  language: string;
  title: string;
}>;

const fallbackTitle = "Untitled work";
const fallbackAuthor = "Unknown author";
const fallbackLanguage = "und";

function blankToFallback(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();

  return trimmed !== undefined && trimmed.length > 0 ? trimmed : fallback;
}

function firstNamedCreator(creators: ReadonlyArray<RawEpubCreator> | undefined): string {
  for (const creator of creators ?? []) {
    const trimmed = creator.contributor?.trim();

    if (trimmed !== undefined && trimmed.length > 0) {
      return trimmed;
    }
  }

  return fallbackAuthor;
}

export function normalizeEpubMetadata(raw: RawEpubMetadata): NormalizedEpubMetadata {
  return Object.freeze({
    author: firstNamedCreator(raw.creator),
    language: blankToFallback(raw.language, fallbackLanguage),
    title: blankToFallback(raw.title, fallbackTitle)
  });
}
