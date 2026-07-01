# Voice input (STT) — local Whisper

The practice loop turns a recorded utterance into a transcript + word timings through the
`SpeechInput` seam (`src/apps/server/src/speech/`). Transcription runs **locally and offline** with
OSS Whisper — **no audio leaves the machine** and there is ~zero token cost. Pronunciation / prosody
scoring is out of scope; it plugs in later behind the same seam.

## Components

- `SpeechInput` (`speechInput.ts`) — `transcribe({ path }) -> { transcript, words: [{ text, start, end }] }`.
  Word `start`/`end` are integer **milliseconds** from the start of the recording.
- `FakeSpeechInput` (`fakeSpeechInput.ts`) — deterministic; the `pnpm validate` gate has no mic, so
  the loop tests on the fake (inject a fixed transcription, or a function of the audio).
- Local Whisper adapter (`whisperSpeechInput.ts`) — runs a configured Whisper CLI over the audio file
  and maps its word-timestamped JSON into a `Transcription`. Untrusted process output is validated at
  the boundary before anything is trusted inward.
- Derived timing (`@whetstone/domain` `deriveSpeechTiming`) — response **latency** (ms to the first
  word) and **inter-word pauses** (ms gaps), the basic automaticity signal.

## Configuration (config-gated, absent-config-safe)

The adapter activates only when configured; with nothing set the server stays on the fake and never
crashes for a missing model.

| Env var              | Meaning                                              | Required |
| -------------------- | ---------------------------------------------------- | -------- |
| `WHISPER_BINARY`     | Path to the Whisper CLI / wrapper                    | yes      |
| `WHISPER_MODEL_PATH` | Path to the local model file                         | yes      |
| `WHISPER_LANGUAGE`   | Language code passed to the model (default `en`)     | no       |

A local Whisper is configured only when **both** `WHISPER_BINARY` and `WHISPER_MODEL_PATH` are
present; otherwise resolution falls back to the fake.

## One-command setup (`pnpm setup --voice`)

The fastest way to enable voice is the setup framework's voice step:

```
pnpm setup --voice
```

It installs `faster-whisper`, installs the bundled **`whetstone-whisper`** console-script wrapper
(`scripts/setup/whisper-wrapper/`), pre-fetches the model (`WHISPER_MODEL`, default multilingual
`small`; `base.en` for English-only), verifies the wrapper against a sample, and writes
`WHISPER_BINARY` / `WHISPER_MODEL_PATH` / `WHISPER_LANGUAGE` to the root `.env`. `pnpm setup:doctor`
reports voice readiness; each failure prints an actionable remedy and the step is re-runnable. This
is optional and excluded from the base `pnpm setup` — the `pnpm validate` gate never needs a model.

The wrapper is a pip package with a `console_scripts` entry point, so pip generates a native launcher
executable on every OS that the server's `execFile` runs directly (a `.py`/`.cmd` cannot be
`execFile`-d). It honours the arguments below and emits the JSON contract.

## Runtime + model (manual)

Use an OSS Whisper runtime, e.g.:

- **whisper.cpp** — build `main`, point `WHISPER_BINARY` at it and `WHISPER_MODEL_PATH` at a GGML model
  (e.g. `ggml-base.en.bin`); CPU-only and fully offline.
- **faster-whisper** — a small CLI wrapper around `WhisperModel` works too.

The adapter invokes the binary as:

```
<WHISPER_BINARY> --model <WHISPER_MODEL_PATH> --language <lang> --output json --word-timestamps <audio>
```

and expects **word-timestamped JSON on stdout** in this shape (faster-whisper style; seconds):

```json
{
  "text": "Help yourself now",
  "segments": [
    { "words": [{ "word": "Help", "start": 0.0, "end": 0.4 }] }
  ]
}
```

If your tool's flags or output differ, point `WHISPER_BINARY` at a thin wrapper that honours the
arguments above and emits this JSON contract.
