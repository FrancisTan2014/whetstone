// Minimal ambient declaration for the untyped, MIT-licensed `wink-lemmatizer` package (#715). We consume only
// the three rule-based lemmatizers it exposes; WordNet supplies adverbs by surface lookup (wink has none).
declare module "wink-lemmatizer" {
  const lemmatizer: {
    noun(word: string): string;
    verb(word: string): string;
    adjective(word: string): string;
  };
  export default lemmatizer;
}
