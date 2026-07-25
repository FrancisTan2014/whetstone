// The pinned `damerau-levenshtein@1.0.8` package ships no types. The near-Note matcher (#713) reaches it
// through one pure adapter (`nearMatchScore.ts`), so this ambient declaration describes only the single
// default export that adapter uses: a function returning the edit `steps` (Damerau-Levenshtein distance,
// including adjacent transpositions) plus the library's own normalized ratios, which the adapter ignores in
// favour of its own code-point denominator.
declare module "damerau-levenshtein" {
  export default function levenshtein(
    source: string,
    target: string
  ): { steps: number; relative: number; similarity: number };
}
