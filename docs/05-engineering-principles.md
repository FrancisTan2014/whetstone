# Engineering principles

The rules that govern *how* whetstone gets built. They exist to prevent two failure modes: (1) over-engineering a personal app into an unfinishable framework, and (2) shipping code that traps future-you.

If a rule below conflicts with shipping v1 daily-usable, the rule is wrong — flag it, change it.

## Code

- **Class is the default. Interface is the exception.**
  Introduce an interface only at a **real seam** — a place where a second implementation is genuinely planned or demanded by a hard requirement. Today there is one: `INoteStore` (SQLite now, remote API later). Every other class stays a plain class. No `IFooService` reflex.
- **Microsoft C# / .NET conventions.** Enforced by `.editorconfig` + `dotnet format`. No bikeshedding. Run `dotnet format` before committing — the pre-commit hook will catch you if you forget.
- **Nullable reference types: on, warnings as errors.** Bugs in null-handling are the single most common .NET defect. Day-one enforcement prevents null bugs from accumulating. Expect noise from MAUI scaffolding — suppress with `#nullable disable` only at file scope and only with a `// TODO: nullable cleanup` comment.
- **Async all the way.** Any I/O method returns `Task<T>`. No `.Result`, no `.Wait()`, no sync-over-async — those deadlock under Blazor's synchronization context.
- **One class per file. Filename matches type name.** Standard, non-negotiable.
- **Comments answer 'why,' not 'what.'** If a comment paraphrases the code below it, delete the comment and rename the variable.

## Tests

- **Unit tests on pure logic only.** Two areas:
  - `SrsEngine` — the SM-2 algorithm. Pure function, easy to test exhaustively (grade × current state → next state).
  - `RoutineGenerator` — takes a list of notes + today's date, returns the routine. Pure function. Test the cap, the prioritization, the ritual slot.
- **No tests on:** SQLite reads/writes, UI components, MAUI bootstrap, EF Core mappings. These break for real reasons the user notices immediately; mocking them adds maintenance without confidence.
- **No tests on serialization round-trips** unless a bug forces one. The export format is markdown — eyeball-readable.
- **xUnit + FluentAssertions.** Standard combo. Discovery-based, low-ceremony.
- **Test names: `Method_Condition_Expected`.** e.g., `Grade_AgainOnReviewedCard_ResetsIntervalToOne`. Reads as a sentence.

## Design patterns

- **Dependency injection** via the built-in .NET DI container. Register services in `MauiProgram.cs`. Lifetime: `Scoped` for stores, `Singleton` for pure-logic engines.
- **One interface, one implementation, one consumer** is fine. If a second implementation appears, the interface earned its keep retroactively.
- **No factories, no abstract base classes, no "manager" or "helper" classes** in v1. If a class name ends in `-Manager` or `-Helper`, it's hiding the real responsibility — name it for what it does.
- **No mediator / no event bus** in v1. Direct method calls. The app is small enough that explicit wiring is more readable than indirection.

## Decisions

- **ADRs in `/docs/decisions/`.** Every choice that future-you (or another agent) would re-litigate without context becomes an ADR. Format: numbered, dated, with Context / Decision / Alternatives / Consequences sections (see `0001-stack-and-storage.md`).
- **Not every decision is an ADR.** Naming a variable doesn't need one. "Should we use SQLite or LiteDB" does.
- **ADRs are append-only.** To reverse a decision, write a new ADR that supersedes the old one. The old one stays as a record.

## Commits

- **Conventional Commits.** `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`. Scope optional. Imperative voice ("add" not "added").
  - Example: `feat(srs): add SM-2 grade handler`
  - Example: `docs: lock v1 scope`
- **One logical change per commit.** A formatting sweep and a bug fix are two commits.
- **Pre-commit hook runs `dotnet format` only.** No tests in the hook — they run in CI. The hook keeps the diff clean; if it fails, the fix is `dotnet format` then re-commit.

## CI

- **GitHub Actions on every push to `main`.** Solo workflow: push direct to `main`, no PR ceremony.
- **Pipeline: `dotnet restore` → `dotnet build --no-restore` → `dotnet test --no-build`.**
- **Red CI is red CI.** If main is broken, fix it before the next feature.
- **No branch protection rules.** Solo project. If a teammate ever joins, add protection then.

## Anti-rules — explicitly NOT doing this in v1

- ❌ No repository pattern wrapping EF Core. `DbContext` is already that.
- ❌ No CQRS / MediatR.
- ❌ No Result<T> / Either monad. Throw exceptions; let MAUI handle.
- ❌ No layered architecture (Domain/Application/Infrastructure/Presentation folders). Flat folders by feature. Add layers when the pain demands them.
- ❌ No AutoMapper. Hand-write the 5 mappings the app needs.
- ❌ No background workers, no message queues, no caching layer.
- ❌ No localization framework — v1 is English UI only. (Notes themselves are multilingual; the app chrome is not.)

## When to revisit these rules

After v1 ships and has been used daily for two weeks. The act of using the app will surface which rules helped and which were ceremony. Revisit, prune, expand based on evidence — not speculation.
