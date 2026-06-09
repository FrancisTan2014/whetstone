# REVIEW_NOTES.md

> Research notes informing whetstone's code review SPEC. Produced 2026-06-09 by a research agent. Not the final SPEC — these notes will be synthesised into REVIEW_SPEC.md.

## How to read this document

Research, not policy. Grounded in cited Microsoft Learn, .NET team blogs, EF Core docs, Anthropic API docs, and Whisper.net's GitHub issue tracker — supplemented with training-data knowledge where the evidence base is genuinely thin (called out explicitly). Each section frames the question, summarises what the evidence says, then lists **review heuristics** in the form "if you see X in a diff, ask Y." The Architect should use this material alongside STABLE.md's existing engineering principles, which already cover generic C# style, async basics, nullable, one-class-per-file, test scope, and the three-seam rule. The goal here is the **second layer**: things that catch MAUI-, Blazor-, EF Core-, SQLite-on-mobile-, and Anthropic-integration-specific bugs that generic C# heuristics miss.

The document does **not** recommend new dependencies. `.claude/approved-deps.txt` is empty; even battle-tested packages (Polly, Refit, IHttpClientFactory's full pipeline, mocking frameworks) need a human-approved ADR.

---

## TL;DR — highest-leverage review checks

For a single-pass review, look for these. They are the things that most often go wrong in this stack.

1. **`DbContext` lifetime.** Per-operation, short-lived, constructed inside `SqliteNoteStore` (STABLE.md is correct). Singleton/shared/long-lived `DbContext` is a bug.
2. **Forgotten or excess `StateHasChanged`.** Either the state mutates after `await` and never re-renders, or it's sprinkled everywhere "to be safe" and causes render churn.
3. **External callback (timer, `IGrader` continuation, `IAudioProcessor` completion) mutates component state without `InvokeAsync(() => { …; StateHasChanged(); })`.** Throws "current thread is not associated with the Dispatcher" or silently fails to render.
4. **`IJSObjectReference` / `DotNetObjectReference<T>` not disposed.** GC root; leaks the component. Component must `@implements IAsyncDisposable`.
5. **`.Result`, `.Wait()`, `.GetAwaiter().GetResult()`.** STABLE.md already bans; verify on every PR.
6. **`new HttpClient()` per call for Anthropic.** Singleton with `PooledConnectionLifetime` or `IHttpClientFactory` (latter requires approved-deps addition).
7. **API key in code, config, or a checked-in file.** Must use `SecureStorage.Default`.
8. **`CancellationToken` not propagated** (CA2016).
9. **`Include` chains with multiple collection navigations** (cartesian explosion) without `AsSplitQuery`; or visible N+1 — a `foreach` over an entity touching a navigation property.
10. **`SaveChangesAsync` not awaited immediately** (corrupts the context per EF Core docs); or wrapped in `catch (Exception)` that swallows.
11. **`MarkupString` rendering untrusted text** — for whetstone, the realistic risk is LLM output rendered unsanitised.
12. **Whisper model loaded per transcription rather than once at startup.** Models are 100-500 MB.
13. **A new `interface` introduced without an ADR.** Hard stop per AGENTS.md.
14. **`DateTime` (no `Kind`) or `DateTimeOffset` crossing the SQLite boundary.** SQLite has no native `DateTimeOffset`; EF Core client-evaluates ordering/comparison.
15. **Long-running async work on a page without cancellation tied to disposal.** Survives navigation, may update a disposed component.

---

## 1. MAUI lifecycle and threading

**Question:** what's different about threading in MAUI that generic C# review doesn't catch?

**Findings.**

- `MainThread.BeginInvokeOnMainThread` self-checks whether it's already on the UI thread — **no `IsMainThread` guard is needed** before calling it ([Microsoft Learn: Main thread](https://learn.microsoft.com/en-us/dotnet/maui/platform-integration/appmodel/main-thread)). Reviewers who insist on the guard are adding noise.
- Surface: `BeginInvokeOnMainThread(Action)` (fire-and-forget, exceptions lost), `InvokeOnMainThreadAsync(Action | Func<Task> | Func<T> | Func<Task<T>>)` (awaitable, propagates exceptions).
- `ConfigureAwait(false)` is appropriate in **library code** (CA2007 — [Microsoft Learn: CA2007](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2007)). It is **wrong** in app code that needs the UI context after the await. For whetstone: code in `Notes/`, `Routine/`, `Grading/`, `Audio/`, `Spend/`, etc. should `ConfigureAwait(false)` on every internal await. Pages and components should not.
- Disposal: long-running async captured by a page must check disposal or use a `CancellationTokenSource` cancelled in disposal ([Microsoft Learn: Blazor synchronization context](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/synchronization-context?view=aspnetcore-9.0)).

**Review heuristics.**

- `if (MainThread.IsMainThread) … else BeginInvokeOnMainThread(…)` with the same body — drop the guard.
- `BeginInvokeOnMainThread(async () => …)` — exception observability lost; prefer `await InvokeOnMainThreadAsync(…)`.
- Class outside `Pages/` or `Components/`, internal `await` without `.ConfigureAwait(false)` — flag.
- Component subscribes to a non-component event (`SpendTracker.BudgetExhausted += …`) without a matching unsubscribe in `Dispose` — leak.
- `CancellationTokenSource` created in a lifecycle method without `Cancel()` + `Dispose()` on disposal — leak.

Strong evidence (all Microsoft Learn). Most likely to violate in whetstone: `IGrader` and `IAudioProcessor` callers — long-running async that may complete after the user navigated away.

---

## 2. Blazor Hybrid specifics

**Question:** Hybrid is neither Blazor Server nor WebAssembly. What changes?

**Findings.**

- In Hybrid, components run **natively on the device**, rendering to an embedded WebView via local interop ([Microsoft Learn: Blazor Hybrid](https://learn.microsoft.com/en-us/aspnet/core/blazor/hybrid/)). No WebAssembly. No SignalR circuit. **No prerendering.** `JSDisconnectedException` is rare here (no circuit to lose) but try/catch on dispose is still cheap insurance.
- `StateHasChanged` is called automatically for `EventCallback` methods ([Microsoft Learn: Razor component rendering](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/rendering?view=aspnetcore-9.0)). **Not** for plain `Action`/`Func<Task>` parameters. This is why `EventCallback<T>` is preferred — the framework wires re-render for you. The Microsoft docs explicitly say: "**Prefer the strongly typed `EventCallback<TValue>` over `EventCallback`.**"
- `StateHasChanged` should *not* be called in ordinary event handlers or `OnInitializedAsync` / `OnParametersSetAsync` — `ComponentBase` does it ([rendering docs: "a common mistake that imposes unnecessary rendering costs"](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/rendering)). It **is** needed for: (a) async methods with multiple intermediate await points where you want intermediate renders; (b) external callbacks outside Blazor's sync context (timer, `SpendTracker` event); (c) rendering a component outside the receiving subtree.
- For (b), call site must be `await InvokeAsync(() => { …mutate…; StateHasChanged(); })`. Calling off-dispatcher throws `InvalidOperationException: The current thread is not associated with the Dispatcher.`
- `OnAfterRender(Async)` is where JS interop work happens; the `firstRender` parameter guards one-time init. Returning a Task from `OnAfterRenderAsync` does **not** auto-render — by design to prevent infinite loops.
- `IJSObjectReference` and `DotNetObjectReference<T>` must be disposed ([Microsoft Learn: Call .NET from JS](https://learn.microsoft.com/en-us/aspnet/core/blazor/javascript-interoperability/call-dotnet-from-javascript?view=aspnetcore-9.0)). `DotNetObjectReference.Create(this)` is a GC root holding the component.
- Render modes (Interactive Server / WebAssembly / Auto) **do not apply** to Blazor Hybrid. Don't comment on missing `@rendermode` directives.
- STABLE.md's "constructor injection only … Pages use Blazor's `[Inject]`" is correct: pages get `[Inject]`, services get constructor injection.

**Review heuristics.**

- Component parameter typed `Action<T>` (not `EventCallback<T>`) where the parent should re-render after firing — flag.
- `StateHasChanged()` inside `OnInitializedAsync`, `OnParametersSetAsync`, or any `[Parameter]`-driven handler — almost always wrong.
- `StateHasChanged()` not preceded by `InvokeAsync(…)` inside a callback that may originate off-dispatcher — flag.
- LLM output rendered as `MarkupString` — flag. Mirror responses, vocabulary cards, encounter rationales all flow from `IGrader`. Default to text.
- `@key="@item.SomeIndex"` (or any unstable key) on a `@foreach` list — use the item's stable ID. Unstable keys break input focus and form state.
- `IJSRuntime` injected into a singleton service — flag; JS interop must originate from a component or via `BlazorWebView.TryDispatchAsync`.
- `IJSRuntime` used in `OnInitializedAsync` — flag; JS interop is unavailable until after first render.

Strong evidence for documented behaviour, moderate for "what idiomatic Hybrid looks like in 2026" — framework is still maturing. Hot spots in whetstone: the routine page, revisit/encounter modals, the spend log/pause UI reacting to `SpendTracker` and `INoteStore` events, and `VocabularyCapture` (the JS interop hot spot for one-tap highlight).

---

## 3. EF Core 8/9 in this stack

**Question:** EF Core's docs are ASP.NET-first. Where does that bias trip up a single-user MAUI app?

**Findings.**

- `DbContext` is **not thread-safe**, designed for short-lived unit-of-work ([Microsoft Learn: DbContext lifetime](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/)). In ASP.NET that's scoped-per-request; in MAUI there's no request scope. Two clean patterns: `IDbContextFactory<T>` injection, or constructing the context inside the data class — which is what STABLE.md prescribes. The MAUI sample Microsoft ships actually uses sqlite-net-pcl, not EF Core ([Microsoft Learn: MAUI local databases](https://learn.microsoft.com/en-us/dotnet/maui/data-cloud/database-sqlite)); note this when reviewing patterns claimed as "standard."
- Database path: `Path.Combine(FileSystem.AppDataDirectory, DatabaseFilename)`. Don't use any other root.
- Migrations: `Database.MigrateAsync()` is fine; must be awaited; must not run from a constructor; must complete before any DbContext use.
- SQLite limitations relevant here ([Microsoft Learn: SQLite limitations](https://learn.microsoft.com/en-us/ef/core/providers/sqlite/limitations)):
  - **No native `DateTimeOffset`.** EF Core stores/reads, but comparisons/ordering happen client-side. Microsoft explicitly recommends "use `DateTime` values [in UTC]." Tension with general .NET guidance.
  - **No native `decimal`.** Workaround: value converter to `double`. For whetstone's `SpendTracker` dollars, use `double` or store integer cents.
  - **No `TimeSpan`, no `ulong`.**
  - **Migrations limitations** — most schema operations require a table rebuild.
  - **EF 9 introduced `__EFMigrationsLock`** to prevent concurrent migrations. Process killed mid-migration leaves a stale lock; docs say to `DROP TABLE "__EFMigrationsLock"` to recover.
- `AsNoTracking()` for read-only ([Microsoft Learn: Tracking vs no-tracking](https://learn.microsoft.com/en-us/ef/core/querying/tracking)). Documented benchmark: ~30% time saving, ~40% allocation saving.
- N+1: EF Core's docs explicitly say "Because lazy loading makes it extremely easy to inadvertently trigger the N+1 problem, **it is recommended to avoid it**" ([Microsoft Learn: Efficient querying](https://learn.microsoft.com/en-us/ef/core/performance/efficient-querying)). Whetstone should not call `.UseLazyLoadingProxies()`. Without lazy loading, N+1 surfaces whenever code touches a navigation property in a loop without `Include`.
- Cartesian explosion: `Include` on multiple collection navigations multiplies rows. Use `.AsSplitQuery()`.
- Transactions: SQLite is single-writer. EF Core wraps each `SaveChangesAsync` in a transaction by default. Manual transactions are needed only for grouping multiple `SaveChanges` calls atomically. Concurrency tokens are unnecessary for a single-user local app.
- `SaveChangesAsync` should always be awaited immediately — failing to do so corrupts the context per the docs.

**Review heuristics.**

- Entity property typed `DateTimeOffset` — flag; SQLite client-evaluates. Use `DateTime` in UTC (set `Kind = Utc`) or `DateOnly`.
- Entity property typed `decimal` without a value converter — flag.
- `_context.Notes.Include(n => n.Vocabulary).Include(n => n.Links)…` if both are collection navigations and the result is sizeable — ask if `AsSplitQuery()` belongs.
- `foreach (var x in entities) { var y = x.SomeNavigationProperty; … }` without that property being `Include`d — N+1.
- `SaveChangesAsync` called without `await` — bug.
- `DbContext` field on a page, ViewModel, or singleton — bug.
- `[Timestamp]` / `[ConcurrencyCheck]` added to a v1 entity — flag.
- Migration requiring rebuild applied without checking the DB isn't open elsewhere — flag.
- Query returning the entire entity when one column is used — Microsoft's "Project only what you need" guidance applies.

Strong evidence. `SqliteNoteStore` is the *only* place EF Core lives in whetstone — that's the right shape; any diff that pushes `DbContext` outside it is wrong.

---

## 4. SQLite on mobile / desktop

**Question:** what about SQLite itself, beyond EF Core?

**Findings.**

- **WAL mode**: "WAL can be faster for local databases because readers and writers do not block each other" ([Microsoft Learn: MAUI local databases](https://learn.microsoft.com/en-us/dotnet/maui/data-cloud/database-sqlite)). Adds two sidecar files (`.shm`, `.wal`). The connection-string docs ([Microsoft Learn: SQLite connection strings](https://learn.microsoft.com/en-us/dotnet/standard/data/sqlite/connection-strings)) explicitly warn: "Mixing shared-cache mode and write-ahead logging is discouraged." WAL is the right default for single-user apps.
- **Encryption**: Microsoft.Data.Sqlite supports `Password=`, but it "has no effect when encryption isn't supported by the native SQLite library" — and the default native library does **not** support encryption. Real encryption requires SQLCipher (not in approved-deps). STABLE.md doesn't require encryption for v1; adding it needs ADR.
- **Backup**: with WAL on, close all connections, then copy `.db`, `.db-shm`, `.db-wal` together.
- **Connection pooling**: `Pooling=True` is the default. Don't disable it — it reduces the cost of the "DbContext per operation" pattern.
- **Vacuum cadence**: SQLite reclaims free pages lazily. `VACUUM` rewrites the database. Mobile convention is on app close or at user-driven points (the export action is a natural moment); not formally documented.
- **iOS data-protection flags** (`ProtectionComplete`, etc.) are SQLite-side encryption-at-rest keyed to device lock — different from row-level encryption. Relevant only when mobile build re-enters v1 scope.

**Review heuristics.**

- Connection string has both `Cache=Shared` and WAL enabled — flag.
- `Pooling=False` — almost always a mistake.
- Manual `BEGIN TRANSACTION` / raw SQL transaction alongside `SaveChangesAsync` — flag; double-transaction.
- `Password=` in a connection string — almost certainly broken (no encryption support); reroute to an encryption ADR if the user wants it.

Strong evidence on connection strings, WAL, pooling. Thinner on vacuum cadence (convention).

---

## 5. Async patterns

**Question:** beyond "no `.Result`, no `.Wait()`" (already locked), what?

**Findings.**

- `ValueTask<T>` is a footgun for general use ([Stephen Toub: Understanding ValueTask](https://devblogs.microsoft.com/dotnet/understanding-the-whys-whats-and-whens-of-valuetask/)). Single-use rule: "await it directly … or call `AsTask()` … and then never use it again." Use only on documented hot paths that often complete synchronously, or in interfaces meant for diverse implementations (e.g., `IAsyncDisposable.DisposeAsync`). For whetstone's seams, default to `Task<T>`.
- CA2016: every async method that takes a `CancellationToken` should forward it.
- David Fowler's guidance ([AsyncGuidance](https://github.com/davidfowl/AspNetCoreDiagnosticScenarios/blob/master/AsyncGuidance.md)):
  - `async void` is "ALWAYS bad" except for event handlers.
  - Long-running blocking work: dedicated `Thread` with `IsBackground=true`, **not** `Task.Run` (which steals thread-pool threads meant for short work) and **not** `TaskCreationOptions.LongRunning` with async (the long-running thread is destroyed at the first `await`).
  - Always dispose timeout-based `CancellationTokenSource`. On .NET 6+, prefer `Task.WaitAsync(timeout)`.
  - `TaskCompletionSource` should use `TaskCreationOptions.RunContinuationsAsynchronously`.
- `IAsyncEnumerable<T>` for SQLite: appropriate only when the result set is genuinely large and processed item-by-item. Whetstone's queries (today's routine, this month's spend) are small — `Task<List<T>>` is fine.
- `Task.WhenAll` against the same `DbContext` is undefined behaviour per EF Core docs. Parallel reads against different context instances are fine.

**Review heuristics.**

- Method returns `ValueTask<T>` — ask: hot path? Caller awaits once and only once?
- `async void` outside an event handler — flag.
- `Task.Run(() => SomeAsyncMethod())` — usually redundant; just `await`.
- `Task.WhenAll(ctx.X.AddAsync(a), ctx.X.AddAsync(b))` — bug.
- Async method with `CancellationToken` parameter that doesn't forward it — CA2016.

Strong evidence.

---

## 6. Nullable reference types

**Question:** the rule is locked ("on, warnings as errors"). What does a reviewer look for in practice?

**Findings.**

- The `!` operator: "use sparingly. Each occurrence is a place the compiler can no longer protect you" ([Microsoft Learn: Nullable reference types](https://learn.microsoft.com/en-us/dotnet/csharp/fundamentals/null-safety/nullable-reference-types)). Prefer a null check, restructuring, or a contract annotation.
- `default!` is the standard EF Core navigation-property workaround (compiler can't see that EF populates them). Legitimate but should be limited to that case or to `required`-equivalent workarounds.
- Documented limitations where the compiler **does not** warn:
  - Default-initialised structs leave reference fields null. Use `required` members or parameterised constructors.
  - `new T[n]` for a reference type leaves elements null. Use collection expressions `[a, b, c]`.
- `[NotNull]`, `[MaybeNull]`, `[NotNullWhen(true)]` are useful with a *reason* (TryParse-style). Sprinkled at random they obscure intent.

**Review heuristics.**

- `!` operator on a cross-class boundary — ask if a null check or `??` would work.
- `default!` on anything other than an EF navigation property — ask if it's safe at runtime.
- `string? foo = …; var x = foo!.Substring(…)` immediately after assignment — restructure.
- New `Note[]` or similar — initialise inline.
- Constructor takes nullable parameters but assigns to non-nullable fields without checks — real bug.

Strong evidence. In whetstone, watch for `!` creeping into the schedulers and `RoutineGenerator` (pure logic), where it's almost always smell.

---

## 7. Anthropic API integration

**Question:** what to look for in `AnthropicGrader` specifically?

**Findings.**

- **Error model** ([Anthropic API errors](https://docs.anthropic.com/en/api/errors)): 400 invalid_request, 401 auth, 402 billing, 403 permission, 404 not_found, 413 request_too_large (32 MB on Messages API), 429 rate_limit, 500 api_error, 504 timeout, 529 overloaded. Every response carries a `request-id` header — log it on failure. No documented `Retry-After`; exponential backoff with jitter is the standard pattern.
- **Streaming Messages API** ([streaming docs](https://docs.anthropic.com/en/docs/build-with-claude/streaming)): SSE events are `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`, plus `ping` and `error` events that may arrive **after** a 200 response. The official `Anthropic` NuGet C# SDK would need approved-deps + ADR.
- **Prompt caching** ([caching docs](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)): minimums by model — **4,096 tokens for Haiku 4.5** (whetstone's default per STABLE.md), 1,024 for Sonnet 4.5/4.6 and Opus 4. Cache reads are 0.1× base input cost; writes are 1.25× (5-min TTL) or 2× (1-hour TTL). Hits verified via `usage.cache_read_input_tokens` and `usage.cache_creation_input_tokens`. Breakpoint set via `cache_control: { type: "ephemeral" }`. Worth doing only if the cacheable prefix meets the minimum — likely not worth it for whetstone's per-call grading prompts unless the system + rubric exceeds 4,096 tokens.
- **HttpClient lifetime** ([Microsoft Learn: HttpClient guidelines](https://learn.microsoft.com/en-us/dotnet/fundamentals/networking/http/httpclient-guidelines)): two acceptable patterns — singleton with `SocketsHttpHandler { PooledConnectionLifetime = TimeSpan.FromMinutes(15) }`, or `IHttpClientFactory`. For a single-user app hitting one host, the singleton + pooled lifetime is the simplest defensible pattern and avoids the `Microsoft.Extensions.Http` dependency if it's not on approved-deps.
- **Secrets** ([Microsoft Learn: SecureStorage](https://learn.microsoft.com/en-us/dotnet/maui/platform-integration/storage/secure-storage?view=net-maui-9.0)): `SecureStorage.Default` maps to Keychain (iOS/Mac), `EncryptedSharedPreferences` (Android), `DataProtectionProvider` (Windows). Documented gotchas:
  - Android Auto Backup may corrupt encrypted preferences on restore; wrap in try/catch with `RemoveAll` on failure.
  - iOS Keychain entries survive uninstall — first-launch check + clear is the documented pattern.
  - iCloud Keychain may silently sync values across the user's Apple devices.
  - Poor for "large amounts of text" — fine for an API key.

**Review heuristics.**

- `new HttpClient()` at the call site — flag; use the singleton.
- API key from `Preferences`, env var, settings file, or hardcoded — flag.
- Streaming reads the entire response as a string then parses — defeats streaming. Verify `HttpCompletionOption.ResponseHeadersRead` and line-by-line processing.
- `catch (Exception)` that swallows — flag (and STABLE.md anti-rule). The sanctioned conversion is "`IGrader` failure → user offered self-grade," which happens at the page, not the grader.
- `request-id` not logged on failure — flag.
- `cache_control` set on a request whose cached prefix is under the model's minimum — silent no-op; comment.
- `SpendTracker.Record` happens before request completes successfully — bug; record from `usage`, distinguishing `cache_read_input_tokens` at the discounted rate.
- Retry logic that retries 4xx errors (other than 429) — wrong; only 429/5xx should retry.

Strong on the API surface; moderate on "idiomatic C# integration patterns" — the .NET SDK landscape is newer than Python/TS.

---

## 8. Whisper-local integration — the thinnest area

**Question:** what's the actual experience integrating Whisper into MAUI Blazor Hybrid?

**Findings.**

- [Whisper.NET](https://github.com/sandrohanea/whisper.net) (MIT, v1.9.1) is the most active .NET binding to whisper.cpp. README claims support for Windows x86/x64/ARM64, Linux x64/ARM64/ARM, macOS x64/ARM64, **Android**, **iOS**, **MacCatalyst**, **tvOS**, **WebAssembly**.
- **In practice, mobile integration is fragile.** [Whisper.net issues filtered to MAUI](https://github.com/sandrohanea/whisper.net/issues?q=is%3Aissue+MAUI) shows recurring categories: `DllNotFoundException` on iOS (#178), Android native library load failures (#36), architecture/RID mismatches (#157), MacCatalyst codesign failures (#212), App Store binary rejections (#396), and "demo fast, my app slow" performance regressions (#395). Many recently closed, several open.
- Runtime constraints: CPU runtime requires AVX/AVX2/FMA/F16C on x86/x64 (or use `Whisper.net.Runtime.NoAvx`); Windows 11 / Server 2022 minimum for native runtimes; Linux needs `libstdc++6` and glibc 2.31.
- Threading: README's primary API is `processor.ProcessAsync(stream)` returning `IAsyncEnumerable`. Long-running; must not run on the UI thread.
- Model loading is expensive (100-500 MB models). Load once, reuse.
- Alternatives: faster-whisper is Python — violates STABLE.md's in-process, no-server architecture. Native whisper.cpp via direct P/Invoke is possible but reinvents what Whisper.NET exists to provide; no ADR justifies that.

**Review heuristics.**

- `WhisperAudioProcessor` registered as transient / loads the model per call — flag; should be `AddSingleton` with the model held as a field.
- Transcription called from `OnInitializedAsync` or any UI-thread code path — flag.
- Diff adds `#if ANDROID` / `#if IOS` for Whisper — extra scrutiny; this is where the issue tracker shows the most bugs.
- Audio recording without `Permissions.RequestAsync<Permissions.Microphone>()` (and platform manifest/Info.plist usage description) — runtime `PermissionException`.
- Long audio held entirely in memory rather than disk-backed — for long diary entries, prefer disk.

**Evidence: mixed.** README is authoritative for the API. The mobile-integration evidence is the issue tracker — anecdotal. This is the **thinnest** part of the research. The SPEC should flag "any Whisper-related diff deserves extra scrutiny." Whetstone v1 ships desktop-first (Windows + WebAssembly), so the worst mobile issues are *deferred* to v1.5; v1 code should still avoid making v1.5 harder.

---

## 9. Testing review heuristics

**Question:** STABLE.md locks "unit tests on pure logic only." What does that look like in practice?

**Findings.**

- Pure-logic targets: the four schedulers (`FsrsScheduler`, `DiminishingScheduler`, `LinkedSurfacingScheduler`, and the conceptually-pure layer over them), `RoutineGenerator`, `EchoComposer`, grading-result parsers, vocabulary-card-generation prompt builders.
- Must not be tested: `SqliteNoteStore`, `WhisperAudioProcessor`, `AnthropicGrader`, MAUI bootstrap, Blazor components.
- Seam mocking: if `EncounterProposer` takes `IGrader` as a constructor parameter, the test injects a hand-written fake `IGrader` (one class implementing the three methods). No mocking framework is needed and none is on approved-deps.
- STABLE.md's "no `IClock`, callers pass `DateOnly today` directly" is exactly right for tests — it's the cleanest possible test seam.
- Brittle-test smells: assertions on `DateTime.UtcNow`; assertions on non-deterministic collection order; sleep-based waits.

**Review heuristics.**

- Test references `SqliteNoteStore`, `DbContext`, `HttpClient`, `WhisperAudioProcessor`, or a MAUI page/component — bug; violates test-scope rule.
- Test name doesn't match `Method_Condition_Expected` — minor.
- Test uses a mocking framework — flag (not on approved-deps).
- Test asserts on `DateTime.UtcNow` rather than the passed `DateOnly today` — flag.
- Test sleeps to wait for async — flag; await tasks directly.
- Test depends on the network — out of scope.

Strong evidence (direct corollaries of locked rules).

---

## 10. Cross-platform concerns

**Question:** what cross-platform bugs are easy to introduce?

**Findings.**

- **File paths**: always `Path.Combine(FileSystem.AppDataDirectory, …)`. Never hardcode separators.
- **Culture-sensitive parsing**: always `CultureInfo.InvariantCulture` for non-user-displayed parsing/formatting (CSV export, spend log, anything serialised).
- **Date/time** ([Microsoft Learn: Choosing between DateTime/DateTimeOffset/DateOnly](https://learn.microsoft.com/en-us/dotnet/standard/datetime/choosing-between-datetime)): Microsoft's stated default is `DateTimeOffset` for timestamps — but SQLite doesn't natively support it (see §3). Practical resolution for whetstone:
  - `DateOnly` for "today," scheduler due dates, calendar days. EF Core 8+ handles cleanly.
  - `DateTime` in UTC with `Kind = Utc` for stored timestamps. An `Unspecified` `Kind` in a database is a portability bug per the docs.
  - `DateTimeOffset` only in memory, when timezone disambiguation matters. Don't store it.
- **Permissions** ([Microsoft Learn: MAUI Permissions](https://learn.microsoft.com/en-us/dotnet/maui/platform-integration/appmodel/permissions?view=net-maui-9.0)):
  - Microphone supported on Android and iOS. Windows desktop "always returns Granted" (documented quirk, not bug).
  - Request via `Permissions.RequestAsync<Permissions.Microphone>()`. Must not request from `MauiProgram` / `App`; only after first page appears.
  - Must declare in Android manifest or iOS Info.plist (with usage description string) — missing description throws `PermissionException`.
  - iOS: once denied, re-prompt does not appear; user must change in Settings. Code must detect and explain.

**Review heuristics.**

- Hardcoded `"\\"` or `"/"` in a path — use `Path.Combine`.
- `double.Parse(s)` or `decimal.Parse(s)` without `CultureInfo.InvariantCulture` for non-user-input — flag.
- New `DateTime` field on an entity without explicit UTC handling — flag.
- New `DateTimeOffset` field on an entity — flag.
- Microphone permission requested without first calling `Permissions.CheckStatusAsync` — flag.
- Permission requested from `MauiProgram.CreateMauiApp` — flag.

Strong evidence.

---

## Notable analyzer rules

These ship with .NET 8/9 when `EnableNETAnalyzers` is on (default for SDK templates). The SPEC should pin severity in `.editorconfig`. None require dependencies.

| Rule ID | Category | What it catches | Whetstone relevance |
|---|---|---|---|
| **CA1031** | Design | `catch (Exception)` that swallows | Direct hit; STABLE.md says throw, don't swallow. Warning or error. |
| **CA2007** | Reliability | `await` without `ConfigureAwait` | Library code yes; configure to skip async-void event handlers and to exclude page code. |
| **CA2008** | Reliability | `Task` created without `TaskScheduler` | If anyone reaches for `Task.Factory.StartNew`. |
| **CA2012** | Reliability | `ValueTask` used incorrectly (awaited twice, etc.) | Matches Stephen Toub's single-use rule. |
| **CA2016** | Reliability | `CancellationToken` not forwarded | Direct hit. |
| **CA1849** | Performance | Sync method called on object with async equivalent | Catches `.Result`/`.Wait()`-shaped slips. |
| **CA1416** | Interoperability | API used on platform that doesn't support it | Useful as MAUI platform attributes apply. |
| **CA2000** | Reliability | Disposable not disposed before scope ends | Catches `IJSObjectReference`, `DotNetObjectReference`, `CancellationTokenSource` leaks. |
| **CA1822** | Performance | Member that can be static | Style nit; keeps helpers visible. |

EF Core also ships runtime diagnostic warnings (e.g., `RelationalEventId.MultipleCollectionIncludeWarning`) configurable via `ConfigureWarnings(b => b.Throw(…))`. These fire at runtime when a problematic query executes — stricter than analyzers. Worth enabling in development builds to surface cartesian explosions in dev rather than prod.

Blazor ships `Microsoft.AspNetCore.Components.Analyzers` (mostly about parameter declarations); the heuristics in §2 are reviewer judgment, not codified.

---

## Sources

- Microsoft Learn — [.NET MAUI: Run code on the main UI thread](https://learn.microsoft.com/en-us/dotnet/maui/platform-integration/appmodel/main-thread).
- Microsoft Learn — [ASP.NET Core Blazor Hybrid](https://learn.microsoft.com/en-us/aspnet/core/blazor/hybrid/).
- Microsoft Learn — [Razor component lifecycle](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/lifecycle?view=aspnetcore-9.0).
- Microsoft Learn — [Razor component rendering](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/rendering?view=aspnetcore-9.0).
- Microsoft Learn — [Blazor event handling](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/event-handling?view=aspnetcore-9.0).
- Microsoft Learn — [Blazor synchronization context](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/synchronization-context?view=aspnetcore-9.0).
- Microsoft Learn — [Call .NET from JavaScript](https://learn.microsoft.com/en-us/aspnet/core/blazor/javascript-interoperability/call-dotnet-from-javascript?view=aspnetcore-9.0).
- Microsoft Learn — [Call JS from .NET](https://learn.microsoft.com/en-us/aspnet/core/blazor/javascript-interoperability/call-javascript-from-dotnet?view=aspnetcore-9.0).
- Microsoft Learn — [.NET MAUI local databases (SQLite)](https://learn.microsoft.com/en-us/dotnet/maui/data-cloud/database-sqlite).
- Microsoft Learn — [Microsoft.Data.Sqlite connection strings](https://learn.microsoft.com/en-us/dotnet/standard/data/sqlite/connection-strings).
- Microsoft Learn — [EF Core DbContext lifetime](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/).
- Microsoft Learn — [EF Core tracking vs no-tracking](https://learn.microsoft.com/en-us/ef/core/querying/tracking).
- Microsoft Learn — [EF Core eager loading (Include / ThenInclude)](https://learn.microsoft.com/en-us/ef/core/querying/related-data/eager).
- Microsoft Learn — [EF Core efficient querying](https://learn.microsoft.com/en-us/ef/core/performance/efficient-querying).
- Microsoft Learn — [EF Core SQLite provider limitations](https://learn.microsoft.com/en-us/ef/core/providers/sqlite/limitations).
- Microsoft Learn — [EF Core transactions](https://learn.microsoft.com/en-us/ef/core/saving/transactions).
- Microsoft Learn — [Choosing between DateTime, DateTimeOffset, DateOnly](https://learn.microsoft.com/en-us/dotnet/standard/datetime/choosing-between-datetime).
- Microsoft Learn — [Nullable reference types](https://learn.microsoft.com/en-us/dotnet/csharp/fundamentals/null-safety/nullable-reference-types).
- Microsoft Learn — [HttpClient guidelines](https://learn.microsoft.com/en-us/dotnet/fundamentals/networking/http/httpclient-guidelines).
- Microsoft Learn — [Use IHttpClientFactory](https://learn.microsoft.com/en-us/dotnet/core/extensions/httpclient-factory).
- Microsoft Learn — [MAUI SecureStorage](https://learn.microsoft.com/en-us/dotnet/maui/platform-integration/storage/secure-storage?view=net-maui-9.0).
- Microsoft Learn — [MAUI Permissions](https://learn.microsoft.com/en-us/dotnet/maui/platform-integration/appmodel/permissions?view=net-maui-9.0).
- Microsoft Learn — [CA2007: Do not directly await a Task](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2007).
- Stephen Toub — [Understanding the whys, whats, and whens of ValueTask](https://devblogs.microsoft.com/dotnet/understanding-the-whys-whats-and-whens-of-valuetask/).
- Stephen Cleary — [Async/Await Best Practices (MSDN Magazine, 2013, still authoritative)](https://learn.microsoft.com/en-us/archive/msdn-magazine/2013/march/async-await-best-practices-in-asynchronous-programming).
- David Fowler — [AspNetCoreDiagnosticScenarios: AsyncGuidance](https://github.com/davidfowl/AspNetCoreDiagnosticScenarios/blob/master/AsyncGuidance.md).
- Anthropic — [API errors](https://docs.anthropic.com/en/api/errors).
- Anthropic — [Prompt caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching).
- Anthropic — [Streaming Messages API](https://docs.anthropic.com/en/docs/build-with-claude/streaming).
- GitHub — [sandrohanea/whisper.net](https://github.com/sandrohanea/whisper.net) (README, runtime matrix).
- GitHub — [Whisper.net MAUI issues](https://github.com/sandrohanea/whisper.net/issues?q=is%3Aissue+MAUI) (recurring problem patterns).

---

## Limits

- **Strong evidence**: lifecycle/threading, DbContext, EF Core queries, SQLite limitations, async patterns, nullable, SecureStorage, Permissions, Anthropic API surface — all cited directly from Microsoft Learn or vendor docs.
- **Moderate evidence**: Blazor Hybrid-specific patterns. Framework is documented but less battle-tested in writeups than Server/WASM.
- **Thin evidence — flagged explicitly**:
  - **Whisper-in-MAUI** — README is good, issue tracker is concerning. No Microsoft Learn page covers Whisper.NET in MAUI. The picture is constructed from Whisper.NET's own issue patterns. SPEC should treat any Whisper-touching diff as needing an extra pass.
  - **Anthropic C# SDK idioms** — the .NET SDK landscape is newer than Python/TS; idiomatic patterns are still being established. HTTP-direct via singleton HttpClient is the most defensible because it's documented end-to-end.
- **Areas with web search returning model-knowledge fallbacks**: parts of the EventCallback vs Action discussion, parts of the StateHasChanged "common smell" patterns. The cited Microsoft Learn pages back the core claims.
- **Likely stale within 6 months**: Anthropic prompt-caching minimums (Haiku 4.5 specifically — re-check); EF 9 migration lock behaviour; Whisper.NET version-specific runtime requirements (currently 1.9.1).
- **Out of scope**: Cosmos DB, CI/CD specifics, Anthropic batch/files APIs, Blazor Web App render modes, Polly, Refit, AutoMapper (banned per STABLE.md anti-rules).
