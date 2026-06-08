# AGENTS.md

You are working on **whetstone** — a personal learning app being designed for vibe-coded implementation by future agents (you, perhaps). This file is your specification. Read it fully before doing anything in this repo.

The app does not exist yet as code. It exists as a body of locked design decisions and open questions. Your job is to extend the design or implement against it — never to substitute your judgement for what's already locked.

---

## Read first, every session

1. **This file** (AGENTS.md) — what you may and may not do.
2. **[STABLE.md](./STABLE.md)** — every locked decision. The current state of whetstone. Your single source of truth for "what is the design."
3. **[DRAFT.md](./DRAFT.md)** — what's in motion: open questions, next tasks, blocked work.

That's it. Three files, every session.

## Read on demand, when needed

- **[decisions/](./decisions/)** — append-only ADR history. Read when you need the *why* behind a current decision (e.g., considering a change that would reverse it).
- **[BACKLOG.md](./BACKLOG.md)** — deferred features. Read when the user proposes something you suspect is already deferred.
- **[README.md](./README.md)** — human-facing overview. Read only if you're updating it.

---

## The five convictions (do not weaken)

(Full text in STABLE.md → "The five convictions." Summarized here for fast reference.)

1. **Daily encounter beats sporadic effort.** Skipping is failure; shrinking is fine.
2. **Joy is fuel, not a luxury.** Ritual slots are sacred — outside recall, never graded, never skipped.
3. **Growth, not retention, is the goal.** Forgetting is data, not failure.
4. **Templates structure engagement; they do not quiz.** A scaffold for the user's writing, not a slot for the "right answer."
5. **Your past self is the rubric.** The LLM compares; the app does not prescribe truth.

When evaluating any change, ask: *does this help the user fulfill a conviction, or avoid one?* Fulfill → accept. Avoid → reject. See STABLE.md → "Decision boundary for future features."

---

## Hard stops (refuse without explicit user override)

Do not, under any circumstance, do these without the user saying so in the current session:

- **Do not introduce a new dependency** (NuGet package, npm package, anything). Propose it, explain why, wait.
- **Do not add a feature that is in [BACKLOG.md](./BACKLOG.md)** without moving it out of BACKLOG with user confirmation and (if substantive) an ADR.
- **Do not weaken a conviction.** If you believe one needs weakening, write an ADR proposing it and stop. Do not implement around it.
- **Do not weaken a rule from STABLE.md → "Engineering principles."** Same as above — propose via ADR, do not work around.
- **Do not introduce a new interface** unless the seam is real. Today there are exactly two real seams: `INoteStore` and `IGrader`. Any new interface needs an ADR. (See STABLE.md → "Class is the default. Interface is the exception.")
- **Do not push to the remote.** Commit locally. The user runs `git push`.
- **Do not run destructive git operations** (`reset --hard`, `push --force`, branch deletion, `clean -f`). If you find yourself wanting to, stop and ask.
- **Do not skip pre-commit hooks** (`--no-verify`, `--no-gpg-sign`). If a hook fails, fix the underlying issue.
- **Do not scaffold code without explicit user request.** The project skeleton has not yet been built; do not run `dotnet new` until the user says so.
- **Do not bypass cost controls.** LLM-grading code must respect the daily budget cap, per-request token cap, and visible spend log defined in STABLE.md.
- **Do not store credentials in code or commit them.** API keys live in user settings, never in source.
- **Do not commit an ADR (or any locked-decision change) without updating STABLE.md in the same commit.** The same-commit rule keeps STABLE.md trustworthy.

---

## Working norms

(Authoritative versions in STABLE.md → "Engineering principles." Summarized here.)

### Style and patterns
- Microsoft C# / .NET conventions, enforced by `dotnet format`.
- Nullable reference types: on, warnings as errors.
- One class per file. Filename matches type name.
- Async all the way. No `.Result`, no `.Wait()`.
- Class is default; interface is exception (only `INoteStore` + `IGrader`).
- No `*Manager` / `*Helper` classes. No factories. No abstract base classes in v1.
- Comments answer *why*, not *what*.

### Tests
- Unit tests on pure logic only (schedulers, routine generator, grading parser).
- No tests on SQLite I/O, UI, MAUI bootstrap, network.
- xUnit + FluentAssertions.
- Test names: `Method_Condition_Expected`.

### Commits
- Conventional Commits. Imperative voice.
- One logical change per commit.
- Body explains *why*, not *what*.
- Direct push to main. (Agents do not push.)

### Decisions
- ADR for every decision worth re-litigating. Format: Context / Decision / Alternatives / Consequences / Revisit triggers.
- ADRs are append-only. To reverse, write a new superseding ADR.
- **Same-commit rule**: ADR + STABLE.md update + (if applicable) DRAFT.md update happen in one commit.

### When you change a doc
- Update [STABLE.md](./STABLE.md) if the change locks or unlocks a decision.
- Update [DRAFT.md](./DRAFT.md) to reflect open questions, next steps, completed tasks.
- Update cross-references in any other file that references the changed content.
- Verify with `git status` before committing — stage only what you intend.

---

## How to make a decision

1. **Check if it's already decided.** Search STABLE.md and [decisions/](./decisions/). If covered, follow it.
2. **Check if it touches a conviction or hard rule.** If yes → propose an ADR, do not implement.
3. **Check if it's user-judgment territory** (scope, taste, priority). If yes → ask the user, do not assume.
4. **Implement only what's needed.** Don't add features, refactor, or introduce abstractions beyond what the task requires.
5. **If you discover the docs are wrong or contradict each other**, do not "fix" them silently. Surface the contradiction to the user.

---

## When in doubt

Ask the user. The cost of a clarification is one round-trip. The cost of a wrong assumption is a feature that has to be removed.
