"""The `whetstone-qwen` console script: the provider-neutral local speech contract over Qwen3-ASR.

The server's local speech adapter (`localSpeechInput.ts`, #799) invokes the configured
`LOCAL_ASR_BINARY` three ways, and this launcher answers all three:

1. **Readiness probe** — `whetstone-qwen --contract-version` prints a compact JSON descriptor and exits
   0 WITHOUT loading a model or touching audio. It carries the exact contract version (required to
   match) plus, for `pnpm setup:doctor`, the provider name, the pinned model revision, whether this
   build supports persistent mode (#884, below), and the resource requirements. Because it loads
   nothing, doctor stays cheap.

2. **One-shot transcription** — `whetstone-qwen --model <id> --output json <audio>` decodes the saved
   capture to a 16 kHz mono waveform (PyAV, content-sniffed) and hands that waveform to CPU float32
   Qwen3-ASR with automatic language detection, emitting the transcript-first JSON contract. No language
   is forced and no aligner runs, so `segments` is always empty: the transcript is the payload and word
   timing is optional evidence this provider does not produce.

   ```json
   {"text": "你好世界", "language": "Chinese", "segments": []}
   ```

3. **Persistent mode (#884)** — `whetstone-qwen --persistent --model <id>` loads the model exactly ONCE
   and then serves requests over a stdin/stdout line protocol instead of exiting: each stdin line is an
   audio path, and each response is one stdout line carrying the SAME transcript-first JSON contract
   above. This lets the Node-side persistent-process manager keep the model warm across a burst of
   captures instead of paying the cold model load on every single one. The process serves one request at
   a time (no concurrency) and keeps running until its stdin is closed or it is killed. A per-request
   failure is deliberately fatal (prints to stderr, exits non-zero) rather than emitting an off-contract
   line: process death is the documented signal the Node-side manager watches for to fail that capture
   and transparently respawn on the next one (see `docs/SPEECH.md`).

Loading the model and the native PyAV decode are the un-fakeable inference boundary (`_default_transcriber`
/ `whetstone_qwen.audio`), excluded from unit coverage; the argument contract, the JSON shaping, the cheap
probe, the decode→engine routing (`_transcribe_capture`), and the persistent-mode line loop are what the
tests pin against a fake engine, a fake decode, and in-memory stdin/stdout, so no real model or network is
needed.
"""
from __future__ import annotations

import argparse
import json
import sys
from typing import Any, Callable, Dict, Optional, Sequence

# The executable argument/output contract version. Bumped only when the CLI contract changes, NOT on
# every package release. `pnpm setup:voice` / `pnpm setup:doctor` require an exact match. Keep in
# lockstep with SUPPORTED_SPEECH_CONTRACT_VERSION in scripts/setup/steps/voice.mjs and
# LOCAL_SPEECH_CONTRACT_VERSION in src/apps/server/src/speech/localSpeechInput.ts.
CONTRACT_VERSION = "1"

# The cheap readiness-probe flag (kept as a constant so the launcher and its tests agree on the token).
CONTRACT_VERSION_FLAG = "--contract-version"

# Provider identity + the immutable model revision this build installs. Keep the revision in lockstep
# with QWEN_MODEL_REVISION in scripts/setup/steps/voice.mjs — the default only moves with measured
# real-speech fidelity, so the revision is pinned, never floating on a mutable tag.
PROVIDER = "qwen3-asr-1.7b"
MODEL_REVISION = "7278e1e70fe206f11671096ffdd38061171dd6e5"

# Resource floor the provisioner preflights before a large download/load, surfaced to doctor here so the
# operator sees the requirement from the cheap probe. Keep in lockstep with REQUIRED_* in voice.mjs. Under
# persistent mode (#884) this is no longer a one-time install-time cost: it applies whenever a capture has
# landed within the last IDLE_UNLOAD_MS (see persistentSpeechManager.ts) while the process stays resident.
REQUIRED_DISK_GIB = 12
REQUIRED_MEMORY_GIB = 12

# The persistent-mode flag (#884): loads the model once, then serves one capture at a time over a
# stdin/stdout line protocol instead of exiting after a single transcription. Kept as a constant so the
# launcher and its tests agree on the token, mirroring CONTRACT_VERSION_FLAG above.
PERSISTENT_FLAG = "--persistent"


def contract_version_report() -> str:
    """The machine-readable probe payload: the contract version plus the doctor descriptor, one line.

    `persistent: true` (#884) declares that this build understands `--persistent`, so the Node-side
    resolver can auto-use the warm-process protocol instead of falling back to a fresh spawn per capture.
    """
    return json.dumps(
        {
            "contractVersion": CONTRACT_VERSION,
            "provider": PROVIDER,
            "revision": MODEL_REVISION,
            "persistent": True,
            "requirements": {"diskGiB": REQUIRED_DISK_GIB, "memoryGiB": REQUIRED_MEMORY_GIB},
        }
    )


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    """Parse the provider-neutral one-shot transcription contract arguments (#799).

    The adapter passes `--model <id> --output json <audio>`. No `--language` and no alignment flag are
    part of the neutral protocol: this provider always auto-detects and emits no word timings.
    """
    parser = argparse.ArgumentParser(prog="whetstone-qwen")
    parser.add_argument("--model", required=True)
    # Accepted for contract compatibility; output is always the JSON contract below.
    parser.add_argument("--output", default="json")
    parser.add_argument("audio")
    return parser.parse_args(list(argv))


def parse_persistent_args(argv: Sequence[str]) -> argparse.Namespace:
    """Parse the persistent-mode invocation (#884): `--persistent --model <id>`, no audio positional —
    each capture's audio path arrives later, one per stdin line."""
    parser = argparse.ArgumentParser(prog="whetstone-qwen")
    parser.add_argument("--model", required=True)
    return parser.parse_args(list(argv))


def build_contract(result: Dict[str, Any]) -> Dict[str, Any]:
    """Shape a transcriber result into the transcript-first JSON contract.

    `text` is required and trimmed; `language` is echoed only when the model reports a string (null
    otherwise) and never rewrites or rejects the transcript; `segments` is always empty because this
    provider has no aligner. A malformed/absent `text` becomes an empty transcript rather than a crash.
    """
    text = result.get("text")
    language = result.get("language")
    return {
        "text": str(text).strip() if text is not None else "",
        "language": language if isinstance(language, str) else None,
        "segments": [],
    }


def _language_or_none(language: Any) -> Any:
    """Normalize a provider language field to a non-empty string or None.

    Qwen reports a canonical language name (e.g. `"Chinese"`, or `"Chinese,English"` for mixed audio) and
    an EMPTY string for silent/unknown audio. The neutral contract carries `language` only when the
    provider actually detected one, so an empty/whitespace value collapses to None rather than an empty
    string the server would otherwise store verbatim.
    """
    if isinstance(language, str):
        stripped = language.strip()
        return stripped or None
    return None


def _transcribe_capture(engine: Any, decode: Callable[[str], Any], audio_path: str) -> Dict[str, Any]:
    """Decode the saved capture to a waveform and hand THAT waveform — never the raw path — to Qwen.

    `decode(audio_path)` returns `(waveform, sample_rate)` from PyAV's bundled ffmpeg, and that decoded
    audio is what `engine.transcribe` consumes. Passing the decoded `(waveform, sr)` (not the file path)
    is the whole point: it keeps decoding inside PyAV, so a browser WebM/Opus capture saved under a
    `.audio` suffix transcribes on a clean host instead of failing when Qwen re-opens the path with a
    codec that needs a system ffmpeg. `transcribe` returns one `ASRTranscription` per input audio; we
    pass a single clip and read the first result's `text`/`language`.
    """
    waveform, sample_rate = decode(audio_path)
    result = engine.transcribe([(waveform, sample_rate)])[0]
    return {"text": getattr(result, "text", ""), "language": _language_or_none(getattr(result, "language", None))}


def _default_transcriber(model: str) -> Callable[[str], Dict[str, Any]]:  # pragma: no cover - inference boundary
    """Build the real CPU float32 Qwen3-ASR transcriber, loaded at the pinned revision.

    The capture is decoded to a 16 kHz mono float32 waveform by PyAV (`decode_waveform`, content-sniffed,
    no system FFmpeg) and that waveform is handed to Qwen — the model never re-opens the file path, so a
    `.audio` WebM/Opus capture transcribes on a clean host. Inference runs on CPU in float32 with
    automatic language detection. This is the un-fakeable native boundary; the tested logic drives
    `_transcribe_capture` / `main` with a fake engine and a fake decode instead.
    """
    from qwen_asr import Qwen3ASRModel  # type: ignore

    from .audio import decode_waveform

    engine = Qwen3ASRModel.from_pretrained(model, revision=MODEL_REVISION, torch_dtype="float32")

    def transcribe(audio_path: str) -> Dict[str, Any]:
        return _transcribe_capture(engine, decode_waveform, audio_path)

    return transcribe


def run_persistent(
    model: str,
    transcriber_factory: Callable[[str], Callable[[str], Dict[str, Any]]],
    stdin: Any,
    stdout: Any,
) -> int:
    """Serve the #884 persistent-mode line protocol: load the model ONCE, then read one audio path per
    stdin line and write one transcript-first JSON contract line per stdout response — the SAME contract
    `build_contract` emits in one-shot mode, so the Node-side adapter's parser needs no persistent-mode
    branch. Runs until stdin reaches EOF (the Node-side manager closes it, or the process is killed),
    then returns 0.

    A blank line is ignored (never an audio path a caller would send). Any transcription failure is
    deliberately FATAL here rather than an off-contract response line: the wrapper prints the error to
    stderr and returns 1, so the OS process exit is the signal the Node-side persistent-process manager
    already watches for to fail that one in-flight capture and transparently respawn on the next one
    (`docs/SPEECH.md`, `persistentSpeechManager.ts`) — no second failure protocol to keep in lockstep.
    """
    transcriber = transcriber_factory(model)
    for raw_line in stdin:
        audio_path = raw_line.rstrip("\n").rstrip("\r")
        if audio_path == "":
            continue
        try:
            contract = build_contract(transcriber(audio_path))
        except Exception as exc:  # noqa: BLE001 - deliberately fatal; see docstring
            print(f"whetstone-qwen persistent request failed: {exc}", file=sys.stderr)
            return 1
        stdout.write(json.dumps(contract, ensure_ascii=False))
        stdout.write("\n")
        stdout.flush()
    return 0


def main(
    argv: Optional[Sequence[str]] = None,
    transcriber_factory: Callable[[str], Callable[[str], Dict[str, Any]]] = _default_transcriber,
) -> int:
    raw = list(sys.argv[1:] if argv is None else argv)
    # The cheap readiness probe: emit the descriptor and exit BEFORE any model load or audio access, so
    # doctor pays nothing. Checked ahead of `parse_args` because the probe takes none of the
    # transcription arguments.
    if CONTRACT_VERSION_FLAG in raw:
        sys.stdout.write(contract_version_report())
        return 0
    # Persistent mode (#884): checked ahead of the one-shot `parse_args` because it takes no audio
    # positional — the audio path arrives per stdin line instead, after the model has loaded once.
    if PERSISTENT_FLAG in raw:
        remaining = [arg for arg in raw if arg != PERSISTENT_FLAG]
        persistent_args = parse_persistent_args(remaining)
        return run_persistent(persistent_args.model, transcriber_factory, sys.stdin, sys.stdout)
    args = parse_args(raw)
    transcriber = transcriber_factory(args.model)
    contract = build_contract(transcriber(args.audio))
    json.dump(contract, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":  # pragma: no cover - process entry
    raise SystemExit(main())
