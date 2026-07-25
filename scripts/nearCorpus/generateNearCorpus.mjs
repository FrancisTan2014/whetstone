// Deterministic generator for the #713 near-Note gold corpus `fixtures/card-matching/near-v1.jsonl`.
//
// The file holds two clearly-separated groups, each row tagged with its `split`:
//   - `calibration` rows come from the documented MUTATION RULES below (character typos over the longest
//     word, renderer-glyph variants, and templated protected/case/lexical negatives + unsupported material).
//     The threshold and guards are reviewed only against these.
//   - `holdout` rows are HAND-AUTHORED literals in `buildHoldout()` — curated real-world misspellings and
//     distinct word pairs, plus every named test-matrix example — NOT produced by the calibration mutation
//     functions, so the holdout gates cannot be tuned against. See the header comment there.
//
// Every pair is labelled BY CONSTRUCTION (a one-character typo in a long word is `possible`; a changed number
// is `distinct`; a single word is `unsupported`); the generator never consults the matcher, so the corpus is
// independent ground truth. `near-v1.meta.json` pins the normalizer/scorer versions the labels assume. The
// consuming gate test then asserts the real matcher agrees with every label and measures the holdout gates.
// Run: `node scripts/nearCorpus/generateNearCorpus.mjs`.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const OUT = fileURLToPath(new URL("../../fixtures/card-matching/near-v1.jsonl", import.meta.url));

// --- document builders -------------------------------------------------------------------------------

const proseDoc = (text) => ({ content: [{ content: [{ text, type: "text" }], type: "paragraph" }], type: "doc" });
const markedDoc = (before, marked, mark, after) => ({
  content: [
    {
      content: [
        { text: before, type: "text" },
        { marks: [mark], text: marked, type: "text" },
        { text: after, type: "text" }
      ],
      type: "paragraph"
    }
  ],
  type: "doc"
});
const headingDoc = (text) => ({
  content: [{ attrs: { level: 1 }, content: [{ text, type: "text" }], type: "heading" }],
  type: "doc"
});
const listDoc = (text) => ({
  content: [
    { content: [{ content: [{ content: [{ text, type: "text" }], type: "paragraph" }], type: "listItem" }], type: "bulletList" }
  ],
  type: "doc"
});

// --- string mutation helpers (character edits over the LONGEST word) ----------------------------------

const longestWordIndex = (words) => {
  let best = 0;
  for (let i = 1; i < words.length; i += 1) {
    if (words[i].length > words[best].length) {
      best = i;
    }
  }
  return best;
};
const replaceWord = (text, index, next) => {
  const words = text.split(" ");
  words[index] = next;
  return words.join(" ");
};
const substitute = (word) => {
  const at = Math.floor(word.length / 2);
  const swap = word[at] === "e" ? "a" : "e";
  return word.slice(0, at) + swap + word.slice(at + 1);
};
const deleteChar = (word) => word.slice(0, 2) + word.slice(3);
const insertChar = (word) => word.slice(0, 2) + "l" + word.slice(2);
const transpose = (word) => {
  const at = Math.floor(word.length / 2);
  return word.slice(0, at) + word[at + 1] + word[at] + word.slice(at + 2);
};

const rows = [];
const push = (row) => rows.push(row);
let seq = 0;
const nextId = (prefix) => `${prefix}-${String((seq += 1)).padStart(3, "0")}`;

// --- calibration positives: character typos across 2-, 5-, and 20-token material ----------------------

const bases2 = [
  "clear boundary",
  "silent harbor",
  "gentle stream",
  "bright morning",
  "distant thunder",
  "narrow hallway",
  "hidden meadow",
  "frozen mountain",
  "quiet library",
  "golden feather",
  "purple curtain",
  "steady heartbeat",
  "wooden bridge",
  "sudden whisper"
];
const bases5 = [
  "the system stays fully available",
  "we replicate the write quickly",
  "leaders commit entries in order",
  "the parser reads each token",
  "readers observe the latest value",
  "the cache holds recent answers",
  "the network drops some packets",
  "the schedule allows enough slack",
  "the compiler rejects broken syntax",
  "the service restarts after failure",
  "the cluster elects a leader",
  "the buffer flushes every second"
];
const twentyBase = (seed) =>
  [
    "the",
    "distributed",
    "system",
    "replicates",
    "every",
    "committed",
    "write",
    "toward",
    "a",
    "healthy",
    "quorum",
    "before",
    "the",
    "coordinator",
    seed,
    "acknowledges",
    "the",
    "waiting",
    "client",
    "safely"
  ].join(" ");
const bases20 = ["finally", "promptly", "clearly", "plainly", "quietly", "firmly", "surely", "wisely"].map(
  twentyBase
);

const positiveMutators = [
  ["substitution", substitute],
  ["deletion", deleteChar],
  ["insertion", insertChar],
  ["transposition", transpose]
];

for (const [size, bases] of [
  ["2-token", bases2],
  ["5-token", bases5],
  ["20-token", bases20]
]) {
  for (const base of bases) {
    const words = base.split(" ");
    const index = longestWordIndex(words);
    for (const [family, mutate] of positiveMutators) {
      const variant = replaceWord(base, index, mutate(words[index]));
      if (variant === base) {
        continue;
      }
      push({
        category: `positive-${family}`,
        docA: proseDoc(base),
        docB: proseDoc(variant),
        eligibility: "both",
        expected: "possible",
        family,
        id: nextId("cal-pos"),
        protectedEvidence: [],
        rationale: `A ${family} typo in one long word of ${size} material reads as the same wording.`,
        split: "calibration"
      });
    }
  }
}

for (const base of [...bases5, ...bases20]) {
  const words = base.split(" ");
  const longWords = words.map((word, index) => [word, index]).filter(([word]) => word.length >= 5);
  if (longWords.length < 2) {
    continue;
  }
  let variant = base;
  for (const [word, index] of longWords.slice(0, 2)) {
    variant = replaceWord(variant, index, substitute(word));
  }
  push({
    category: "positive-two-edit",
    docA: proseDoc(base),
    docB: proseDoc(variant),
    eligibility: "both",
    expected: "possible",
    family: "two-edit",
    id: nextId("cal-pos"),
    protectedEvidence: [],
    rationale: "Two typo-scale substitutions across long words stay the same wording.",
    split: "calibration"
  });
}

// Renderer-glyph positives. Hyphen/space differs in token count (guard defers to the whole-key score); the
// quote/apostrophe/dash pairs carry the SAME normalized mark on both sides and differ only by glyph, so their
// relaxed keys are identical (score 1.0) while the exact-material projection still differs.
const rendererPairs = [
  ["the plan is well known now", "the plan is well-known now", "spacing"],
  ["a short but well known idea", "a short but well-known idea", "spacing"],
  ["we prefer a long term plan", "we prefer a long-term plan", "spacing"],
  ['she said "yes" to the plan', "she said \u201Cyes\u201D to the plan", "quote"],
  ["we called it a 'soft' launch", "we called it a \u2018soft\u2019 launch", "quote"],
  ["it's a perfectly fine idea", "it\u2019s a perfectly fine idea", "apostrophe"],
  ["take a pause - then resume", "take a pause \u2014 then resume", "dash"],
  ["a well - formed request here", "a well \u2013 formed request here", "dash"],
  ["we ship the alpha - beta build", "we ship the alpha \u2013 beta build", "dash"]
];
for (const [a, b, family] of rendererPairs) {
  push({
    category: `positive-${family}`,
    docA: proseDoc(a),
    docB: proseDoc(b),
    eligibility: "both",
    expected: "possible",
    family,
    id: nextId("cal-pos"),
    protectedEvidence: [],
    rationale: `Renderer-equivalent ${family} glyphs read as the same material.`,
    split: "calibration"
  });
}

// --- calibration negatives -----------------------------------------------------------------------------

const numberCarriers = [
  "we store up to N files here",
  "the timeout is N seconds now",
  "the queue holds N items today",
  "we retry the call N times here",
  "the buffer is N bytes wide now",
  "the limit is N requests today",
  "we allocate N workers per host",
  "the batch contains N records now",
  "the shard keeps N replicas here",
  "we page through N rows today"
];
const numberPairs = [
  ["100", "200"],
  ["30", "60"],
  ["5", "50"],
  ["12", "24"],
  ["7", "70"],
  ["256", "512"]
];
for (const carrier of numberCarriers) {
  for (const [x, y] of numberPairs) {
    push({
      category: "negative-number",
      docA: proseDoc(carrier.replace("N", x)),
      docB: proseDoc(carrier.replace("N", y)),
      eligibility: "both",
      expected: "distinct",
      family: "protected-number",
      id: nextId("cal-neg"),
      protectedEvidence: ["number"],
      rationale: "A changed number is protected evidence and vetoes the pair.",
      split: "calibration"
    });
  }
}

const percentPairs = [
  ["we keep about 20 percent free", "we keep about 70 percent free"],
  ["only 15 percent of runs failed", "only 45 percent of runs failed"],
  ["nearly 90 percent are cached now", "nearly 40 percent are cached now"],
  ["about 5 percent remained idle", "about 55 percent remained idle"],
  ["roughly 33 percent were slow", "roughly 66 percent were slow"],
  ["some 25 percent were retried", "some 75 percent were retried"],
  ["over 60 percent were durable", "over 30 percent were durable"],
  ["under 10 percent were stale", "under 80 percent were stale"],
  ["exactly 50 percent were fresh", "exactly 95 percent were fresh"],
  ["barely 2 percent were dropped", "barely 22 percent were dropped"],
  ["close to 12 percent were lost", "close to 62 percent were lost"],
  ["almost 88 percent were kept now", "almost 18 percent were kept now"]
];
for (const [a, b] of percentPairs) {
  push({
    category: "negative-percent",
    docA: proseDoc(a),
    docB: proseDoc(b),
    eligibility: "both",
    expected: "distinct",
    family: "protected-number",
    id: nextId("cal-neg"),
    protectedEvidence: ["number"],
    rationale: "A changed percentage is protected evidence and vetoes the pair.",
    split: "calibration"
  });
}

const versionPairs = [
  ["release the 1.2 build today", "release the 1.3 build today"],
  ["we shipped version 4 last week", "we shipped version 7 last week"],
  ["the api reached v2 this month", "the api reached v5 this month"],
  ["upgrade to the 2.0 release now", "upgrade to the 3.0 release now"],
  ["we pinned the 6.1 toolchain", "we pinned the 6.9 toolchain"],
  ["the schema is at rev 11 now", "the schema is at rev 19 now"],
  ["we tagged the 0.4 preview here", "we tagged the 0.8 preview here"],
  ["the driver moved to v3 today", "the driver moved to v8 today"],
  ["the format bumped to 5.2 here", "the format bumped to 5.7 here"],
  ["we cut the 10.0 release now", "we cut the 12.0 release now"],
  ["the client is on 7.3 today", "the client is on 7.6 today"],
  ["the spec landed at 1.11 now", "the spec landed at 1.14 now"]
];
for (const [a, b] of versionPairs) {
  push({
    category: "negative-version",
    docA: proseDoc(a),
    docB: proseDoc(b),
    eligibility: "both",
    expected: "distinct",
    family: "protected-number",
    id: nextId("cal-neg"),
    protectedEvidence: ["number"],
    rationale: "A changed version number is protected evidence and vetoes the pair.",
    split: "calibration"
  });
}

const symbolPairs = [
  ["set value = ten for now", "set value + ten for now"],
  ["compute a , b and c here", "compute a ; b and c here"],
  ["the map goes a -> b today", "the map goes a . b today"],
  ["the ratio reads a : b now", "the ratio reads a % b now"],
  ["we write a & b in code", "we write a | b in code"],
  ["the guard checks a = b here", "the guard checks a ! b here"],
  ["the union is a + b now", "the union is a * b now"],
  ["the delta is a - b today", "the delta is a % b today"],
  ["the path uses a / b here", "the path uses a . b here"],
  ["the tag reads a # b now", "the tag reads a @ b now"],
  ["we bind a = b in scope", "we bind a : b in scope"],
  ["the shift is a << b here", "the shift is a >> b here"],
  ["the flag sets a ^ b now", "the flag sets a ~ b now"],
  ["we join a , b and d here", "we join a . b and d here"]
];
for (const [a, b] of symbolPairs) {
  push({
    category: "negative-symbol",
    docA: proseDoc(a),
    docB: proseDoc(b),
    eligibility: "both",
    expected: "distinct",
    family: "protected-symbol",
    id: nextId("cal-neg"),
    protectedEvidence: ["symbol"],
    rationale: "A changed operator symbol is protected evidence and vetoes the pair.",
    split: "calibration"
  });
}

const negationCarriers = [
  ["the value is safe to use", "the value is not safe to use"],
  ["we always retry the request", "we never retry the request"],
  ["it works with the cache here", "it works without the cache here"],
  ["the result is ready to ship", "the result is not ready to ship"],
  ["we can reach the primary node", "we can never reach the primary node"],
  ["the plan is final for now", "the plan is not final for now"],
  ["the write is durable here", "the write is not durable here"],
  ["it responds to every ping", "it responds to no ping"],
  ["the lock is held right now", "the lock is not held right now"],
  ["we trust the replica today", "we never trust the replica today"],
  ["the token is valid here now", "the token is not valid here now"],
  ["it runs with the sidecar here", "it runs without the sidecar here"],
  ["the queue is empty right now", "the queue is not empty right now"],
  ["we commit the batch today", "we never commit the batch today"],
  ["the path is open for reads", "the path is not open for reads"],
  ["the node accepts every write", "the node accepts no write"]
];
for (const [a, b] of negationCarriers) {
  push({
    category: "negative-negation",
    docA: proseDoc(a),
    docB: proseDoc(b),
    eligibility: "both",
    expected: "distinct",
    family: "protected-negation",
    id: nextId("cal-neg"),
    protectedEvidence: ["negation"],
    rationale: "A changed negation is protected evidence and vetoes the pair.",
    split: "calibration"
  });
}

const acronyms = [
  "US",
  "API",
  "NASA",
  "HTTP",
  "JSON",
  "SQL",
  "HTML",
  "CSS",
  "XML",
  "CPU",
  "GPU",
  "URL",
  "NATO",
  "PDF"
];
for (const acronym of acronyms) {
  const carrier = `the ACR policy applies here today`;
  push({
    category: "negative-case-acronym",
    docA: proseDoc(carrier.replace("ACR", acronym)),
    docB: proseDoc(carrier.replace("ACR", acronym.toLowerCase())),
    eligibility: "both",
    expected: "distinct",
    family: "case-only",
    id: nextId("cal-neg"),
    protectedEvidence: ["case"],
    rationale: "An acronym differs from its lower-case form only by case and identifier evidence.",
    split: "calibration"
  });
}

const properNouns = [
  ["Polish notation is prefix here", "polish notation is prefix here"],
  ["the Apple orchard is quiet", "the apple orchard is quiet"],
  ["we met in March this year", "we met in march this year"],
  ["the Turkey dish was ready", "the turkey dish was ready"],
  ["May flowers bloom in spring", "may flowers bloom in spring"],
  ["Bill posted the update today", "bill posted the update today"]
];
for (const [a, b] of properNouns) {
  push({
    category: "negative-case-proper",
    docA: proseDoc(a),
    docB: proseDoc(b),
    eligibility: "both",
    expected: "distinct",
    family: "case-only",
    id: nextId("cal-neg"),
    protectedEvidence: ["case"],
    rationale: "A proper-name capital differs from the common word only by case.",
    split: "calibration"
  });
}

// camelCase identifier vs its lower-cased form: same relaxed key, but the identifier evidence and
// case-sensitive key differ, so it is a case-only non-candidate.
const identifiers = [
  "readIndex",
  "preVote",
  "checkQuorum",
  "leaderTransfer",
  "appendEntry",
  "nextIndex",
  "matchIndex",
  "commitIndex"
];
for (const identifier of identifiers) {
  const carrier = "we call IDENT inside the loop";
  push({
    category: "negative-case-identifier",
    docA: proseDoc(carrier.replace("IDENT", identifier)),
    docB: proseDoc(carrier.replace("IDENT", identifier.toLowerCase())),
    eligibility: "both",
    expected: "distinct",
    family: "case-only",
    id: nextId("cal-neg"),
    protectedEvidence: ["case"],
    rationale: "A camelCase identifier differs from its lower-case form only by case and identifier evidence.",
    split: "calibration"
  });
}

// Long-word content swaps verified to be at least three edits apart (the lexical guard rejects them).
const longSwaps = [
  ["bear", "born"],
  ["brown", "green"],
  ["brown", "black"],
  ["brown", "white"],
  ["client", "server"],
  ["write", "reads"],
  ["black", "white"],
  ["warm", "cool"],
  ["fast", "slow"],
  ["open", "close"],
  ["true", "false"],
  ["north", "eastern"],
  ["summer", "winter"],
  ["apple", "mango"],
  ["happy", "angry"],
  ["light", "heavy"],
  ["water", "fires"],
  ["table", "chair"],
  ["earth", "ocean"],
  ["grass", "stone"],
  ["river", "cloud"],
  ["tiger", "eagle"],
  ["glass", "metal"],
  ["paper", "steel"],
  ["start", "abort"],
  ["input", "label"],
  ["query", "index"],
  ["store", "fetch"],
  ["learn", "teach"],
  ["speak", "write"]
];
const longSwapCarriers = [
  "the WORD option is best here",
  "we chose the WORD path today",
  "a WORD signal appeared here now"
];
let longSwapSeq = 0;
for (const [x, y] of longSwaps) {
  const carrier = longSwapCarriers[longSwapSeq % longSwapCarriers.length];
  longSwapSeq += 1;
  push({
    category: "negative-content-long",
    docA: proseDoc(carrier.replace("WORD", x)),
    docB: proseDoc(carrier.replace("WORD", y)),
    eligibility: "both",
    expected: "distinct",
    family: "lexical-content",
    id: nextId("cal-neg"),
    protectedEvidence: [],
    rationale: `The lexical guard rejects the content swap ${x}/${y} (three or more edits apart).`,
    split: "calibration"
  });
}

// Short-word content swaps: a changed token below four code points is never a spelling variant, so the guard
// vetoes it even at edit distance one.
const shortSwaps = [
  ["hot", "cold"],
  ["cat", "dog"],
  ["big", "small"],
  ["old", "new"],
  ["red", "blue"],
  ["sun", "moon"],
  ["day", "week"],
  ["top", "end"],
  ["win", "lose"],
  ["buy", "sell"],
  ["add", "drop"],
  ["raw", "cooked"],
  ["dry", "damp"],
  ["far", "close"],
  ["low", "high"],
  ["yes", "maybe"],
  ["sky", "cloud"],
  ["ice", "fire"],
  ["key", "lock"],
  ["bug", "fix"],
  ["war", "peace"],
  ["joy", "pain"],
  ["sun", "rain"],
  ["day", "dusk"],
  ["man", "kid"],
  ["red", "tan"],
  ["hot", "icy"],
  ["new", "aged"],
  ["win", "tie"],
  ["cat", "owl"]
];
const shortSwapCarriers = [
  "the WORD one is here today",
  "we picked the WORD side now",
  "a WORD choice was made here"
];
let shortSwapSeq = 0;
for (const [x, y] of shortSwaps) {
  const carrier = shortSwapCarriers[shortSwapSeq % shortSwapCarriers.length];
  shortSwapSeq += 1;
  push({
    category: "negative-content-short",
    docA: proseDoc(carrier.replace("WORD", x)),
    docB: proseDoc(carrier.replace("WORD", y)),
    eligibility: "both",
    expected: "distinct",
    family: "lexical-content",
    id: nextId("cal-neg"),
    protectedEvidence: [],
    rationale: `A short changed token (${x}/${y}) is plainly different vocabulary, not a typo.`,
    split: "calibration"
  });
}

const orderPairs = [
  ["the dog chased the cat here", "the cat chased the dog here"],
  ["the man met the boy today", "the boy met the man today"],
  ["we sent the box to the bin", "we sent the bin to the box"],
  ["the fox saw the owl here", "the owl saw the fox here"],
  ["the red beats the raw team", "the raw beats the red team"],
  ["the cat ran past the rat", "the rat ran past the cat"],
  ["we moved the pin to the peg", "we moved the peg to the pin"],
  ["the sun hid the fog today", "the fog hid the sun today"],
  ["the boy fed the pup here", "the pup fed the boy here"],
  ["we tied the bag to the mug", "we tied the mug to the bag"]
];
for (const [a, b] of orderPairs) {
  push({
    category: "negative-order",
    docA: proseDoc(a),
    docB: proseDoc(b),
    eligibility: "both",
    expected: "distinct",
    family: "lexical-order",
    id: nextId("cal-neg"),
    protectedEvidence: [],
    rationale: "A reordered sentence swaps short content words and is not a spelling variant.",
    split: "calibration"
  });
}

const technicalPairs = [
  ["connect over IPv4 today", "connect over IPv6 today", ["number"]],
  ["we store up to 10 MB here", "we store up to 100 MB here", ["number"]],
  ["the law is F=ma exactly", "the law is F+ma exactly", ["symbol"]],
  ["the mask is 0xFF for now", "the mask is 0xEE for now", ["number"]],
  ["run the a_b task first here", "run the a_c task first here", ["symbol"]],
  ["the port is set to 8080 now", "the port is set to 9090 now", ["number"]],
  ["we call the api::run method", "we call the api::halt method", ["symbol"]],
  ["the id is user_42 today", "the id is user_84 today", ["number"]],
  ["the hash starts 3f9 today", "the hash starts 7c2 today", ["number"]],
  ["the range spans 0..9 now", "the range spans 0..7 now", ["number"]],
  ["the tuple is x=1 here now", "the tuple is x=2 here now", ["number"]],
  ["the ptr writes a->b today", "the ptr writes a=>b today", ["symbol"]]
];
for (const [a, b, evidence] of technicalPairs) {
  push({
    category: "negative-technical",
    docA: proseDoc(a),
    docB: proseDoc(b),
    eligibility: "both",
    expected: "distinct",
    family: "protected-technical",
    id: nextId("cal-neg"),
    protectedEvidence: evidence,
    rationale: "A changed technical string differs in protected evidence.",
    split: "calibration"
  });
}

// --- calibration unsupported ---------------------------------------------------------------------------

const benign = proseDoc("a perfectly ordinary sentence here");
const unsupportedInstances = [
  ...["distributed", "orchestration", "consensus", "idempotent", "serializable", "linearizable", "quorum", "throughput", "latency", "partition", "replication", "durability", "availability", "consistency"].map(
    (word) => ["single-word", proseDoc(word), "A single word is too little material to fuzzy match."]
  ),
  ...["caf\u00E9 society opens at dusk", "na\u00EFve r\u00E9sum\u00E9 review today", "the pi\u00F1ata broke open here", "a jalape\u00F1o sauce was made", "we saw a fa\u00E7ade downtown", "the s\u00E9ance ended quietly now", "a d\u00E9j\u00E0 vu moment struck", "the ma\u00F1ana plan was set", "a sm\u00F6rg\u00E5sbord of tests ran soon", "the fjord looked calm t\u00F6day"].map(
    (text) => ["non-ascii", proseDoc(text), "Non-ASCII letters make the material unsupported."]
  ),
  ...["\u5206\u5E03\u5F0F \u7CFB\u7EDF \u8BBE\u8BA1", "\u4F60\u597D \u4E16\u754C \u4ECA\u5929", "\u5FEB\u901F \u6392\u5E8F \u7B97\u6CD5", "\u6570\u636E \u5E93 \u67E5\u8BE2", "\u7F51\u7EDC \u534F\u8BAE \u8BBE\u8BA1", "\u5B66\u4E60 \u7B14\u8BB0 \u6574\u7406", "\u9605\u8BFB \u7406\u89E3 \u8BAD\u7EC3", "\u5199\u4F5C \u7EC3\u4E60 \u63D0\u9AD8"].map(
    (text) => ["cjk", proseDoc(text), "CJK material is unsupported."]
  ),
  ...["great work today \u{1F600} team", "nice job everyone \u{1F44D} here", "we shipped it \u{1F680} at last", "the build is green \u2705 now", "a tricky bug \u{1F41B} appeared here", "party time \u{1F389} for the team"].map(
    (text) => ["emoji", proseDoc(text), "Emoji make the material unsupported."]
  ),
  ...[["open the ", "site", " now here", "https://a.test"], ["see the ", "guide", " for details", "https://b.test"], ["read the ", "post", " again here", "https://c.test"], ["visit the ", "page", " once more", "https://d.test"], ["follow the ", "link", " below now", "https://e.test"], ["check the ", "repo", " today here", "https://f.test"]].map(
    ([before, marked, after, href]) => ["link", markedDoc(before, marked, { attrs: { href }, type: "link" }, after), "A link mark is content-bearing and unsupported."]
  ),
  ...[["run the ", "build", " step now here"], ["call ", "reduce", " over the list"], ["set the ", "flag", " before start here"], ["invoke ", "flush", " after every write"], ["read the ", "value", " from the map"], ["append ", "entry", " to the log now"]].map(
    ([before, marked, after]) => ["code", markedDoc(before, marked, { type: "code" }, after), "Inline code is unsupported."]
  ),
  ...["a small heading title here", "another heading shows up here", "the chapter opens right here", "a section header sits here", "the summary heading goes here", "final notes heading appears here", "the intro heading is set", "a closing heading ends here"].map(
    (text) => ["heading", headingDoc(text), "A heading is structural and unsupported."]
  ),
  ...["a single bullet item here", "another bullet point sits here", "the first list entry here", "one more bullet lands here", "a short list line here", "the final bullet ends here", "a nested bullet goes here", "one bullet remains here now"].map(
    (text) => ["list", listDoc(text), "A list is structural and unsupported."]
  ),
  ...["a b c", "x y z", "go now", "do it", "run it", "up top"].map(
    (text) => ["too-short", proseDoc(text), "Below eight code points there is too little material."]
  ),
  ...[Array.from({ length: 30 }, () => "abcdefghij").join(" "), Array.from({ length: 45 }, (_, i) => `word${i}`).join(" "), Array.from({ length: 50 }, (_, i) => `token${i}`).join(" "), `${"verylongword ".repeat(20)}end`, Array.from({ length: 42 }, () => "alpha").join(" "), Array.from({ length: 41 }, () => "note").join(" "), `${"a very long passage that keeps going ".repeat(8)}stop`, Array.from({ length: 60 }, (_, i) => `k${i}`).join(" ")].map(
    (text) => ["oversized", proseDoc(text), "Beyond forty tokens or 240 code points it is a passage, not a card."]
  )
];
for (const [family, docA, rationale] of unsupportedInstances) {
  push({
    category: `unsupported-${family}`,
    docA,
    docB: benign,
    eligibility: "docA-unsupported",
    expected: "unsupported",
    family: `unsupported-${family}`,
    id: nextId("cal-uns"),
    protectedEvidence: [],
    rationale,
    split: "calibration"
  });
}

for (const row of buildHoldout()) {
  push(row);
}

writeFileSync(OUT, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
process.stdout.write(`Wrote ${rows.length} rows to ${OUT}\n`);

// -----------------------------------------------------------------------------------------------------
// Hand-authored holdout — independently curated literals, NOT produced by the calibration mutation
// functions above. Positives are real-world English misspellings; negatives are curated distinct pairs kept
// inside the guard's competence (a short changed token, three-plus edits apart, or a protected/case
// difference); the named test-matrix examples appear verbatim. The holdout gates are measured only here.
// -----------------------------------------------------------------------------------------------------
function buildHoldout() {
  let h = 0;
  const id = () => `hold-${String((h += 1)).padStart(3, "0")}`;
  const out = [];
  const pos = (a, b, family, rationale) =>
    out.push({ category: `holdout-${family}`, docA: proseDoc(a), docB: proseDoc(b), eligibility: "both", expected: "possible", family, id: id(), protectedEvidence: [], rationale, split: "holdout" });
  const neg = (a, b, family, evidence, rationale) =>
    out.push({ category: `holdout-${family}`, docA: proseDoc(a), docB: proseDoc(b), eligibility: "both", expected: "distinct", family, id: id(), protectedEvidence: evidence, rationale, split: "holdout" });
  const uns = (docA, family, rationale) =>
    out.push({ category: `holdout-${family}`, docA, docB: proseDoc("a perfectly ordinary sentence here"), eligibility: "docA-unsupported", expected: "unsupported", family, id: id(), protectedEvidence: [], rationale, split: "holdout" });

  // Named test-matrix positives + renderer + threshold-scale edits.
  pos("everything is fine in terms of scope", "everything is fine in term of scope", "deletion", "in terms of vs in term of.");
  pos("the result depends on the leader", "the result depens on the leader", "deletion", "depends on vs depens on.");
  pos("we separate the two concerns", "we seperate the two concerns", "substitution", "separate concerns vs seperate concerns.");
  pos("please review the design carefully", "please reveiw the design carefully", "transposition", "review vs reveiw.");
  pos("the plan looks well organized today", "the plan looks well-organized today", "spacing", "hyphen vs space renderer variant.");
  pos("she called it a quiet success", "she called it a \u201Cquiet\u201D success", "quote", "curly vs straight quote (mark on both sides).");
  pos("we pause here - then continue", "we pause here \u2014 then continue", "dash", "hyphen vs em dash.");
  pos("we ship it - the final cut", "we ship it \u2013 the final cut", "dash", "hyphen vs en dash.");
  pos("the team's plan is ready today", "the team\u2019s plan is ready today", "apostrophe", "straight vs curly possessive apostrophe.");
  pos("the leader appends the entry now", "the leader apends the entrie now", "two-edit", "two long-word typos across five tokens.");
  pos(
    "distributed systems replicate every committed write across a healthy quorum before the coordinator finally acknowledges the waiting client safely",
    "distributed systems replicate every commited write across a healthy quorum before the coordinator finaly acknowledges the waiting client safely",
    "two-edit",
    "two typos in twenty-token material."
  );

  // Curated real-world misspellings (correct vs common misspelling), each a single changed long word.
  const carriers = [
    "the word WORD appears in this note",
    "consider the word WORD in context here",
    "we wrote the word WORD down today",
    "the word WORD is spelled out here",
    "note that the word WORD is used",
    "here the word WORD shows up again"
  ];
  const misspellings = [
    ["definitely", "definately"],
    ["occurrence", "occurence"],
    ["receive", "recieve"],
    ["accommodate", "accomodate"],
    ["necessary", "necesary"],
    ["beginning", "begining"],
    ["believe", "beleive"],
    ["calendar", "calender"],
    ["category", "catagory"],
    ["cemetery", "cemetary"],
    ["committed", "commited"],
    ["embarrass", "embarass"],
    ["environment", "enviroment"],
    ["existence", "existance"],
    ["experience", "experiance"],
    ["familiar", "familar"],
    ["foreign", "foriegn"],
    ["government", "goverment"],
    ["grammar", "grammer"],
    ["guarantee", "garantee"],
    ["immediately", "immediatly"],
    ["independent", "independant"],
    ["knowledge", "knowlege"],
    ["millennium", "milennium"],
    ["noticeable", "noticable"],
    ["occasion", "ocasion"],
    ["occurred", "occured"],
    ["personnel", "personel"],
    ["possession", "posession"],
    ["preferred", "prefered"],
    ["privilege", "privilage"],
    ["probably", "probaly"],
    ["professor", "proffesor"],
    ["pronunciation", "pronounciation"],
    ["publicly", "publically"],
    ["recommend", "recomend"],
    ["reference", "referrence"],
    ["relevant", "relevent"],
    ["restaurant", "restaurent"],
    ["rhythm", "rythm"],
    ["schedule", "schedual"],
    ["successful", "succesful"],
    ["tomorrow", "tomorow"],
    ["until", "untill"],
    ["vacuum", "vacum"],
    ["weird", "wierd"],
    ["argument", "arguement"],
    ["business", "busines"],
    ["column", "colum"],
    ["dilemma", "dilema"],
    ["neighbor", "nieghbor"],
    ["surprise", "suprise"],
    ["appearance", "apearance"],
    ["beautiful", "beatiful"],
    ["character", "charactor"],
    ["convenient", "conveniant"],
    ["description", "discription"],
    ["difference", "diference"],
    ["maintenance", "maintainance"]
  ];
  misspellings.forEach(([correct, wrong], index) => {
    const carrier = carriers[index % carriers.length];
    pos(carrier.replace("WORD", correct), carrier.replace("WORD", wrong), "misspelling", `${correct} vs ${wrong} is a real-world spelling variant.`);
  });

  // Named test-matrix negatives + curated distinct pairs across every guard family.
  neg("a bear wandered the deep woods", "a born wandered the deep woods", "lexical-content", [], "bear vs born is different vocabulary.");
  neg("the soup is really quite hot", "the soup is really quite cold", "lexical-content", [], "hot vs cold are opposites.");
  neg("we store up to 10 MB here", "we store up to 100 MB here", "protected-number", ["number"], "10 MB vs 100 MB.");
  neg("we connect over IPv4 here", "we connect over IPv6 here", "protected-number", ["number"], "IPv4 vs IPv6.");
  neg("the value is safe to use", "the value is not safe to use", "protected-negation", ["negation"], "is safe vs is not safe.");
  neg("the law is written F=ma here", "the law is written F+ma here", "protected-symbol", ["symbol"], "F=ma vs F+ma.");
  neg("the US policy applies here today", "the us policy applies here today", "case-only", ["case"], "US vs us.");
  neg("Polish notation is prefix here", "polish notation is prefix here", "case-only", ["case"], "Polish vs polish.");
  neg("the dog bites the man today", "the man bites the dog today", "lexical-order", [], "dog bites man vs man bites dog.");

  const negNumber = [
    ["the request took 3 seconds here", "the request took 8 seconds here"],
    ["we keep about 20 percent free", "we keep about 70 percent free"],
    ["we ship version 2 tomorrow now", "we ship version 5 tomorrow now"],
    ["the mask reads 0xFF today here", "the mask reads 0xAA today here"],
    ["the port stays at 8080 here", "the port stays at 9090 here"],
    ["we saw 42 errors in total", "we saw 84 errors in total"],
    ["the file weighs 5 KB today", "the file weighs 9 KB today"],
    ["it expires in 30 days now", "it expires in 90 days now"]
  ];
  for (const [a, b] of negNumber) {
    neg(a, b, "protected-number", ["number"], "A changed number is protected evidence.");
  }
  const negSymbol = [
    ["the array uses a -> b link", "the array uses a => b link"],
    ["we assign x = y here now", "we assign x + y here now"],
    ["the pair is a , b today", "the pair is a ; b today"],
    ["we compare a > b in code", "we compare a < b in code"],
    ["the scope reads a :: b now", "the scope reads a . b now"]
  ];
  for (const [a, b] of negSymbol) {
    neg(a, b, "protected-symbol", ["symbol"], "A changed operator symbol is protected evidence.");
  }
  const negNegation = [
    ["we always flush the buffer now", "we never flush the buffer now"],
    ["it can reach the primary here", "it cannot reach the primary here"],
    ["the write is durable today", "the write is not durable today"],
    ["it works with the proxy here", "it works without the proxy here"],
    ["the node responds to pings", "the node responds to no pings"]
  ];
  for (const [a, b] of negNegation) {
    neg(a, b, "protected-negation", ["negation"], "A changed negation is protected evidence.");
  }
  const negCase = [
    ["the API returns a token here", "the api returns a token here"],
    ["we parse the JSON payload now", "we parse the json payload now"],
    ["the HTTP header is set here", "the http header is set here"],
    ["we ran the SQL query today", "we ran the sql query today"],
    ["the Apple orchard is quiet", "the apple orchard is quiet"],
    ["we met in March this year", "we met in march this year"]
  ];
  for (const [a, b] of negCase) {
    neg(a, b, "case-only", ["case"], "A case-only difference is never a candidate.");
  }
  const negContent = [
    ["we deploy the green build now", "we deploy the black build now"],
    ["the client waits for the lock", "the server waits for the lock"],
    ["we scale the write path today", "we scale the reads path today"],
    ["the summer plan is ready now", "the winter plan is ready now"],
    ["a warm signal arrived here", "a cool signal arrived here"],
    ["the big option wins here now", "the odd option wins here now"],
    ["the cat sat on the wide mat", "the cat sat on the wide rug"],
    ["we open the outer gate here", "we close the outer gate here"]
  ];
  for (const [a, b] of negContent) {
    neg(a, b, "lexical-content", [], "Different vocabulary the guard rejects.");
  }
  const negOrder = [
    ["the dog chased the fox here", "the fox chased the dog here"],
    ["we sent the box to the bin", "we sent the bin to the box"],
    ["the man saw the boy today", "the boy saw the man today"],
    ["the cat woke the pup here", "the pup woke the cat here"],
    ["we tied the mug to the jar", "we tied the jar to the mug"]
  ];
  for (const [a, b] of negOrder) {
    neg(a, b, "lexical-order", [], "A reordered short-token sentence is not a spelling variant.");
  }
  const negMore = [
    ["the batch ran 18 jobs today", "the batch ran 81 jobs today", "protected-number", ["number"]],
    ["we cache about 12 rows here", "we cache about 21 rows here", "protected-number", ["number"]],
    ["the result is stable for now", "the result is not stable for now", "protected-negation", ["negation"]],
    ["the merge is clean right now", "the merge is not clean right now", "protected-negation", ["negation"]],
    ["the CPU stays cool here now", "the cpu stays cool here now", "case-only", ["case"]],
    ["we serve the HTML page now", "we serve the html page now", "case-only", ["case"]],
    ["the union is a + b today", "the union is a - b today", "protected-symbol", ["symbol"]],
    ["the guard checks a = b now", "the guard checks a ! b now", "protected-symbol", ["symbol"]],
    ["the river runs very fast", "the ocean runs very fast", "lexical-content", []],
    ["we picked the sweet apple", "we picked the sweet mango", "lexical-content", []],
    ["the sky turned dark here", "the sea turned dark here", "lexical-content", []],
    ["we set the old flag today", "we set the new flag today", "lexical-content", []]
  ];
  for (const [a, b, family, evidence] of negMore) {
    neg(a, b, family, evidence, "A curated distinct pair the guard or protected evidence rejects.");
  }
  const negTechnical = [
    ["we connect over IPv4 today", "we connect over IPv6 today"],
    ["the mask reads 0xFF here now", "the mask reads 0xAA here now"],
    ["the port binds to 8080 now", "the port binds to 9090 now"],
    ["the law is F=ma right here", "the law is F+ma right here"]
  ];
  for (const [a, b] of negTechnical) {
    neg(a, b, "protected-technical", ["number"], "A changed technical string differs in protected evidence.");
  }

  // Hand-authored unsupported across every unsupported family.
  const unsWords = ["consensus", "idempotent", "serializable", "throughput", "partition", "durability"];
  for (const word of unsWords) {
    uns(proseDoc(word), "unsupported-single-word", "A single technical word.");
  }
  for (const text of ["r\u00E9sum\u00E9 screening starts today", "the caf\u00E9 opens at nine", "a na\u00EFve guess was made", "we saw a fa\u00E7ade here"]) {
    uns(proseDoc(text), "unsupported-non-ascii", "Accented letters are unsupported.");
  }
  for (const text of ["\u5FEB\u901F \u6392\u5E8F \u7B97\u6CD5", "\u6570\u636E \u5E93 \u8BBE\u8BA1", "\u5B66\u4E60 \u7B14\u8BB0 \u6574\u7406", "\u9605\u8BFB \u7406\u89E3 \u8BAD\u7EC3"]) {
    uns(proseDoc(text), "unsupported-cjk", "CJK phrase.");
  }
  for (const text of ["nice job everyone \u{1F44D} today", "we shipped it \u{1F680} at last", "the build is green \u2705 now"]) {
    uns(proseDoc(text), "unsupported-emoji", "Emoji present.");
  }
  uns(markedDoc("see the ", "docs", { attrs: { href: "https://d.test" }, type: "link" }, " for more here"), "unsupported-link", "A link mark.");
  uns(markedDoc("open the ", "site", { attrs: { href: "https://e.test" }, type: "link" }, " again now"), "unsupported-link", "A link mark.");
  uns(markedDoc("call ", "reduce", { type: "code" }, " over the list here"), "unsupported-code", "Inline code.");
  uns(markedDoc("set the ", "flag", { type: "code" }, " before we start"), "unsupported-code", "Inline code.");
  uns(headingDoc("chapter one begins here now"), "unsupported-heading", "A heading node.");
  uns(headingDoc("the final summary heading here"), "unsupported-heading", "A heading node.");
  uns(listDoc("first bullet point here now"), "unsupported-list", "A list node.");
  uns(listDoc("another bullet lands here now"), "unsupported-list", "A list node.");
  uns(proseDoc("go now"), "unsupported-too-short", "Too few code points.");
  uns(proseDoc("do it"), "unsupported-too-short", "Too few code points.");
  uns(proseDoc(Array.from({ length: 50 }, (_, i) => `token${i}`).join(" ")), "unsupported-oversized", "Beyond forty tokens.");
  uns(proseDoc(`${"verylongword ".repeat(20)}end`), "unsupported-oversized", "Beyond 240 code points.");

  return out;
}
