# REVIEW_SPEC.md

The code-review specification for whetstone. Owned by Architect (per [COWORK.md](./COWORK.md)). This document is the *concrete* checklist used when reviewing any PR that touches code. It is built on top of:

- The general engineering principles in [STABLE.md](./STABLE.md) → "Engineering principles" (style, tests, anti-rules — already locked).
- The stack-specific research notes in [REVIEW_NOTES.md](./REVIEW_NOTES.md) (cited Microsoft Learn, EF Core docs, Anthropic API docs, Whisper.NET issue tracker).

When this document conflicts with STABLE.md, STABLE.md wins.

This is a **review** spec, not a coding spec. Developer should know it (so PRs land closer to passing first time), but Architect is the one who enforces it during PR review.

---

## How to use this document

Read in **review order**. The order is calibrated so the most-likely-to-reject things are checked first; you stop reviewing the moment you find a hard rejection and ask Developer to fix it before continuing.

1. **Gates** (sections 1-5): the things that block merge regardless of code quality. Conviction fit, scope, real-seam rule, content + admin-scope rule, same-commit rule.
2. **Stack-critical** (sections 5-10): the things this stack gets wrong most often. MAUI lifecycle/threading, Blazor rendering, EF Core, SQLite, async, nullable.
3. **Integration-specific** (sections 11-13): Anthropic, Whisper, cross-platform.
4. **Discipline** (sections 14-16): tests, secrets, commits.

When reviewing a small PR, you can skim sections that don't apply. When reviewing a substantial PR, walk the full list. **Do not pattern-match from generic OSS reviews.**

---

## Quick-reference: top 16 review checks

If a PR is too big to walk the full SPEC, at minimum check these:

1. Touches a conviction? If yes, must have ADR.
2. Touches `STABLE.md`? If yes, must have paired ADR in same commit.
3. Introduces new `interface`? Must be one of the four real seams — `INoteStore`, `IGrader`, `IAudioProcessor` (client), `IAudioBlobStore` (server) — or have an ADR.
4. Adds a prompt template, curated material, category definition, or default-setting value as an in-source string / constant? Reject — these are admin-edited server data (ADRs 0011 / 0012).
5. Introduces new dependency? Must be in `.claude/approved-deps.txt`.
6. Implements a BACKLOG.md item? Issue must have moved it out first.
7. `DbContext` field on a page / ViewModel / singleton? Bug.
8. `StateHasChanged()` inside `OnInitializedAsync` / `OnParametersSetAsync` / `[Parameter]` handler? Wrong.
9. External callback mutates component state without `InvokeAsync(...)`? Will crash.
10. `IJSObjectReference` / `DotNetObjectReference<T>` not disposed? Memory leak.
11. `new HttpClient()` at call site (vs singleton)? Wrong pattern.
12. API key from anywhere other than `SecureStorage.Default`? Security bug.
13. `Include` on two collection navigations without `AsSplitQuery()`? Cartesian explosion risk.
14. `DateTimeOffset` on a SQLite-stored entity? Client evaluation; use `DateTime` UTC or `DateOnly`.
15. `.Result` / `.Wait()` / `.GetAwaiter().GetResult()`? Banned.
16. Test references `SqliteNoteStore`, `WhisperAudioProcessor`, `AnthropicGrader`, `HttpClient`, or a Blazor component? Violates test-scope rule.

---

## Gates (block merge regardless of code quality)

### 1. Conviction fit

For each of the six convictions in STABLE.md, ask: *does this change help the user fulfill or avoid this conviction?*

- Fulfill → endorse.
- Avoid → **reject**, regardless of code quality. Comment the specific conviction violated.

Specific patterns this gate catches:

- A "skip this card" or "drop this card" button → violates #3.
- A streak counter, badge, point system, or progress percentage framed as completion → violates #3.
- A "quiz" treatment of narrative, reflection, or prose-modeling categories → violates #6.
- A silent automatic pause → violates the Pause-mechanism conviction (no silent pause).
- Hidden recall progress from the user → violates #5.
- An LLM grade or proposal that does not reference the user's original answer / Direction → violates #5 or weakens Direction's purpose.
- Voice features beyond the v1 scope in ADR 0006 (pronunciation scoring, TTS, streaming, Chinese literary scoring) → out of v1, requires v1.5/v2 ADR.

### 2. Scope fit

Read the issue this PR closes. Compare to the diff.

- Does the diff match the issue's acceptance criteria? Nothing more, nothing less.
- Did the PR sneak in scope not in the issue?
- Does the PR implement a BACKLOG.md item? If yes, has PM moved it out of BACKLOG first?

If scope is wrong, PM should be the one rejecting it. Architect's job here is to flag scope creep that PM might miss because they're focused on acceptance criteria as written.

### 3. Real-seam rule (no new interfaces without ADR)

Four real seams exist: `INoteStore`, `IGrader`, `IAudioProcessor` (client), and `IAudioBlobStore` (server, added by [ADR 0008](./decisions/0008-system-architecture.md) for host-portable audio blob storage). STABLE.md explicitly forbids new interfaces unless an ADR justifies a new real seam.

- Any new `public interface` declaration in the diff → reject unless an ADR is present.
- `IFooService` style interface-per-class → reject. Class is the default.
- Abstract base class introduced where a concrete class would do → reject.
- Factory, manager, helper, mediator classes → reject (per STABLE.md anti-rules).

### 4. Content + admin-scope rule (no agent-edited prompts, materials, categories, or settings)

Per [ADR 0011](./decisions/0011-content-as-server-data.md) and [ADR 0012](./decisions/0012-admin-role.md), curated materials / prompt templates / category definitions / default settings live as server-resident data, edited only by the human Admin. The hard stop in [AGENTS.md](./AGENTS.md) makes this binding on every agent. In code review:

- **Reject any string literal in source that looks like a prompt template** — `system:` / `user:` style multi-line strings, `{placeholder}` strings near `IGrader` call sites, or anything that reads as a prompt body. Prompts live in the `prompt_templates` server table, fetched on sync, never in source.
- **Reject any in-source list of curated materials** — chapter titles, passage texts, essay names, encounter unit catalogs. Materials live in the `materials` server table.
- **Reject any in-source category definition** — category id strings hardcoded with templates, weights, or revisit-method bindings as constants. Category definitions live in the `categories` server table.
- **Reject any in-source default setting that overrides the server value** — e.g., `const decimal DailyBudget = 0.25m` at a call site. Defaults live in `default_settings`.
- **Reject any agent-authored edit to admin-owned files** (the four data kinds above). PR shows a diff to a materials / prompts / categories / settings *seed* file or migration → reject; admin populates via the in-app admin UI.
- **The exception** is initial schema migrations that *create* the tables (`materials`, `prompt_templates`, `prompt_template_active`, `categories`, `default_settings`, `tokens`) — those are Developer's surface (code that defines the shape) and the inserts come later via the admin UI.

### 5. Same-commit rule

- If the diff touches `STABLE.md`, it must include a paired ADR in `decisions/` in the same commit. No exceptions.
- If the diff supersedes a prior ADR, the prior ADR's status must be updated in the same commit.
- If the diff touches `AGENTS.md`, `COWORK.md`, `.claude/agents/*.md`, `.claude/settings.json`, or `.claude/approved-deps.txt` — **reject**. Those files are human-only.

---

## Stack-critical (MAUI Blazor Hybrid + EF Core SQLite + async + nullable)

These are the patterns most likely to be wrong in a freshly-written PR. Read the relevant subsection when the diff touches that area.

### 6. MAUI lifecycle and threading

`MainThread`, `ConfigureAwait`, disposal, cross-thread state mutation.

**Reject if you see:**

- `if (MainThread.IsMainThread) … else BeginInvokeOnMainThread(…)` with the same body. `BeginInvokeOnMainThread` self-checks. Drop the guard.
- `BeginInvokeOnMainThread(async () => …)` — async-void inside fire-and-forget; exception observability lost. Use `await InvokeOnMainThreadAsync(…)`.
- Class outside `Pages/` or `Components/`, internal `await` without `.ConfigureAwait(false)`. Library code in `Notes/`, `Routine/`, `Grading/`, `Audio/`, `Spend/` etc. should `ConfigureAwait(false)` on every internal await.
- Page or Component using `.ConfigureAwait(false)` — wrong direction; UI continuation needs the sync context.
- Component subscribes to a non-component event (e.g., `SpendTracker.BudgetExhausted += …`) without unsubscribing in `Dispose`/`DisposeAsync` — leak.
- `CancellationTokenSource` created in a lifecycle method without `Cancel()` + `Dispose()` on disposal — leak.
- Long-running async (e.g., `IGrader.GradeAsync`) started on a page without a `CancellationToken` tied to the page's disposal — may update a disposed component.

Source: REVIEW_NOTES.md §1.

### 7. Blazor rendering and lifecycle

`StateHasChanged`, `EventCallback`, JS interop, `MarkupString`.

**Reject if you see:**

- `StateHasChanged()` inside `OnInitializedAsync`, `OnParametersSetAsync`, or any `[Parameter]`-driven handler. `ComponentBase` does it automatically; the explicit call is "a common mistake that imposes unnecessary rendering costs" (Microsoft Learn).
- Mutating component state from a non-component callback (timer fired, `IGrader` completion, `SpendTracker` event, `IAudioProcessor` finished) without `await InvokeAsync(() => { ...mutate...; StateHasChanged(); })`. Will throw `InvalidOperationException: The current thread is not associated with the Dispatcher`.
- Component parameter typed `Action<T>` or `Func<T>` where the parent should re-render after firing → use `EventCallback<T>` (framework auto-renders).
- `MarkupString` rendering text from `IGrader` (mirror response, encounter rationale, vocabulary card) or any source the user didn't author → XSS. Default to text.
- `@key="@i"` (loop index) or any unstable key on a `@foreach` list → use the item's stable ID. Unstable keys break input focus and form state.
- `IJSObjectReference` field not disposed; component lacks `@implements IAsyncDisposable` despite using JS interop.
- `DotNetObjectReference.Create(this)` not disposed → GC root leaks the component.
- `IJSRuntime` injected into a singleton service → JS interop must originate from a component or via `BlazorWebView.TryDispatchAsync`.
- `IJSRuntime` used in `OnInitializedAsync` → JS interop unavailable until after first render. Use `OnAfterRenderAsync(firstRender)`.
- Comments mentioning `@rendermode` directives → Blazor Hybrid doesn't use render modes; the comment is wrong.

Source: REVIEW_NOTES.md §2.

### 8. EF Core in `SqliteNoteStore`

`DbContext` lifetime, queries, SQLite limitations.

**Reject if you see:**

- `DbContext` field on a page, ViewModel, or singleton. `DbContext` is not thread-safe; constructed inside the data class, per-operation.
- `DbContext` accessed outside `SqliteNoteStore` (or wherever the single seam implementation lives). The `INoteStore` interface is the only contract code may depend on for persistence.
- Entity property typed `DateTimeOffset`. SQLite has no native support; EF Core client-evaluates comparisons/ordering. Use `DateTime` in UTC (`Kind = Utc`) or `DateOnly`.
- Entity property typed `decimal` without a value converter (SQLite has no native `decimal`). Use `double` or integer cents.
- Entity property typed `TimeSpan` or `ulong` — SQLite has no native support.
- `.Include(n => n.A).Include(n => n.B)` where both are collection navigations and the result is sizeable → ask if `AsSplitQuery()` belongs (cartesian explosion).
- `foreach (var x in entities) { var y = x.SomeNavigationProperty; … }` without that property being `Include`d → N+1.
- `SaveChangesAsync` not awaited immediately (`var task = SaveChangesAsync(); doStuff; await task`) — corrupts the context per EF Core docs.
- `catch (Exception)` around `SaveChangesAsync` that swallows — STABLE.md anti-rule; throw, don't swallow.
- `[Timestamp]` / `[ConcurrencyCheck]` on a v1 entity — concurrency tokens are unnecessary for a single-user local app.
- `.UseLazyLoadingProxies()` — EF Core docs explicitly recommend against it.
- Query returning the entire entity when one column is used — apply EF's "project only what you need."
- Manual `BEGIN TRANSACTION` alongside `SaveChangesAsync` — double-transaction. `SaveChangesAsync` already wraps.
- Migration applied on app launch that requires table rebuild without checking the DB isn't open elsewhere.

Source: REVIEW_NOTES.md §3.

### 9. SQLite configuration

Connection strings, WAL, pooling.

**Reject if you see:**

- Connection string has both `Cache=Shared` and WAL enabled. Microsoft docs explicitly warn this is "discouraged."
- `Pooling=False` — almost always a mistake. Pooling reduces the cost of the "DbContext per operation" pattern.
- `Password=` in a connection string. Microsoft.Data.Sqlite supports it but the default native library doesn't implement encryption; silently broken. If real encryption is wanted, that's an ADR (SQLCipher needs approved-deps).
- File path hardcoded; should be `Path.Combine(FileSystem.AppDataDirectory, "whetstone.db")`.

Source: REVIEW_NOTES.md §4.

### 10. Async patterns

Beyond the locked "no `.Result`, no `.Wait()`" rule.

**Reject if you see:**

- `.Result`, `.Wait()`, `.GetAwaiter().GetResult()` — sync-over-async deadlock vector. STABLE.md ban.
- `async void` outside an event handler — "ALWAYS bad" per David Fowler's guidance.
- `Task.Run(() => SomeAsyncMethod())` wrapping an already-async method — usually redundant.
- `Task.WhenAll(ctx.X.AddAsync(a), ctx.X.AddAsync(b))` against the same `DbContext` — undefined behaviour per EF Core docs.
- Async method with `CancellationToken` parameter that doesn't forward it — CA2016.
- Method returning `ValueTask<T>` without a documented hot-path reason — `ValueTask<T>` is a single-use type; default to `Task<T>` for interfaces and most code.
- Long-running blocking work in `Task.Run` — `Task.Run` steals thread-pool threads. Use a dedicated `Thread` with `IsBackground=true` per David Fowler.
- `TaskCompletionSource` without `TaskCreationOptions.RunContinuationsAsynchronously`.

Source: REVIEW_NOTES.md §5.

### 11. Nullable reference types

Beyond the locked "warnings as errors" rule.

**Reject if you see:**

- `!` operator on a cross-class boundary — ask if a null check or `??` would work. Every `!` is a place the compiler can no longer protect you.
- `default!` on anything other than an EF Core navigation property — ask if it's safe at runtime.
- `string? foo = …; var x = foo!.Substring(…)` immediately after assignment — restructure to make the non-null branch explicit.
- `new Note[n]` for reference type arrays — leaves elements null without warning. Use collection expressions `[…]` or `List<Note>`.
- Constructor takes nullable parameters but assigns to non-nullable fields without checks — real bug, no compiler warning.
- `[NotNull]`/`[MaybeNull]`/`[NotNullWhen(true)]` sprinkled without a TryParse-style reason — obscures intent.

Source: REVIEW_NOTES.md §6.

---

## Integration-specific

### 12. Anthropic API integration (`AnthropicGrader`)

**Reject if you see:**

- `new HttpClient()` at the call site. Use singleton `HttpClient` with `SocketsHttpHandler { PooledConnectionLifetime = TimeSpan.FromMinutes(15) }`. `IHttpClientFactory` requires approved-deps (`Microsoft.Extensions.Http`).
- API key from `Preferences`, environment variable, settings file, or hardcoded. Must use `SecureStorage.Default`.
- API key in a checked-in file. (Hook should block but verify in diff.)
- Streaming response read as a complete string then parsed. Use `HttpCompletionOption.ResponseHeadersRead` and line-by-line SSE processing.
- `catch (Exception)` that swallows. Sanctioned conversion is "`IGrader` failure → user offered self-grade," handled at the page, not the grader.
- `request-id` header not logged on failure. Every Anthropic response carries one; essential for debugging.
- `cache_control: { type: "ephemeral" }` set on a request whose cacheable prefix is under the model's minimum (4,096 tokens for Haiku 4.5; 1,024 for Sonnet/Opus) — silent no-op.
- `SpendTracker.Record` called before the request completes successfully — records cost for failed requests.
- `SpendTracker.Record` doesn't distinguish `cache_read_input_tokens` (0.1× base rate) from regular input. Reading the `usage` block on response is mandatory.
- Retry logic that retries 4xx errors (except 429) — wrong; only 429 and 5xx should retry. No documented `Retry-After`; exponential backoff with jitter.
- HTTP error → `IGrader` returns a "success" result. Errors must propagate (and the page handles fallback to self-grade).

Source: REVIEW_NOTES.md §7.

### 13. Whisper-local integration (`WhisperAudioProcessor`)

This is the thinnest-evidence area in the SPEC. Any Whisper-touching diff gets extra scrutiny.

**Reject if you see:**

- `WhisperAudioProcessor` registered as `Transient` or `Scoped`. Must be `Singleton`; model held as a field; loaded once at startup.
- Whisper model loaded inside `TranscribeAsync` rather than at processor construction.
- Transcription called from `OnInitializedAsync` or any UI-thread synchronous path. Long-running; must be `await`ed off the UI thread (which `await` accomplishes when called from an async method).
- `#if ANDROID` / `#if IOS` blocks added for Whisper without explicit human review. Mobile Whisper integration is the highest-risk area per the Whisper.NET issue tracker (DllNotFoundException, codesign failures, App Store rejections). v1 ships desktop-first per STABLE.md; mobile Whisper work is v1.5+.
- Audio recording without `Permissions.RequestAsync<Permissions.Microphone>()`.
- Microphone permission request without checking `Permissions.CheckStatusAsync` first.
- Microphone permission requested from `MauiProgram.CreateMauiApp` or `App` constructor — must request after first page appears.
- Missing Android manifest permission or iOS Info.plist `NSMicrophoneUsageDescription`.
- Long audio held entirely in memory rather than disk-backed. Diary entries can be long.
- Audio file path not under `FileSystem.AppDataDirectory` or `FileSystem.CacheDirectory`.

Source: REVIEW_NOTES.md §8.

### 14. Cross-platform concerns

**Reject if you see:**

- Hardcoded `"\\"` or `"/"` in a path — use `Path.Combine`.
- `double.Parse(s)` / `decimal.Parse(s)` / `DateTime.Parse(s)` without `CultureInfo.InvariantCulture` for non-user-input. Spend log CSV, exports, frontmatter — all use invariant.
- New `DateTime` field without explicit `Kind = DateTimeKind.Utc` handling. `Unspecified` is a portability bug per Microsoft docs.
- New `DateTimeOffset` field on a SQLite entity — see §8.
- Locale-sensitive comparison (`string.Equals(a, b)`) without `StringComparison.Ordinal` for identifier-like data.

Source: REVIEW_NOTES.md §10.

---

## Discipline

### 15. Tests

STABLE.md locks "unit tests on pure logic only." Concretely:

**What gets tested (Developer writes these in the PR):**

- `FsrsScheduler`, `DiminishingScheduler`, `LinkedSurfacingScheduler` — the four revisit-scheduling algorithms.
- `RoutineGenerator` — the interleaving + cap + pause-skip logic.
- `EchoComposer` — the weekly-Echo selection logic.
- Grading-result parsers (LLM response → `Forgot/Partial/Solid/Stronger`).
- Mirror-response parsers (LLM response → user-facing paragraph).
- Vocabulary-card generation prompt builders.

**What does NOT get tested (reject if you see tests on these):**

- `SqliteNoteStore`, `DbContext`, EF Core mappings.
- `WhisperAudioProcessor`, `AnthropicGrader`, `HttpClient`.
- MAUI bootstrap.
- Blazor pages/components.

**Reject if you see:**

- Test references `SqliteNoteStore`, `DbContext`, `HttpClient`, `WhisperAudioProcessor`, `AnthropicGrader`, or a MAUI page/component.
- Test uses a mocking framework (Moq, NSubstitute, FakeItEasy). None are on approved-deps. Hand-written fakes for the four real seams instead.
- Test asserts on `DateTime.UtcNow` rather than the passed `DateOnly today` (or equivalent injected time). Pure schedulers must be deterministic.
- Test sleeps to wait for async (`Thread.Sleep`, `await Task.Delay`). Await tasks directly.
- Test depends on network or filesystem.
- Test name doesn't match `Method_Condition_Expected` — minor; comment, don't reject.

Source: REVIEW_NOTES.md §9.

### 16. Secrets and approved dependencies

**Reject if you see:**

- API key, token, password, connection-string-with-credentials hardcoded or in any committed file. (Hook should block; verify.)
- `dotnet add package`, `npm install`, or equivalent for a package not in `.claude/approved-deps.txt`. (Hook should block; verify.)
- Adding to `.claude/approved-deps.txt` in a PR — that file is human-only. Approved-deps additions are human-only, separate commit.
- `using` directive added for a NuGet package not present in `.csproj` — implicit dependency.

### 17. Commits

**Reject if you see:**

- Commit messages that don't match Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, imperative voice).
- Commit body that paraphrases the *what* of the diff. Body must explain *why*.
- A single commit doing multiple unrelated logical changes — request split.
- `--no-verify` or `--no-gpg-sign` used to commit. (Hook should block; verify in `git log`.)
- Format-only changes mixed with feature changes — request separation.

---

## What the SPEC does NOT cover

Style and idiom decisions explicitly left to `dotnet format` / `.editorconfig`. Don't comment on these in PR review:

- Brace placement, indentation, line length.
- Variable naming style (`camelCase` / `PascalCase` / `_underscoreField`) — formatter enforces.
- `var` vs explicit type.
- Use of expression-bodied members.
- "Could be DRY-er" comments on three similar lines. Three similar lines is fine.
- Suggested helper extractions where the helper would have no clear responsibility.
- Future-proofing for hypothetical requirements.
- Defensive null checks beyond system boundaries.

---

## Analyzer rules that enforce parts of this SPEC

When the project skeleton is built, enable these via `.editorconfig` (severity = `error` for the strictest ones, `warning` for the rest). All ship with .NET 8/9 when `EnableNETAnalyzers` is on (default).

| Rule | What it catches | Severity |
|---|---|---|
| **CA1031** | `catch (Exception)` that swallows | error |
| **CA1849** | Sync method called on object with async equivalent | error |
| **CA2007** | `await` without `ConfigureAwait` (configure to exclude pages/components) | warning |
| **CA2012** | `ValueTask` used incorrectly | error |
| **CA2016** | `CancellationToken` not forwarded | error |
| **CA2000** | Disposable not disposed | error |
| **CA1416** | API used on unsupported platform | error |

Plus EF Core runtime diagnostics in development builds:

```csharp
optionsBuilder.ConfigureWarnings(b => b.Throw(RelationalEventId.MultipleCollectionIncludeWarning));
```

These fire at runtime when problematic queries execute — surfaces cartesian explosions in dev rather than prod.

---

## How to give review feedback

Match the gravity of the feedback to the gravity of the issue.

- **Hard reject** (must fix before merge): conviction violation, scope creep, real-seam violation, content + admin-scope violation (agent-edited prompt / material / category / setting, or any of those four in-source as constants), same-commit violation, security bug, async deadlock vector, leak, banned anti-rule.
- **Soft reject** (should fix, willing to discuss): stack-specific patterns from §6-14 that aren't catastrophic but are clearly worse than the alternative.
- **Comment** (nice to fix, no merge block): naming, test-name format, minor formatting.

Use evidence over assertion. When rejecting, cite the SPEC section, the source (Microsoft Learn URL, STABLE.md anchor), or the analyzer rule ID. "This is wrong" is not a review comment. "Per CA2016, every `CancellationToken` parameter should be forwarded; here `await foo.BarAsync()` should be `await foo.BarAsync(ct)`" is.

After two unresolved iterations on the same comment, escalate to human per COWORK.md's conflict-resolution rule.

---

## Revisit triggers

This SPEC gets revisited when:

- A class of bug surfaces in production that the SPEC failed to catch.
- A locked dependency changes (e.g., approved-deps gets `Microsoft.Extensions.Http`, changing the HttpClient pattern in §11).
- An anti-rule in STABLE.md is relaxed (e.g., AutoMapper enters v2) — the SPEC removes the corresponding reject pattern.
- Whisper-local integration matures (v1.5+); the §12 caveats can soften.
- Anthropic pricing or caching minimums change (the 4,096-token Haiku minimum in §11 is most likely to rot).

Updates to this SPEC require an ADR per the same-commit rule.

---

## Cross-references

- [STABLE.md](./STABLE.md) — locked design and engineering principles.
- [REVIEW_NOTES.md](./REVIEW_NOTES.md) — the research notes this SPEC was built from. Treat as background, not as authoritative — this SPEC is the policy.
- [AGENTS.md](./AGENTS.md) — repo-level rules.
- [COWORK.md](./COWORK.md) — Architect owns code review per ADR 0008.
- [decisions/0009-review-spec.md](./decisions/0009-review-spec.md) — ADR for this SPEC's existence and Architect's expanded scope.
