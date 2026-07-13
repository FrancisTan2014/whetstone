# Coaching model — local Ollama (cheap tier) + cloud judge (strong tier)

The practice coach talks through the `CoachProvider` seam (`src/apps/server/src/coach/`). Calls are
**cost-routed** across two tiers (`coachRouter.ts`): a **cheap** local model carries the high-volume
turn-by-turn _converse_, and a **strong** cloud model runs the one paid _analyze_ (judge) call per
round. Every tier composes the LLM over the deterministic **fake**, so any model or parse failure —
or no configuration at all — still completes the round on the fake. **No model is ever required for
the loop to run.**

## Tiers and routing

| Call                           | Default tier | Runs on                                |
| ------------------------------ | ------------ | -------------------------------------- |
| `converse`                     | `cheap`      | local Ollama (`llama3.1:8b`)           |
| `analyze`                      | `strong`     | cloud judge (intelligibility + chunks) |
| `author` / `propose` / `judge` | `cheap`      | local Ollama                           |

Override any call's tier with its env var (`COACH_CONVERSE_TIER`, `COACH_ANALYZE_TIER`,
`COACH_AUTHOR_TIER`, `COACH_PROPOSE_TIER`, `COACH_JUDGE_TIER`), each `cheap` or `strong`.

## Configuration (config-gated, absent-config-safe)

| Env var         | Meaning                                                                                      | Required |
| --------------- | -------------------------------------------------------------------------------------------- | -------- |
| `COACH_API_KEY` | Cloud key for the **strong** tier. Optional: with no key the coach still runs its cheap/local tier; any `strong`/`analyze` call without a key falls back to the deterministic fake. | no |
| `COACH_*_TIER`  | Per-call tier override (see above). Default routing needs none.                              | no       |

With a key set, the defaults already give you **local converse + cloud judge**. Keyless still runs a
**fully-local coach**: the cheap/local tier serves converse (and, with `COACH_ANALYZE_TIER=cheap`,
analyze too), while any remaining `strong`-routed call falls back
to the deterministic fake. With no Ollama daemon the local tier itself degrades to the fake per call
(the `pnpm validate` path: no network, no model).

## Provision Ollama on the deploy host

The local cheap tier serves from Ollama on its fixed default port (`http://127.0.0.1:11434`).

**Local dev:** the coach is being retired and no longer has a one-command setup (the former
`pnpm setup:coach` now only prints a migration hint pointing at `pnpm setup:ai`, which provisions the
separate optional AI utilities, not the coach). Provision the coach's local model by hand: install
Ollama (see below), `ollama pull llama3.1:8b`, then set `COACH_MODEL=llama3.1:8b` +
`COACH_CONVERSE_TIER=cheap` + `COACH_ANALYZE_TIER=cheap` in `.env` for a fully-local coach. Add
`COACH_API_KEY` + `COACH_ANALYZE_TIER=strong` for the optional cloud judge. To provision a host:

1. **Install Ollama** — <https://ollama.com/download> (macOS: download the app, or `brew install
ollama`). Start the daemon (`ollama serve`, or just launch the app).
2. **Pull the model:**

   ```bash
   ollama pull llama3.1:8b
   ```

3. **Set the cloud key** (never commit it) and start the server:

   ```bash
   export COACH_API_KEY=sk-...   # your cloud key
   pnpm --filter @whetstone/server start
   ```

## Boot health check

On startup the server probes the local model (`/api/tags`) and logs one line (`coachHealth.ts`):

- `local_ready` — the model is serving; converse runs locally.
- `local_unavailable` — the daemon or model is missing; the server **warns** with the exact
  `ollama pull llama3.1:8b` hint and **keeps running on the fake** (no crash).
- `cloud_only` — no call routed to the local tier (a key is set).
- `fake` — no call routed to the local tier and no `COACH_API_KEY`; nothing local, no cloud.

So a fresh deploy with Ollama down or the model unpulled degrades cleanly to the fake, the gate stays
green, and the log tells you exactly what to pull.
