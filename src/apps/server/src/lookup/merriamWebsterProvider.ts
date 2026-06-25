import type { NormalizedEntry, NormalizedSense } from "@whetstone/contracts";

import type { DictionaryProvider } from "./dictionaryProvider.types.js";
import type { HttpClient } from "./httpClient.js";
import { asArray, asString, field, isRecord } from "./jsonValue.js";

// The two Merriam-Webster references share ONE wire shape, so one adapter/provider serves
// both; only the reference path segment and key differ.
export type MerriamWebsterReference = "learners" | "collegiate";

// Each reference requires its own attribution wherever its data is shown; the service
// surfaces the matching one on the response so the reader can render it.
export const merriamWebsterAttributions: Readonly<Record<MerriamWebsterReference, string>> = {
  collegiate: "Definitions from Merriam-Webster's Collegiate Dictionary (merriam-webster.com).",
  learners: "Definitions from Merriam-Webster's Learner's Dictionary (learnersdictionary.com)."
};

// A higher cap keeps multi-part-of-speech and homograph entries reasonably complete; the
// reader groups senses by part of speech and the popover scrolls when results run long.
const maxSenses = 12;

// MW marks syllable breaks in the headword with `*` (e.g. "vo*lu*mi*nous"); strip them.
function cleanHeadword(value: string): string {
  return value.replace(/\*/g, "");
}

// MW wraps run-in text in formatting tokens like `{it}word{/it}` or `{bc}`; drop them.
function stripTokens(value: string): string {
  return value.replace(/\{[^}]*\}/g, "").trim();
}

function buildSense(
  gloss: string,
  partOfSpeech: string | undefined,
  example: string | undefined
): NormalizedSense {
  return {
    gloss,
    ...(partOfSpeech === undefined ? {} : { partOfSpeech }),
    ...(example === undefined ? {} : { example })
  };
}

// The first verbal illustration (`vis`) text within a sense's `dt`, if any.
function firstExample(dt: unknown): string | undefined {
  for (const item of asArray(dt)) {
    const parts = asArray(item);

    if (asString(parts[0]) !== "vis") {
      continue;
    }

    for (const illustration of asArray(parts[1])) {
      const text = asString(field(illustration, "t"));

      if (text !== undefined) {
        return stripTokens(text);
      }
    }
  }

  return undefined;
}

// Examples in sense order, walking `def[].sseq[][]` and taking each `["sense", …]` tuple's
// first `vis`; entries align positionally with `shortdef`.
function collectExamples(def: unknown): ReadonlyArray<string | undefined> {
  const examples: Array<string | undefined> = [];

  for (const defBlock of asArray(def)) {
    for (const senseGroup of asArray(field(defBlock, "sseq"))) {
      for (const tuple of asArray(senseGroup)) {
        const parts = asArray(tuple);

        if (asString(parts[0]) !== "sense") {
          continue;
        }

        examples.push(firstExample(field(parts[1], "dt")));
      }
    }
  }

  return examples;
}

function pronunciationOf(headwordInfo: unknown): string | undefined {
  return asString(field(asArray(field(headwordInfo, "prs"))[0], "mw"));
}

// The cleaned headword of one MW record, or undefined when it has none (e.g. a suggestion
// string rather than an entry object).
function headwordOf(record: unknown): string | undefined {
  const headword = asString(field(field(record, "hwi"), "hw"));
  return headword === undefined ? undefined : cleanHeadword(headword);
}

// Every short definition of one record as senses, each tagged with that record's functional
// label (part of speech) and aligned positional example.
function sensesOfRecord(record: unknown): ReadonlyArray<NormalizedSense> {
  const partOfSpeech = asString(field(record, "fl"));
  const examples = collectExamples(field(record, "def"));
  const senses: NormalizedSense[] = [];

  asArray(field(record, "shortdef")).forEach((shortdef, index) => {
    const gloss = asString(shortdef);

    if (gloss !== undefined) {
      senses.push(buildSense(gloss, partOfSpeech, examples[index]));
    }
  });

  return senses;
}

// Pure adapter: normalizes MW's verbose JSON into a capped NormalizedEntry, or null when
// there is no usable definition (no match, a suggestion list of bare strings, missing
// headword, or empty short definitions). MW returns one record per part of speech / homograph
// for the same word, so we merge the senses of every record that shares the primary
// headword (the first record's) instead of keeping only the first — that recovers the other
// parts of speech. The headword and pronunciation come from that primary record.
export function adaptMerriamWebster(payload: unknown): NormalizedEntry | null {
  const records = asArray(payload).filter(isRecord);
  const senses: NormalizedSense[] = [];
  let headword: string | undefined;
  let pronunciation: string | undefined;

  for (const record of records) {
    const recordHeadword = headwordOf(record);

    if (recordHeadword === undefined) {
      continue;
    }

    if (headword === undefined) {
      headword = recordHeadword;
      pronunciation = pronunciationOf(field(record, "hwi"));
    }

    if (recordHeadword.toLowerCase() === headword.toLowerCase()) {
      senses.push(...sensesOfRecord(record));
    }
  }

  if (headword === undefined || senses.length === 0) {
    return null;
  }

  return {
    headword,
    senses: senses.slice(0, maxSenses),
    ...(pronunciation === undefined ? {} : { pronunciation })
  };
}

export type MerriamWebsterProviderDependencies = Readonly<{
  apiKey: string;
  httpClient: HttpClient;
  reference: MerriamWebsterReference;
}>;

function buildUrl(reference: MerriamWebsterReference, term: string, apiKey: string): string {
  const encodedTerm = encodeURIComponent(term);
  return `https://www.dictionaryapi.com/api/v3/references/${reference}/json/${encodedTerm}?key=${encodeURIComponent(
    apiKey
  )}`;
}

// One MW provider parameterized by reference + key. Resolves to null on any transport/HTTP
// error or no-match so the service can fall through to the next provider in the chain.
export function createMerriamWebsterProvider(
  dependencies: MerriamWebsterProviderDependencies
): DictionaryProvider {
  async function lookup(term: string): Promise<NormalizedEntry | null> {
    const result = await dependencies.httpClient.getJson<unknown>(
      buildUrl(dependencies.reference, term, dependencies.apiKey)
    );

    if (!result.ok) {
      return null;
    }

    return adaptMerriamWebster(result.value);
  }

  return Object.freeze({ lookup });
}
