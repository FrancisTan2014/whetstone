# Voice input (STT) — local speech, provider-neutral

The voice diary turns a recorded utterance into a transcript + word timings through the
`SpeechInput` seam (`src/apps/server/src/speech/`). Transcription runs **locally and offline** — **no
audio leaves the machine** and there is ~zero token cost. The seam is **provider-neutral** (#799): a
provider's only public config is an **executable path + a model identifier**, so the underlying engine
(whisper.cpp, faster-whisper, a calibrated Qwen provider, …) can change without forking Diary, its
worker, or its database rows. Pronunciation / prosody scoring is out of scope; it plugs in later behind
the same seam.

## Components

- `SpeechInput` (`speechInput.ts`) — `transcribe({ path }) -> { transcript, words:
  [{ text, start, end }], language }`. **Transcript text is the required, transcript-first payload.**
  `words` is **optional evidence**: token timings are an empty array when a provider has no aligner, and
  a valid transcript is never failed merely because timings are unavailable. Word `start`/`end` are
  integer **milliseconds** from the start of the recording. `language` is the provider's automatic
  detection (there is no forced-language override, #647); it is null when none was reported and never
  rewrites or rejects the transcript.
- `LocalSpeechInput` (`localSpeechInput.ts`) — **the provider-neutral local adapter and stable
  boundary.** Runs a configured local speech executable over the audio file and maps its JSON into a
  `Transcription`. Its config is only `{ binaryPath, modelIdentifier }`. Untrusted process output is
  validated at the boundary before anything is trusted inward. When the configured executable's
  readiness probe declares persistent-mode support (see below), captures are lazily routed through
  `PersistentSpeechManager` instead of a fresh spawn per capture; an executable that does not declare
  support keeps using the original one-shot spawn, unchanged.
- `PersistentSpeechManager` (`persistentSpeechManager.ts`) — **the persistent local-process lifecycle
  manager (#884).** Starts the configured executable in `--persistent` mode lazily on the first
  capture, keeps it warm across a burst of captures, and kills it outright after a fixed 5-minute idle
  window (`IDLE_UNLOAD_MS`) with no new capture, sliding the window forward on every completed capture.
  An unexpected process death mid-request fails that one capture cleanly (its existing
  `transcription_failed` retryable path) and transparently respawns on the next capture. Still only one
  capture at a time (#565) — no concurrent multiplexing.
- Legacy Whisper adapter (`whisperSpeechInput.ts`) — the pre-#799 adapter, **kept working only as a
  migration fallback**. It does not implement the new provider protocol and will be retired once
  installations move to `LOCAL_ASR_*`.
- `FakeSpeechInput` (`fakeSpeechInput.ts`) — deterministic; the `pnpm validate` gate has no mic, so
  the loop tests on the fake (inject a fixed transcription, or a function of the audio).
- `speechProcess.ts` — the provider-neutral OS-process boundary: the injected `execFile`-based
  one-shot `CommandRunner`, and the injected `spawn`-based `PersistentProcessLauncher` that keeps a
  persistent process's stdin/stdout open across many captures.
- Derived timing (`@whetstone/domain` `deriveSpeechTiming`) — response **latency** (ms to the first
  word) and **inter-word pauses** (ms gaps), the basic automaticity signal.

## Configuration (config-gated, absent-config-safe)

A provider activates only when configured; with nothing set the server stays on the fake and never
crashes for a missing model.

| Env var              | Meaning                                                        | Role      |
| -------------------- | ------------------------------------------------------------- | --------- |
| `LOCAL_ASR_BINARY`   | Path to the local speech executable (see protocol below)      | new pair  |
| `LOCAL_ASR_MODEL`    | The model identifier handed to the executable                 | new pair  |
| `WHISPER_BINARY`     | Path to the legacy Whisper CLI / wrapper                      | legacy    |
| `WHISPER_MODEL_PATH` | Path/size of the legacy Whisper model                        | legacy    |

Resolution (`speechConfig.ts`):

- **New pair is authoritative.** When **both** `LOCAL_ASR_BINARY` and `LOCAL_ASR_MODEL` are present,
  the provider-neutral `LocalSpeechInput` is used.
- **A partial new pair is an error.** Exactly one of `LOCAL_ASR_BINARY` / `LOCAL_ASR_MODEL` is an
  explicit startup configuration error with the exact setup remedy — never a silent fake fallback.
- **Legacy is a fallback only.** The complete `WHISPER_BINARY` + `WHISPER_MODEL_PATH` pair is honoured
  **only when neither new key is present**. If the new pair is complete, any leftover `WHISPER_*` is
  ignored and reported (a **mixed** config) by the boot health report / `pnpm setup:doctor` so the
  migration stays visible.
- **Nothing set → fake.** No provider means the deterministic fake, so the loop never depends on a
  microphone or a model being installed.

## Local speech executable protocol (#799)

A `LOCAL_ASR_BINARY` executable must honour this provider-neutral protocol:

- **Readiness probe:** `<binary> --contract-version` prints the compact JSON
  `{"contractVersion":"1"}` on stdout, exits `0`, and **loads no model**. Setup/doctor run this to prove
  a provider speaks the exact protocol before any audio is handed to it, and to detect a **stale**
  build.
- **Transcription run:** the runtime invokes the binary with the model identifier, a JSON output
  request, and the saved audio path:

  ```
  <LOCAL_ASR_BINARY> --model <LOCAL_ASR_MODEL> --output json <audio>
  ```

  No language is forced and no engine-specific alignment flag is passed — a provider decides its own
  detection and whether it emits token timings.
- **Output:** **word-timestamped JSON on stdout**, transcript-first. Only `text` is required;
  `language` may be a string or null/omitted; `segments` and their `words[]` may be empty or omitted
  when a provider has no aligner. Any timing a provider *does* supply is strictly validated (numeric
  seconds, `end >= start`) and converted to integer milliseconds; a malformed word fails the run.

  ```json
  {
    "text": "Help yourself now",
    "language": "en",
    "segments": [
      { "words": [{ "word": "Help", "start": 0.0, "end": 0.4 }] }
    ]
  }
  ```

  A transcript-first provider with no aligner may return just `{ "text": "Help yourself now" }`; it is
  a valid transcript with empty word evidence.

### Persistent mode protocol (#884, optional, auto-detected)

A provider **may** additionally support a persistent, warm-process mode instead of exiting after every
single transcription. Support is **auto-detected** from the readiness probe — there is no new env var
and no configuration to opt in — so an older build or a custom third-party executable that only
implements the one-shot protocol above keeps working unchanged.

- **Capability declaration:** the `--contract-version` probe response includes `"persistent": true`
  when the executable understands the flag below. Absent, `false`, or any non-boolean value means
  "not supported" — this is **never assumed**, only read from the probe.
- **Starting persistent mode:** the runtime invokes the binary with the model identifier and **no
  audio positional** (each capture's audio path arrives later, one per stdin line):

  ```
  <LOCAL_ASR_BINARY> --persistent --model <LOCAL_ASR_MODEL>
  ```

  The binary loads the model exactly once, then serves one request at a time over a plain
  stdin/stdout line protocol: a **request** is one audio path per stdin line; the corresponding
  **response** is one line on stdout containing the *exact same* transcript-first JSON contract
  described above (never an error-shaped variant). Blank input lines are ignored.
- **Failure is fatal, by design:** a transcription failure inside persistent mode is not signalled as
  an error line — the process prints to stderr and exits non-zero instead. This keeps the response
  shape to exactly one contract (never an error variant) and reuses the same crash-detection/respawn
  path for both a genuine crash and a per-request failure.
- **Lifecycle (`persistentSpeechManager.ts`):** started lazily on the first capture, never at boot.
  Kept warm across a burst of captures. After a fixed **5-minute idle window** (`IDLE_UNLOAD_MS`) with
  no new capture, the process is **killed outright** — not unloaded in-process — so its resident memory
  is reliably handed back to the OS; the window slides forward on every completed capture. The next
  capture after an idle-unload transparently respawns and pays the cold-start cost again. An
  unexpected process death mid-request fails that one capture cleanly through the existing
  `transcription_failed` retryable path; the next capture respawns. Still only one capture at a time
  (#565) — no concurrent multiplexing.
- **Resource cost recurs, not once:** because the process is kept resident for up to 5 idle minutes
  after a capture, the resource floor below is **not** a one-time install-time cost for a
  persistent-capable provider — it applies whenever a capture has landed recently, and is released
  automatically once idle. `pnpm setup:doctor` states this explicitly.

## One-command setup (`pnpm setup:voice`)

The fastest way to enable voice is the setup framework's voice step:

```
pnpm setup:voice
```

It provisions the **calibrated Qwen3-ASR-1.7B provider** — the default local voice — running **CPU-only
and fully offline** in a **Whetstone-owned, isolated Python virtual environment** under the ignored
`.data/voice/qwen-venv` (created with `python -m venv`; pins install into it, **never** the global
Python). The step:

- Installs the pinned runtime into the venv: a verified **CPU** build of `torch` (from the PyTorch CPU
  wheel index), `qwen-asr==0.0.6`, and `av` (decodes browser WebM audio with a bundled ffmpeg, so no
  system ffmpeg is required), plus the bundled **`whetstone-qwen`** console-script wrapper
  (`scripts/setup/qwen-wrapper/`, emits the #799 JSON contract below).
- Pre-fetches the model `Qwen/Qwen3-ASR-1.7B` pinned to revision
  `7278e1e70fe206f11671096ffdd38061171dd6e5` into the venv's local cache.
- Records the exact runtime it built in a `.whetstone-voice-runtime` marker inside the venv, so a later
  run **repairs** (rebuilds) an incomplete or version-mismatched environment instead of trusting it.
- **Runs a resource preflight before any heavy download or model load** (via `ctx.resources`): it
  requires **12 GiB free disk** and **12 GiB available memory** and fails with the exact requirement and
  remedy — never a silent fallback to a smaller/other provider. This preflight is a one-time,
  install-time check; the **runtime** memory floor recurs afterward whenever the persistent process is
  resident (see [Persistent mode protocol](#persistent-mode-protocol-884-optional-auto-detected)
  above) — `pnpm setup:doctor` reports both.
- Writes the provider-neutral pair to the root `.env`: `LOCAL_ASR_BINARY` (the venv's managed
  `whetstone-qwen` launcher) + `LOCAL_ASR_MODEL` (`Qwen/Qwen3-ASR-1.7B`), and **removes the legacy
  `WHISPER_*` pair** so a stale key can never be honoured or reported as a mixed config.
- Verifies by running the readiness contract probe (which reports the provider, pinned revision, and
  resource requirements) and one **real sample inference** through the wrapper.

Its Python 3 prerequisite is installed through the consent-gated `installSystemTool` helper (winget/brew
after a Y, else instruct-only). `pnpm setup:doctor` reports voice readiness; each failure prints an
actionable remedy and the step is re-runnable. This is optional and excluded from the base `pnpm setup`
— the `pnpm validate` gate never needs a model. If you point `LOCAL_ASR_BINARY` at your own executable
instead, it must answer the `--contract-version` probe and honour the run protocol above.

The wrapper is a pip package with a `console_scripts` entry point, so pip generates a native launcher
executable inside the venv that the server's `execFile` runs directly (a `.py`/`.cmd` cannot be
`execFile`-d). It honours the protocol arguments above and emits the JSON contract.

### Readiness contract probe

`whetstone-qwen` answers the machine-readable readiness probe so setup can prove the provider speaks the
exact protocol and detect a **stale** or incomplete build. Invoked as:

```
<LOCAL_ASR_BINARY> --contract-version
```

it prints compact JSON on stdout, exits `0`, and **loads no model**. Beyond the required
`contractVersion`, the Qwen wrapper reports its identity and resource needs, e.g.:

```json
{
  "contractVersion": "1",
  "provider": "qwen3-asr-1.7b",
  "revision": "7278e1e70fe206f11671096ffdd38061171dd6e5",
  "persistent": true,
  "requirements": { "diskGiB": 12, "memoryGiB": 12 }
}
```

`pnpm setup:voice` and `pnpm setup:doctor` run this probe as their readiness check (requiring the
version to match exactly) and log the reported provider, revision, and requirements. A launcher that
errors, prints anything else, or reports a different version fails readiness with an explicit remedy, and
`pnpm setup:voice` rebuilds the runtime to repair it.

## Calibration (`pnpm calibrate:voice`)

Accuracy is measured with a **provider-neutral** calibration harness so the local default can be
justified with numbers and re-checked when the pins change:

```
pnpm calibrate:voice [manifest.json]
```

The thin Node launcher reads the configured `LOCAL_ASR_*` provider from `.env`, resolves the venv's
Python, and runs `whetstone_qwen.calibrate` over a **local manifest** (default
`.data/voice/calibration/manifest.json`, or a path passed as the first argument). It reports **aggregate
metrics only** — normalized **Chinese CER** and **English WER**, cold-start duration, and peak RSS — and
**never prints the private audio, reference text, or transcript**. Because the manifest and audio live
under ignored `.data/`, calibration corpora never enter the repository.


## Legacy Whisper runtime + model (manual)

Use an OSS Whisper runtime, e.g.:

- **whisper.cpp** — build `main`, point `WHISPER_BINARY` at it and `WHISPER_MODEL_PATH` at a GGML model
  (e.g. `ggml-base.en.bin`); CPU-only and fully offline.
- **faster-whisper** — a small CLI wrapper around `WhisperModel` works too.

The legacy adapter invokes the binary as below, always with `--language auto` — Whetstone never forces
a language, so a multilingual model detects the spoken language and reports it back in the JSON (an
English-only model stays constrained by the model itself).

```
<WHISPER_BINARY> --model <WHISPER_MODEL_PATH> --language auto --output json --word-timestamps <audio>
```

and expects **word-timestamped JSON on stdout** in this shape (faster-whisper style; seconds; the
optional top-level `language` is the model's detected code, echoed back — omit or null it when none was
detected):

```json
{
  "text": "你好 Help yourself now",
  "language": "zh",
  "segments": [
    { "language": "zh", "words": [{ "word": "你好", "start": 0.0, "end": 0.8 }] },
    { "language": "en", "words": [{ "word": "Help", "start": 1.2, "end": 1.6 }] }
  ]
}
```

**Per-utterance language detection (#909).** A single whole-file `transcribe` call detects **one**
language from the start of the audio and decodes the entire recording with it, so a capture that mixes
languages (e.g. Chinese then English) silently drops the speech in the other language. The bundled
`whetstone-whisper` faster-whisper wrapper (`scripts/setup/whisper-wrapper/`) therefore, for
`--language auto`, first splits the recording into speech utterances with the **Silero VAD faster-whisper
already ships** (no extra download), then **detects and decodes each utterance independently** and
concatenates them in time order — so every utterance is kept. Each `segments[]` entry carries the
`language` detected for **its** utterance (additive, informational — existing consumers ignore it); the
top-level `language` stays the recording's opening language (the first utterance's detection, null when
none) for the single-language adapter boundary. Word timings are shifted back into **absolute file time**
so they stay monotonic across utterance boundaries. A forced language (any value other than `auto`), or
a recording the VAD finds no speech in, keeps the original single whole-file decode. This is an additive
output change, so the shared `--contract-version` readiness value is unchanged. A different
`WHISPER_BINARY` that emits a single whole-file `language` and per-`segments` `words[]` (no per-segment
`language`) remains valid — the extra field is optional.

If your tool's flags or output differ, point `WHISPER_BINARY` at a thin wrapper that honours the
arguments above, answers the `--contract-version` readiness probe (see above), and emits this JSON
contract.
