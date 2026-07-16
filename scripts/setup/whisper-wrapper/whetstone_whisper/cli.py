"""faster-whisper CLI wrapper emitting whetstone's word-timestamp JSON contract.

The server's local Whisper adapter (`whisperSpeechInput.ts`) invokes a binary as:

    <WHISPER_BINARY> --model <model> --language auto --output json --word-timestamps <audio>

and expects word-timestamped JSON on stdout (faster-whisper style, seconds). Whetstone always requests
automatic language detection (`--language auto`, #647) — there is no forced-language override — so the
wrapper maps `auto` to faster-whisper's `language=None` (which triggers detection) and reports the
language the model detected back in the contract:

    {"text": "Help", "language": "en", "segments": [{"words": [{"word": "Help", "start": 0.0, "end": 0.4}]}]}

`language` is informational; it is null when the model reported none. This module is that binary: pip
installs it as the `whetstone-whisper` console script (a native launcher on every OS), so `execFile`
can run it directly. See docs/SPEECH.md. Model loading is isolated behind `model_loader` so the
arg-parsing and JSON-shaping logic is unit-tested against a mock model with no real inference or network.
"""
from __future__ import annotations

import argparse
import json
import sys
from typing import Any, Callable, List, Optional, Sequence


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    """Parse the exact contract arguments the adapter passes."""
    parser = argparse.ArgumentParser(prog="whetstone-whisper")
    parser.add_argument("--model", required=True)
    # Whetstone always passes `auto` (automatic detection); a literal code is still accepted for a manual
    # invocation. `auto` maps to faster-whisper's `language=None` in `transcribe_to_contract`.
    parser.add_argument("--language", default="auto")
    # Accepted for contract compatibility; output is always the JSON contract below.
    parser.add_argument("--output", default="json")
    parser.add_argument(
        "--word-timestamps", dest="word_timestamps", action="store_true"
    )
    parser.add_argument("audio")
    return parser.parse_args(list(argv))


def transcribe_to_contract(model: Any, audio: str, language: str) -> dict:
    """Run the model with word timestamps and map its output to the JSON contract.

    `language == "auto"` requests automatic detection (`language=None`); any other value forces that
    language. The language the model detected is read from the returned info and echoed as `language`
    (null when the model reported none). Times are emitted in **seconds** (as faster-whisper produces
    them); the Node adapter converts to integer milliseconds at its validating boundary.
    """
    requested = None if language == "auto" else language
    segments, info = model.transcribe(
        audio, language=requested, word_timestamps=True
    )

    text_parts: List[str] = []
    out_segments: List[dict] = []
    for segment in segments:
        text_parts.append(segment.text or "")
        words = []
        for word in segment.words or []:
            words.append(
                {
                    "word": word.word,
                    "start": float(word.start),
                    "end": float(word.end),
                }
            )
        out_segments.append({"words": words})

    detected = getattr(info, "language", None)
    return {
        "text": "".join(text_parts).strip(),
        "language": detected,
        "segments": out_segments,
    }


def _load_model(model: str) -> Any:  # pragma: no cover - real inference boundary, not unit-tested
    from faster_whisper import WhisperModel

    return WhisperModel(model)


def main(
    argv: Optional[Sequence[str]] = None,
    model_loader: Callable[[str], Any] = _load_model,
) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    model = model_loader(args.model)
    contract = transcribe_to_contract(model, args.audio, args.language)
    json.dump(contract, sys.stdout)
    return 0


if __name__ == "__main__":  # pragma: no cover - process entry
    raise SystemExit(main())
