"""The `whetstone-qwen` console script: the provider-neutral local speech contract over Qwen3-ASR.

The server's local speech adapter (`localSpeechInput.ts`, #799) invokes the configured
`LOCAL_ASR_BINARY` two ways, and this launcher answers both:

1. **Readiness probe** — `whetstone-qwen --contract-version` prints a compact JSON descriptor and exits
   0 WITHOUT loading a model or touching audio. It carries the exact contract version (required to
   match) plus, for `pnpm setup:doctor`, the provider name, the pinned model revision, and the resource
   requirements. Because it loads nothing, doctor stays cheap.

2. **Transcription** — `whetstone-qwen --model <id> --output json <audio>` decodes the saved capture and
   runs CPU float32 Qwen3-ASR with automatic language detection, emitting the transcript-first JSON
   contract. No language is forced and no aligner runs, so `segments` is always empty: the transcript is
   the payload and word timing is optional evidence this provider does not produce.

   ```json
   {"text": "你好世界", "language": "zh", "segments": []}
   ```

Model loading and audio decoding are the un-fakeable native/inference boundary (`_default_transcriber`),
excluded from unit coverage; the argument contract, the JSON shaping, and the cheap probe are what the
tests pin against a fake transcriber so no real model or network is needed.
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


def _default_transcriber(model: str) -> Callable[[str], Dict[str, Any]]:  # pragma: no cover - inference boundary
    """Build the real CPU float32 Qwen3-ASR transcriber, loaded at the pinned revision.

    Decoding is content-sniffed via PyAV (no system FFmpeg, extension-independent), and inference runs
    on CPU in float32 with automatic language detection. This is the un-fakeable native boundary; the
    tested logic drives `main` with a fake transcriber instead.
    """
    from qwen_asr import QwenASR  # type: ignore

    from .audio import open_audio

    engine = QwenASR.from_pretrained(model, revision=MODEL_REVISION, device="cpu")

    def transcribe(audio_path: str) -> Dict[str, Any]:
        # Fail loud if the capture is missing / unreadable before handing it to the model.
        open_audio(audio_path).close()
        output = engine.transcribe(audio_path)
        if isinstance(output, dict):
            return output
        return {"text": output}

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
