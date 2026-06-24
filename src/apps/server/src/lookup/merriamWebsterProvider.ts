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

// A few concise senses keep the popover scannable.
const maxSenses = 3;

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

// Pure adapter: normalizes MW's verbose JSON into a capped NormalizedEntry, or null when
// there is no usable definition (no match, a suggestion list of bare strings, missing
// headword, or empty short definitions). A no-match response is an array of suggestion
// strings, so the first record element is the entry.
export function adaptMerriamWebster(payload: unknown): NormalizedEntry | null {
  const entry = asArray(payload).find(isRecord);

  if (entry === undefined) {
    return null;
  }

  const headwordInfo = field(entry, "hwi");
  const headword = asString(field(headwordInfo, "hw"));

  if (headword === undefined) {
    return null;
  }

  const partOfSpeech = asString(field(entry, "fl"));
  const examples = collectExamples(field(entry, "def"));
  const senses: NormalizedSense[] = [];

  asArray(field(entry, "shortdef")).forEach((shortdef, index) => {
    const gloss = asString(shortdef);

    if (gloss !== undefined) {
      senses.push(buildSense(gloss, partOfSpeech, examples[index]));
    }
  });

  if (senses.length === 0) {
    return null;
  }

  const pronunciation = pronunciationOf(headwordInfo);

  return {
    headword: cleanHeadword(headword),
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
