// Ambient types for the pinned `talisman` Damerau-Levenshtein metric (#724). Talisman ships no type
// declarations and has no `@types` package, so declare only the single deep module the domain adapter
// imports. The metric computes the exact Damerau-Levenshtein (optimal string alignment) distance between
// two equal-typed sequences; passing code-point arrays makes each character count as one edit.
declare module "talisman/metrics/damerau-levenshtein" {
  export default function damerauLevenshtein(a: ArrayLike<unknown>, b: ArrayLike<unknown>): number;
}
