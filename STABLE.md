# STABLE.md

The current locked design of whetstone. This document is what *is* — not what *was decided* (see [`decisions/`](./decisions/) for the why) and not what's *in motion* (see [`DRAFT.md`](./DRAFT.md) for that).

When something is locked, it goes here. When it changes, this document is edited in the same commit as the ADR recording the change.

---

## What whetstone is

A personal learning app that turns daily reading, note-taking, and recall into a sustainable practice. Built on the principle that **short, daily, joyful practice beats long, sporadic, forced study.**

> Growth through daily discipline.

### The loop

```
read  →  note  →  speak (explain it back)  →  connect (link to what you know)
                                                                ↓
                                                          recall tomorrow
```

Every day whetstone produces a routine: a small set of recall items from past encounters and slots for new material across the user's active categories.

### What whetstone is NOT

To prevent drift, these negations are part of the spec:

- **Not a flashcard app.** Flashcards (FSRS recall) are one of four recall algorithms, used only where they fit.
- **Not a notes app with optional AI.** LLM grading is on the critical path of the daily loop.
- **Not a sandbox for the user to define their own loop.** Whetstone is a guide-with-conviction. Defaults are strong; users adapt within the form.
- **Not a productivity tracker.** No streaks, no stats, no gamification. The feedback is the routine itself.
- **Not a knowledge graph.** Linking is one-direction, manual, intentional — not auto-generated.
- **Not a multi-user / team product.** Personal app, single user, no auth in v1.

---

## The five convictions

These are rules the user cannot turn off. They are what makes whetstone *whetstone*.

1. **Daily encounter beats sporadic effort.** The routine runs every day. Skipping is failure; shrinking is fine.
2. **Joy is fuel, not a luxury.** Ritual slots are sacred — outside recall, never graded, never skipped.
3. **Growth, not retention, is the goal.** Recall serves understanding; understanding serves becoming someone. Forgetting is data, not failure.
4. **Templates structure engagement; they do not quiz.** A scaffold for *your* writing, not a slot for the "right answer."
5. **Your past self is the rubric.** What you wrote when you first understood something is the benchmark for whether it still lives in you. The LLM compares; the app does not prescribe truth.

### Decision boundary for future features

When a future feature is proposed, judge it against the convictions:

1. **A feature that helps the user *avoid* a conviction is rejected.** Drop-this-card violates #3. Hide-low-grades violates #5.
2. **A feature that helps the user *fulfill* a conviction more easily is welcomed.** Pause serves #1. Show-improvement serves #3.
3. **When in doubt, name the conviction the feature touches.** If the feature exists to *bend* the conviction, reject. If it exists to *serve* the conviction, accept.

---

## Methodology

### Categories

Each encounter belongs to exactly one category. A category bundles four things: a **template** (what to write when you encounter), a **recall algorithm** (when to revisit), a **grading style** (how the LLM judges recall), and a **default daily slot weight** (how much of the daily budget it gets).

Five default categories ship in v1. Users can author more later (deferred to v2; see [`BACKLOG.md`](./BACKLOG.md)).

#### 1. Literary narrative
For stories with author, viewpoint, drama. Examples: 《史记》 biographies, novels, essays, narrative non-fiction.

- **Template**: (1) What's the story? (2) What's the author's view? (3) What do you think? (4) Gems worth taking?
- **Recall**: diminishing revisits — 1d, 7d, 30d, 90d, then done.
- **Grading**: LLM compares user's recalled summary against their original answer.
- **Rationale**: Understanding doesn't decay infinitely. The 90-day cutoff prevents queue accumulation.

#### 2. Recitation
For passages meant to be memorized verbatim. Examples: 诗词, 名句, 《滕王阁序》, 《洛神赋》, English poetry.

- **Template**: (1) Source (2) Passage (3) Context (4) Why this matters to you.
- **Recall**: FSRS (modern spaced repetition).
- **Grading**: LLM compares character-by-character. Tolerance for punctuation, strict on words.
- **Rationale**: Verbatim retention is the well-studied SRS use case. FSRS over SM-2 because it adapts to per-user forgetting curves.

#### 3. Vocabulary
For words and phrases with meaning. Examples: English literature vocabulary, 古文 vocabulary, technical terminology.

- **Template**: (1) Word/phrase (2) Meaning in your own words (3) Example sentence (4) Etymology or memorable hook.
- **Recall**: FSRS.
- **Grading**: LLM checks recalled meaning (paraphrase OK) + correct usage in example.

#### 4. Concept / mechanism
For logical structures: how something works. Examples: CS algorithms, OS mechanisms, networking concepts, math theorems.

- **Template**: (1) What problem does this solve? (2) How does it work? (3) When does it fail or degrade? (4) Trade-off vs alternatives.
- **Recall**: linked surfacing — no clock. The concept surfaces when the user encounters related material. The graph drives surfacing, not the calendar.
- **Grading**: LLM compares re-derivation of mechanism against original. Alternative valid derivations accepted.
- **Rationale**: Concepts integrate with neighbors. Quizzing in isolation breaks them out of context.

#### 5. Reflection
For personal thoughts, diary, processing experiences.

- **Template**: free-form, no scaffold.
- **Recall**: none.
- **Grading**: none.
- **Rationale**: Diary is for writing, not testing. Marked as a category to keep all encounters in one store.

### Daily loop

```
Today's routine
├── 🎯 Ritual    (笠翁对韵-style daily reading, ~10 min)
│       └── Checkbox, no template, no grading. Sacred.
│
├── 🔁 Recall    (capped at 15 items/day, interleaved across categories)
│       └── For each item:
│           1. App shows template prompts
│           2. User writes recalled answer in free form
│           3. LLM grades vs original answer + source
│           4. Category's algorithm updates next-surface date
│
├── 📖 Encounter (new material, 1-2 slots per active category)
│       └── For each slot:
│           1. User reads source material
│           2. User fills category's template
│           3. Saved as a Note; enters recall queue per category
│
└── 🔗 Connect   (1 manual link/day from new Note to existing Note)
```

### Recall queue selection (the cap mechanism)

When the recall queue has more than 15 items eligible today:

1. Bucket items by category.
2. Round-robin across categories with eligible items, picking most-overdue first within each.
3. Fill until cap is reached.
4. Items left over: next-surface date pushed forward by 1 day.

This prevents one category from dominating the day.

### New-encounter slot sizing

Each category has a default weight. Daily time available for encounters (budget minus ritual minus recall) is split by weight.

| Category | Weight | Typical session |
|---|---|---|
| Concept/mechanism | 3 | ~45 min weekday, ~90 min weekend |
| Literary narrative | 2 | ~30 min weekday, ~60 min weekend |
| Vocabulary | 1 | ~15 min |
| Recitation | 1 | ~15 min |
| Reflection | 0 (opt-in per day) | varies |

### LLM grading

LLM judgement is on the critical path. Self-grading is the fallback when budget is exhausted, not the default.

**Four grades** (not three):
- **Forgot** — couldn't recall or recalled wrong.
- **Partial** — got the gist but missed key parts.
- **Solid** — matched original understanding.
- **Stronger** — recall is *better* than original (added nuance, clearer thinking). Signals integration.

**Cost controls (all v1):**
1. **Daily budget cap**: configurable, default **$0.25/day** (~150 graded items at Haiku 4.5 pricing). When exhausted, falls back to self-grade.
2. **Per-request token cap**: 2,000 input tokens. Long source truncated with notice.
3. **Visible spend log**: settings shows today, this month, rolling 30-day average.

**Model choice**: Haiku 4.5 default. Opus 4.7 only when user explicitly flags an item for deep review.

**The `IGrader` seam:**

```
IGrader
├── AnthropicGrader     (v1 — calls Anthropic API)
├── OllamaGrader        (v1.5/v2 — calls local Ollama, desktop only)
└── SelfGrader          (always — fallback when budget exhausted)
```

### Pause mechanism

A user's life is not uniformly available. Pause is the conviction-aligned escape: declared, visible, time-bounded.

**Category pause** — applied to a single category. Queue freezes, no new dues accrue, no new-encounter slots offered. Other categories continue. Resume shifts due dates forward by pause duration.

**Loop pause** — applied to the whole app. All recall + new-encounter slots suppressed. Ritual pauses by default; user can opt to keep it. Resume shifts every recall item's next-surface date forward by pause duration. **No FSRS recalculation, no lapses recorded, no penalty, no shame.**

Math: `new_due_date = old_due_date + pause_duration`.

**What pause does NOT allow:**
- **No item-level pause.** Drop-button in disguise; violates Conviction #3.
- **No retroactive pause.** Past skipping was skipping.
- **No silent pause.** Settings always shows active pause status.

---

## Stack

| Layer | Choice | Why |
|---|---|---|
| Framework | **.NET MAUI Blazor Hybrid** | One codebase → PWA + native iOS/Android/Windows/Mac. Real native shell is a stated future goal. |
| Storage (v1) | **SQLite via EF Core** | Local, zero-config, ships with MAUI. Survives offline. |
| Storage abstraction | **`INoteStore` interface** | `SqliteNoteStore` now, `RemoteApiNoteStore` later. Swap is one line. |
| Note format | **Markdown body + YAML frontmatter** | Plain text, human-readable, export = serialize → `.md` file. |
| Grader abstraction | **`IGrader` interface** | `AnthropicGrader` v1, `OllamaGrader` later, `SelfGrader` always. |
| Sync | **None in v1** — export-zip is the migration path | Eliminates Azure as a v1 blocker. |

Real seams: exactly two — `INoteStore` and `IGrader`. Any new interface needs an ADR.

---

## Scope (v1)

The minimum that runs the full loop end-to-end on Windows. Ships before any other feature.

### In v1

1. **Today screen** — day's routine: recall items (capped 15, interleaved across categories), new-encounter slots per active category, daily ritual checkbox.
2. **Recall an item** — app shows template prompts; user writes free-form recalled answer; LLM grades against original (Forgot/Partial/Solid/Stronger); category's algorithm advances next-surface date. Self-grade fallback when budget exhausted.
3. **Create a new encounter** — pick category, fill template, save. Note enters its category's recall queue.
4. **View / edit a note** — open from Today, see body, edit body, save.
5. **Five default categories** shipped in code: literary narrative, recitation, vocabulary, concept/mechanism, reflection. Admin UI for user-authored categories deferred.
6. **`AnthropicGrader` + `SelfGrader`** implementations of `IGrader`. Anthropic API key configured in settings.
7. **Cost controls**: daily budget cap (default $0.25), per-request token cap (2,000 input), visible spend log.
8. **Pause** — category-level and app-level, with date-shifting on resume.
9. **Export everything** — Settings → "Download all notes as `.zip`". Files are real `.md` with frontmatter. Spend log exported as CSV.
10. **Local SQLite storage** behind `INoteStore`. No auth. Single user.

### Out of v1 — see [`BACKLOG.md`](./BACKLOG.md)

Notable deferrals: cloud sync, local LLM (Ollama) grading, user-authored categories, native mobile build, tags/search, backlinks, voice memo, push notifications, themes.

### Discipline rule

If during construction an idea arrives — *"I should also add X"* — it goes in [`BACKLOG.md`](./BACKLOG.md), not into v1. **Nothing** gets added to v1 after this lock without explicit user confirmation.

---

## Engineering principles

### Code

- **Microsoft C# / .NET conventions**, enforced by `dotnet format` + `.editorconfig`.
- **Nullable reference types: on, warnings as errors.**
- **Async all the way.** Any I/O method returns `Task<T>`. No `.Result`, no `.Wait()`.
- **One class per file.** Filename matches type name.
- **Class is the default. Interface is the exception.** Two real seams exist: `INoteStore`, `IGrader`. Any new interface needs an ADR.
- **No factories, no abstract base classes, no `*Manager` / `*Helper` classes** in v1. Name classes for what they do.
- **Comments answer *why*, not *what*.** If a comment paraphrases the code, delete the comment and rename the variable.

### Tests

- **Unit tests on pure logic only.** Schedulers (FSRS, diminishing revisits, linked surfacing), `RoutineGenerator`, grading-result parsing.
- **No tests on**: SQLite I/O, UI components, MAUI bootstrap, network calls.
- **xUnit + FluentAssertions.**
- **Test names**: `Method_Condition_Expected`.

### Commits

- **Conventional Commits.** `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`. Imperative voice.
- **One logical change per commit.**
- **Commit message body explains *why*, not *what*.**
- **Direct push to `main`.** No PR ceremony. (Agents do not push — see AGENTS.md.)

### CI

- **GitHub Actions on every push to `main`.**
- **Pipeline**: `dotnet restore` → `dotnet build --no-restore` → `dotnet test --no-build`.
- **Pre-commit hook**: `dotnet format` only. Tests run in CI.
- **Red CI is red CI.** If main is broken, fix it before next feature.

### Decisions

- **ADRs in [`decisions/`](./decisions/).** Every decision worth re-litigating becomes an ADR. Format: numbered, dated, with Context / Decision / Alternatives / Consequences / Revisit triggers.
- **ADRs are append-only.** To reverse a decision, write a new ADR that supersedes the old one; mark the old one's status. Never edit a locked ADR's substance.
- **Same-commit rule**: any ADR that locks a new decision or supersedes an old one MUST update this STABLE.md in the same commit.

### Anti-rules — explicitly NOT doing in v1

- ❌ No repository pattern wrapping EF Core. `DbContext` is already that.
- ❌ No CQRS / MediatR.
- ❌ No Result<T> / Either monad. Throw exceptions; let MAUI handle.
- ❌ No layered architecture folders (Domain/Application/Infrastructure/Presentation). Flat folders by feature.
- ❌ No AutoMapper. Hand-write the few mappings the app needs.
- ❌ No background workers, no message queues, no caching layer.
- ❌ No localization framework — v1 is English UI only. (Notes themselves are multilingual; the app chrome is not.)

These are v1-scoped, not lifetime bans. Each is on the table for v2 if a real need surfaces.

### Revisit triggers

The engineering principles get revisited after v1 has been used daily for ≥ 2 weeks. Concrete trigger: a bug class appears that this ruleset failed to prevent.

---

## Cross-references

- **Why decisions are what they are**: [`decisions/`](./decisions/) ADR history.
- **What's in motion right now**: [`DRAFT.md`](./DRAFT.md).
- **What's deferred**: [`BACKLOG.md`](./BACKLOG.md).
- **Rules agents must follow**: [`AGENTS.md`](./AGENTS.md).
