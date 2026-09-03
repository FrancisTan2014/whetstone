# Local agent — provider-neutral, config-gated

Whetstone can hold a multi-turn conversation with a **locally installed agentic CLI** — Qwen Code,
Gemini CLI, Claude Code, GitHub Copilot CLI, or any other — through the `Agent` seam
(`src/apps/server/src/agent/`). The seam is **provider-neutral** (#904): a provider's only public
config is an **executable path + a model identifier**, so which tool is installed never leaks into a
product flow, and Whetstone contains no table of per-CLI flags. Adapting a particular vendor CLI is the
job of a small external shim that honours the protocol below.

It is the agent-level twin of the voice seam in `docs/SPEECH.md`, and deliberately shares its shape: a
small port, a provider-neutral executable protocol, a deterministic fake when nothing is configured, an
injected OS-process boundary, and a boot health report that reports and never crashes.

**Diary tidy is the seam's first and only client** (#906): when `AGENT_BINARY` + `AGENT_MODEL` are set,
the voice-diary transcript tidy runs through a local agent CLI instead of a resident Ollama model. See
[First client: diary tidy](#first-client-diary-tidy) below. No other product flow calls the seam.

## Components

- `Agent` / `AgentSession` / `AgentTurn` (`agentSession.ts`) — the port. `open({ instructions? })`
  starts a conversation, `send(prompt) -> { text }` takes one turn in it, `close()` ends it.
  **Transcript-first, exactly like the speech seam:** `text` is the whole required payload, so a
  provider that reports nothing else is still a complete answer, and a provider that reports more (cost,
  usage, tool traces) does not break the seam.
- `CliAgent` (`cliAgent.ts`) — **the provider-neutral adapter and stable boundary.** Probes the
  configured executable, then runs one invocation per turn and validates its JSON. Its config is only
  `{ binaryPath, modelIdentifier }`. Untrusted process output is validated at the boundary before
  anything is trusted inward.
- `FakeAgent` (`fakeAgent.ts`) — deterministic; the `pnpm validate` gate has no agent CLI installed, so
  callers test against a scripted fake (a fixed reply, or a function of the prompt). It enforces the
  port's own closed-session rule, so it is never more permissive than a real provider.
- `agentConfig.ts` — env resolution (`readAgentConfig`) and provider selection (`resolveAgent`).
- `agentProcess.ts` — the injected OS-process boundary: a `spawn`-based runner that writes the prompt to
  the child's stdin, closes it, collects stdout/stderr, and terminates a child that outlives its bound.
- `agentFailure.ts` — the typed failure codes every turn fails by (below).
- `agentHealth.ts` — the boot report: is a provider configured, did it answer its probe, and can it
  resume sessions.

## Configuration (config-gated, absent-config-safe)

A provider activates only when configured; with nothing set the seam stays on the deterministic fake
and the server boots normally.

| Env var        | Meaning                                                 |
| -------------- | ------------------------------------------------------- |
| `AGENT_BINARY` | Path to the local agent executable (see protocol below) |
| `AGENT_MODEL`  | The model identifier handed to the executable           |

Resolution (`agentConfig.ts`):

- **Both keys → a real provider.** The provider-neutral `CliAgent` adapter is used.
- **Exactly one key → an explicit startup configuration error** naming the missing key, never a silent
  fallback: someone meant to enable an agent and would otherwise never learn why it stayed off. A blank
  value counts as unset.
- **Neither key → the deterministic fake**, so no caller depends on an agent CLI being installed.

## Local agent executable protocol (#904)

An `AGENT_BINARY` executable must honour this provider-neutral protocol. It is the deliberate sibling of
the `LOCAL_ASR_BINARY` protocol in `docs/SPEECH.md`.

- **Readiness probe:** `<AGENT_BINARY> --contract-version` prints compact JSON on stdout, exits `0`, and
  **starts no session and loads no model**. Its stdin is empty and closed immediately. The probe runs
  before any prompt is handed over, so a stale or incompatible provider is detected first.

  ```json
  { "contractVersion": "1", "provider": "qwen-code", "sessions": true }
  ```

  `contractVersion` is required and must be exactly `"1"`. `provider` is an optional identifier used in
  operational logs and the boot health report (a provider that reports none is logged as `unknown`).
  `sessions` declares whether the executable can **resume conversation state** across invocations;
  absent, `false`, or any non-boolean value means "no" — support is **never assumed**. The probe must
  answer within 10 seconds.

- **Turn invocation:** one invocation per turn, with the model identifier and a JSON output request:

  ```
  <AGENT_BINARY> --model <AGENT_MODEL> --output json [--session <sessionId>]
  ```

  `--session` is passed **only** when the probe reported `sessions: true`. The id is generated by
  Whetstone once per opened conversation and is opaque to it; a provider (or its shim) keys its stored
  conversation state on that id.

- **The prompt arrives on stdin, which is then closed.** It is never an argv parameter: prompts are long
  and multi-line, and argv has hard length limits and quoting hazards (notably on Windows). Standing
  `instructions` are restated ahead of every prompt, separated by a blank line, because a provider
  without session support has no memory of the previous invocation.

- **Response:** JSON on stdout. Only `text` is required; unknown keys are ignored, so a provider may
  report cost, usage, or trace fields without breaking the seam. The text is returned verbatim.

  ```json
  { "text": "A whetstone is a fine-grained stone used to sharpen a blade." }
  ```

- **Failure:** a non-zero exit is a failure carrying the child's stderr as the message. Whetstone
  terminates a turn that exceeds **120 seconds** of wall clock. Output retained from one invocation is
  capped at 1 MiB, because a local CLI is untrusted output; a truncated response simply fails contract
  validation rather than being partially trusted.

Every failure is named (`agentFailure.ts`), and a caller classifies it by `code` rather than by matching
error strings:

| Code                       | Meaning                                                              |
| -------------------------- | -------------------------------------------------------------------- |
| `agent_not_configured`     | No provider configured and the caller supplied no fake               |
| `agent_probe_failed`       | The probe did not run, exited non-zero, or reported another contract |
| `agent_exit_failed`        | The provider ran and exited non-zero (message carries its stderr)    |
| `agent_malformed_response` | Exit `0`, but stdout was not the JSON turn contract                  |
| `agent_timeout`            | The turn exceeded its wall-clock bound and the child was stopped     |
| `agent_session_closed`     | `send` was called after `close`                                      |

A malformed or off-contract response **fails the turn**. The seam never fabricates, salvages, or
partially trusts an answer.

## Bundled shim: GitHub Copilot CLI (#906)

`AGENT_BINARY` is the **protocol executable**, not the vendor CLI itself — no vendor speaks this
protocol natively. `scripts/setup/copilot-wrapper/` is the reference shim, adapting an installed and
authenticated [GitHub Copilot CLI](https://github.com/github/copilot-cli) to the protocol above. It is
the agent twin of `scripts/setup/whisper-wrapper/` and follows the same rules: **Python standard library
only**, no dependency added under `src/`, and it lives outside the app because it is per-machine setup.

Install it into any Python 3.9+ environment; pip emits a native launcher (`whetstone-copilot`, or
`whetstone-copilot.exe` on Windows), which is what `AGENT_BINARY` must point at:

```bash
pip install -e scripts/setup/copilot-wrapper
```

```
AGENT_BINARY=<that launcher's absolute path>
AGENT_MODEL=auto
```

`AGENT_MODEL` is passed straight through as Copilot's `--model`; `auto` lets Copilot pick. An identifier
Copilot does not offer fails the turn by name (`Model "…" from --model flag is not available.`) rather
than quietly falling back to a different model.

A native launcher is required, not a convenience: `agentProcess.ts` spawns `AGENT_BINARY` **without a
shell**, so a `.mjs`, `.cmd`, or `.bat` cannot be launched on Windows. `[project.scripts]` in
`pyproject.toml` is what produces a real executable.

What the shim does per invocation:

- `--contract-version` → `{"contractVersion":"1","provider":"github-copilot-cli","sessions":true}`,
  spawning nothing. The probe stays cheap and cannot hang on a signed-out CLI.
- A turn reads the prompt from stdin, runs
  `copilot -p <prompt> -s --no-color --log-level none --no-ask-user --disable-builtin-mcps
  --no-custom-instructions --model <AGENT_MODEL> --session-id <sessionId>`, and prints `{"text": ...}`.
  `--no-ask-user` and `--disable-builtin-mcps` keep the turn headless and toolless, matching
  [No tools, by design](#no-tools-by-design). `--no-custom-instructions` stops Copilot from injecting an
  `AGENTS.md` found near the server's working directory into a product prompt, which would otherwise make
  the answer depend on where the server was started.
- **Sessions:** Copilot's `--session-id` both *starts* a session with the given UUID and *resumes* one
  that already exists, so the shim passes it on every turn and needs no separate resume flag and no state
  file of its own. Conversation state lives in Copilot's own store.
- Every failure exits non-zero with a named reason on stderr — a missing `copilot` on `PATH`, a non-zero
  Copilot exit, a turn exceeding 110 seconds (deliberately inside the seam's own 120-second bound, so the
  shim is what stops Copilot), an oversized prompt, or empty output. The shim never invents an answer.
- `WHETSTONE_COPILOT_BINARY` overrides which executable is run, for a non-`PATH` install.

Its own tests run from `scripts/setup/copilot-wrapper/` with `python -m unittest discover -s tests` and
require no Copilot CLI, no credential, and no network. Like the whisper shim, it is outside the
`pnpm validate` gate, which has no agent CLI installed.

## First client: diary tidy

Voice-diary tidy (`features/diary/diaryTidy.ts`) is the seam's first caller. Tidy needs one short,
low-stakes completion, which is exactly what an agent turn is, and an agent CLI costs no resident RAM —
so a machine that cannot host a local LLM can still tidy.

- `llm/agentModel.ts` adapts `Agent` to the existing `LlmModel` port: one completion is
  `open → send → close`, with `close()` in a `finally` so no session leaks on a failed turn. It requests
  **no** standing instructions and refuses `{ json: true }` by name — the agent protocol's `text` is
  free-form prose, and a caller that needs strict JSON must keep using an Ollama model rather than be
  handed a hopeful string.
- `resolveDiaryTidy` precedence: **agent model → `DIARY_TIDY_MODEL` (Ollama) → off**. `selectDiaryTidyBackend`
  is the single exported decision, so the boot log and the wiring cannot disagree.
- Every existing safety guarantee is unchanged: a failed turn, a blank reply, or a reply that fails the
  faithfulness guard still saves the **raw transcript**. A diary entry is the user's own words; an agent
  outage must never cost or alter them.
- Because a failure is swallowed on purpose, the injected agent log sink is the only operational trace of
  it — provider, status, duration only, per [Logging and privacy](#logging-and-privacy).

## No tools, by design


The seam grants the agent **nothing**: no tool flag is passed and no tool allowlist is exposed. A local
agent therefore cannot reach Whetstone's data — in particular it structurally cannot become a second
writer of scheduling state, which keeps the product's "one FSRS writer" invariant enforced by the code
rather than by prose. The first tool will be added, by name, in whichever later issue needs it.

## Logging and privacy

Operational logs contain only the provider identifier, the outcome status, and durations — never prompt
text, response text, session content, or environment values (including the binary path and the model
identifier). This is the same standard `docs/MCP.md` sets. The seam owns no logger: records go to an
injected sink, so the server decides where they land.

## Not in this seam

- **No warm/persistent session manager.** One-shot invocation per turn is enough; the probe already
  reports a `sessions` capability flag, so a warm mode can be auto-detected later exactly as #884 did
  for speech.
- **No vendor adapter inside the app.** The generic adapter needs only `node:child_process` and adds no
  runtime dependency; vendor-specific knowledge lives in an out-of-app shim
  (`scripts/setup/copilot-wrapper/`), never under `src/`.
- **No JSON-mode agent completions.** `agentModel.ts` refuses `{ json: true }` rather than hoping a prose
  reply parses. A strict-JSON caller stays on an Ollama model until the protocol carries a structured
  payload.
