# Learning methodology

> This is **the draft shape**, not the final verdict. Solid enough to build v1 from; expected to evolve once the loop is in daily use.

## What whetstone is

A guide-with-conviction. The app leads the user through a daily learning loop with strong defaults — what to encounter, how to engage, what to recall, how recall gets judged. Users can adapt the form for their own material, but the underlying philosophy is fixed.

This is **not** a flashcard app. Flashcards are one of several recall styles, used only where they fit.

## The five convictions (locked layer)

These are rules the user cannot turn off. They are what makes whetstone *whetstone*.

1. **Daily encounter beats sporadic effort.** The routine runs every day. Skipping is failure; shrinking is fine.
2. **Joy is fuel, not a luxury.** Ritual slots are sacred — outside recall, never graded, never skipped. They exist to make returning easy.
3. **Growth, not retention, is the goal.** Recall serves understanding; understanding serves becoming someone. Forgetting is data, not failure.
4. **Templates structure engagement; they do not quiz.** A scaffold for *your* writing, not a slot for the "right answer."
5. **Your past self is the rubric.** What you wrote when you first understood something is the benchmark for whether it still lives in you. The LLM compares; the app does not prescribe truth.

## Categories (default suggestions, admin-extensible)

Each encounter belongs to exactly one category. A category bundles four things: a **template** (what to write when you encounter), a **recall algorithm** (when to revisit), a **grading style** (how the LLM judges recall), and a **default daily slot weight** (how much of your daily budget it gets).

The app ships with five default categories. Users can author more later via admin UI (deferred, see Open questions).

### 1. Literary narrative

For stories with author, viewpoint, drama. Examples: 《史记》 biographies, novels, essays, narrative non-fiction.

- **Template**:
  1. What's the story? (3-5 sentences)
  2. What's the author's view? (2-3 sentences)
  3. What do you think? (your reaction)
  4. Gems worth taking? (1-3 quotes + why each matters)
- **Recall algorithm**: Diminishing revisits — 1d, 7d, 30d, 90d, then done.
- **Grading**: LLM compares user's recalled summary against their original answer. Not against source.
- **Why**: Understanding doesn't decay infinitely. Once a story is integrated, it stays. The 90-day cutoff prevents the queue from accumulating forever.

### 2. Recitation

For passages meant to be memorized verbatim. Examples: 诗词, 名句, 《滕王阁序》, 《洛神赋》, English poetry.

- **Template**:
  1. Source (work, chapter, line numbers if applicable)
  2. Passage (the verbatim text)
  3. Context (when, why, what surrounds it)
  4. Why this matters to you
- **Recall algorithm**: FSRS (modern spaced repetition).
- **Grading**: LLM compares user's recalled passage character-by-character against the original. Tolerance for punctuation, strict on words.
- **Why**: Verbatim retention is the well-studied SRS use case. FSRS over SM-2 because it adapts to per-user forgetting curves.

### 3. Vocabulary

For words and phrases with meaning. Examples: English literature vocabulary, 古文 vocabulary, technical terminology.

- **Template**:
  1. Word/phrase
  2. Meaning (in your own words)
  3. Example sentence (from source or self-generated)
  4. Etymology or memorable hook (optional)
- **Recall algorithm**: FSRS.
- **Grading**: LLM checks user's recalled meaning + example. Accepts paraphrase of meaning, looks for correct usage in example.
- **Why**: Vocabulary is verbatim-adjacent — the word's spelling and a usable definition need to stick.

### 4. Concept/mechanism

For logical structures: how something works. Examples: CS algorithms, OS mechanisms (LRU, page tables), networking concepts, math theorems.

- **Template**:
  1. What problem does this solve?
  2. How does it work? (explain the mechanism)
  3. When does it fail or degrade?
  4. What's the trade-off vs alternatives?
- **Recall algorithm**: Linked surfacing — no clock. The concept surfaces when the user starts encountering related material. The graph drives surfacing, not the calendar.
- **Grading**: LLM compares user's re-derivation of mechanism against their original explanation. Allows alternative valid derivations.
- **Why**: Concepts integrate with neighbors. Quizzing in isolation breaks them out of context; surfacing during related work strengthens them.

### 5. Reflection

For personal thoughts, diary, processing experiences.

- **Template**: Free-form. No scaffold.
- **Recall algorithm**: None. No recall queue.
- **Grading**: None.
- **Why**: Diary is for writing, not testing. Marked as a category for completeness and to keep all encounters in one store.

## The daily loop

```
Today's routine
├── 🎯 Ritual    (笠翁对韵-style daily reading, ~10 min)
│       └── Checkbox, no template, no grading. Sacred.
│
├── 🔁 Recall    (capped at 15 items/day, interleaved across categories)
│       └── For each item:
│           1. App shows the encounter's template prompts
│           2. User writes recalled answer in free form
│           3. LLM grades vs the user's original answer + source
│           4. Category's algorithm updates the item's next-surface date
│
├── 📖 Encounter (new material, 1-2 slots per active category)
│       └── For each slot:
│           1. User reads source material
│           2. User fills the category's template
│           3. Saved as a Note; enters recall queue per category's algorithm
│
└── 🔗 Connect   (1 manual link/day from new Note to existing Note)
        └── Free-text in body, e.g. "Related: see [[note-id]]"
```

### How recall items are selected (the cap mechanism)

When the recall queue has more than 15 items eligible for today:

1. Bucket items by category.
2. Round-robin across categories with eligible items, picking the most-overdue first within each.
3. Fill until cap is reached.
4. Items left over: their next-surface date is pushed forward by 1 day.

This prevents one category from dominating the day (e.g., 200 recitation items shouldn't crowd out a single literary narrative review).

### How new-encounter slots are sized

Each category has a default weight. The day's available encounter time (daily budget minus ritual minus recall time) is split by weight. Defaults:

| Category | Weight | Typical session |
|---|---|---|
| Concept/mechanism | 3 | ~45 min weekday, ~90 min weekend |
| Literary narrative | 2 | ~30 min weekday, ~60 min weekend |
| Vocabulary | 1 | ~15 min |
| Recitation | 1 | ~15 min |
| Reflection | 0 (opt-in per day) | varies |

User can adjust per-day, and the defaults are tunable in settings.

## LLM grading

### Pattern: LLM judges, hard cap

- Every recall item produces a grading request to an LLM.
- Input: the source material (or its key passage), the original user answer, the new recall answer.
- Output: one of four grades.

**Four grades** (not three):
- **Forgot** — user couldn't recall, or recalled wrong.
- **Partial** — user got the gist but missed key parts.
- **Solid** — user matched their original understanding.
- **Stronger** — user's recall is *better* than original (added nuance, clearer thinking). Signals integration.

The four grades feed into each category's algorithm:
- FSRS uses them as standard difficulty inputs.
- Diminishing revisits advances on Solid/Stronger, holds on Partial, resets on Forgot.
- Linked surfacing uses them to weight related-concept surfacing.

### Cost control (three mechanisms, all v1)

1. **Daily budget cap**: configurable, default **$0.25/day** (~150 graded items at Haiku 4.5 pricing). When budget exhausts, remaining items fall back to self-grade (user picks Forgot/Partial/Solid/Stronger themselves).
2. **Per-request token cap**: grading prompts capped at 2,000 input tokens. Long source material is truncated with notice.
3. **Visible spend log**: settings page shows today's spend, this month's spend, and the rolling 30-day average. No surprises.

### Model choice

- **Default**: Haiku 4.5 — fast, cheap, sufficient for most grading.
- **Deep review** (opt-in per note): Opus 4.7 — used when the user flags an item for higher-quality grading.

### The `IGrader` seam

LLM grading is the second real seam in the app (after `INoteStore`). Defined as an interface from day one:

```
IGrader
├── AnthropicGrader     (v1 — calls Anthropic API)
├── OllamaGrader        (v1.5/v2 — calls local Ollama, desktop only)
└── SelfGrader          (always — fallback when budget exhausted)
```

Adding local LLM support later is mechanical: implement `OllamaGrader`, change one line in DI registration.

## What this drops or supersedes from earlier docs

- **SM-2** (in ADR 0001 and scope-v1) is replaced by **FSRS** for recitation and vocabulary categories. Literary narrative and concept/mechanism categories use their own algorithms (diminishing revisits, linked surfacing). ADR 0001 superseded in part — see ADR 0003.
- **Single recall queue with one algorithm** is replaced by **per-category algorithms with interleaving**. The 15/day cap survives; the prioritization changes.
- **`INoteStore`** unchanged. New seam `IGrader` added.
- **Schema must carry**: category (foreign key), original-answer-per-encounter (the rubric), spend log table, per-category algorithm state.

## Open questions (settle from real use, not now)

- **Is reflection category needed?** Could become a separate tool. Drafted in for completeness.
- **Admin UI for category authoring in v1?** Drafted as deferred. May surface as needed.
- **6th category?** Possibly "technical reading" (papers, man pages, RFCs) distinct from "concept/mechanism." Defer until real material doesn't fit existing five.
- **Daily budget default $0.25** — may need adjustment after observing actual usage.
- **Grading prompt engineering** — the prompt sent to the LLM for each category type is itself a design problem. Drafted as part of implementation, refined from real grading output.
