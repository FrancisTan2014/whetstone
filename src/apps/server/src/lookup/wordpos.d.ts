// Minimal ambient declaration for the untyped, MIT-licensed `wordpos` package (WordNet via `wordnet-db`).
//
// The English-lookup composer (#642 lineage) uses only the async `lookup`, reading each synset's `pos`,
// `def`, `exp`, and `synonyms` defensively. The offline lexical-relationship service (#715) additionally
// consumes `seek(offset, pos)` to resolve one pointer's target synset, plus the raw `synsetOffset` and
// `ptrs` fields on a synset (pointer symbol, target offset/pos, and the source/target word indices). Every
// field stays typed loosely — the WordNet files are untrusted at this boundary, so the adapters narrow each
// value with the shared `jsonValue` guards before use.
declare module "wordpos" {
  export type WordNetPointerRecord = {
    pointerSymbol?: unknown;
    synsetOffset?: unknown;
    pos?: unknown;
    sourceTarget?: unknown;
  };

  export type WordNetDataRecord = {
    synsetOffset?: unknown;
    pos?: unknown;
    lemma?: unknown;
    synonyms?: unknown;
    def?: unknown;
    exp?: unknown;
    ptrs?: unknown;
  };

  export default class WordPOS {
    constructor(options?: Record<string, unknown>);
    lookup(word: string): Promise<ReadonlyArray<WordNetDataRecord>>;
    seek(offset: string, pos: string): Promise<WordNetDataRecord>;
  }
}
