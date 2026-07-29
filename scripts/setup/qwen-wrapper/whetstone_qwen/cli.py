"""The `whetstone-qwen` console script: the provider-neutral local speech contract over Qwen3-ASR.

The server's local speech adapter (`localSpeechInput.ts`, #799) invokes the configured
`LOCAL_ASR_BINARY` two ways, and this launcher answers both:

1. **Readiness probe** — `whetstone-qwen --contract-version` prints a compact JSON descriptor and exits
   0 WITHOUT loading a model or touching audio. It carries the exact contract version (required to
   match) plus, for `pnpm setup:doctor`, the provider name, the pinned model revision, and the resource
   requirements. Because it loads nothing, doctor stays cheap.

2. **Transcription** — `whetstone-qwen --model <id> --output json <audio>` decodes the saved capture to a
   16 kHz mono waveform (PyAV, content-sniffed) and hands that waveform to CPU float32 Qwen3-ASR with
   automatic language detection, emitting the transcript-first JSON contract. No language is forced and
   no aligner runs, so `segments` is always empty: the transcript is the payload and word timing is
   optional evidence this provider does not produce.

   ```json
   {"text": "你好世界", "language": "Chinese", "segments": []}
   ```

Loading the model and the native PyAV decode are the un-fakeable inference boundary (`_default_transcriber`
/ `whetstone_qwen.audio`), excluded from unit coverage; the argument contract, the JSON shaping, the cheap
probe, and the decode→engine routing (`_transcribe_capture`) are what the tests pin against a fake engine
and a fake decode, so no real model or network is needed.
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
# operator sees the requirement from the cheap probe. Keep in lockstep with REQUIRED_* in voice.mjs.
REQUIRED_DISK_GIB = 12
REQUIRED_MEMORY_GIB = 12


def contract_version_report() -> str:
    """The machine-readable probe payload: the contract version plus the doctor descriptor, one line."""
    return json.dumps(
        {
            "contractVersion": CONTRACT_VERSION,
            "provider": PROVIDER,
            "revision": MODEL_REVISION,
            "requirements": {"diskGiB": REQUIRED_DISK_GIB, "memoryGiB": REQUIRED_MEMORY_GIB},
        }
    )


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    """Parse the provider-neutral transcription contract arguments (#799).

    The adapter passes `--model <id> --output json <audio>`. No `--language` and no alignment flag are
    part of the neutral protocol: this provider always auto-detects and emits no word timings.
    """
    parser = argparse.ArgumentParser(prog="whetstone-qwen")
    parser.add_argument("--model", required=True)
    # Accepted for contract compatibility; output is always the JSON contract below.
    parser.add_argument("--output", default="json")
    parser.add_argument("audio")
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
    args = parse_args(raw)
    transcriber = transcriber_factory(args.model)
    contract = build_contract(transcriber(args.audio))
    json.dump(contract, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":  # pragma: no cover - process entry
    raise SystemExit(main())
