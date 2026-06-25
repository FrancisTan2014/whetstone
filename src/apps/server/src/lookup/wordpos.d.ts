// Minimal ambient declaration for the untyped, MIT-licensed `wordpos` package (WordNet via
// `wordnet-db`). We use only the async `lookup`, which resolves to the matched synsets; the
// composer reads each synset's `pos`, `def`, `exp`, and `synonyms` defensively.
declare module "wordpos" {
  export default class WordPOS {
    constructor(options?: Record<string, unknown>);
    lookup(word: string): Promise<ReadonlyArray<unknown>>;
  }
}
