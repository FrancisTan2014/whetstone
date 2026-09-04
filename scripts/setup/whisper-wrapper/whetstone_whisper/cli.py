"""faster-whisper CLI wrapper emitting whetstone's word-timestamp JSON contract.

The server's local Whisper adapter (`whisperSpeechInput.ts`) invokes a binary as:

    <WHISPER_BINARY> --model <model> --language auto --output json --word-timestamps <audio>

and expects word-timestamped JSON on stdout (faster-whisper style, seconds). Whetstone always requests
automatic language detection (`--language auto`, #647) — there is no forced-language override. A single
whole-file `transcribe` call can only detect ONE language and then silently drops the speech in the
other language when a capture mixes languages (#909), so for `auto` the wrapper first splits the
recording into utterances with the Silero VAD faster-whisper already ships, then detects + decodes EACH
utterance independently and concatenates them in time order:

    {"text": "你好 Help", "language": "zh", "segments": [
      {"language": "zh", "words": [{"word": "你好", "start": 0.0, "end": 0.8}]},
      {"language": "en", "words": [{"word": "Help", "start": 1.2, "end": 1.6}]}]}

Every segment reports the language detected for its utterance, and word timings are shifted back into
absolute file time so they stay monotonic across utterance boundaries. A forced language (any value
other than `auto`) keeps the original single whole-file call. The top-level `language` is retained as the
recording's opening language (the first utterance's detection, null when none) for the single-language
`SpeechInput` seam, so `whisperSpeechInput.ts` stays backward-compatible; per-segment `language` is
additive, informational evidence. This module is that binary: pip installs it as the `whetstone-whisper`
console script (a native launcher on every OS), so `execFile` can run it directly. See docs/SPEECH.md.
Model construction (`model_loader`) and VAD utterance detection (`segmenter`) are both isolated behind
injectable seams so the segmentation and JSON-shaping logic is unit-tested against a mock model with no
real inference or network.

The launcher also answers a cheap machine-readable readiness probe, `--contract-version`, which prints
the executable contract version and exits WITHOUT loading a model or touching audio. `pnpm setup:voice`
runs this through the configured `WHISPER_BINARY` so voice readiness can require the exact supported
contract version instead of trusting a launcher file's mere presence: a wrapper installed before the
`--language auto` -> `None` fix (which still forwards the literal "auto" and predates this probe) is
detected as incompatible and repaired, rather than reported ready. The contract version is deliberately
independent of the pip package version (two stale packages can share a release version) and is bumped
only when the shared readiness contract changes — see the note on `CONTRACT_VERSION` below for why the
#909 additive output change does not bump it.
"""
from __future__ import annotations

import argparse
import json
import sys
from typing import Any, Callable, List, Optional, Sequence, Tuple

# The executable's readiness-probe contract version, reported by `--contract-version`. Bumped only when
# the CLI's argument/readiness contract changes (e.g. the `--language auto` -> detection mapping), NOT on
# every package release. This is the SHARED local-speech readiness protocol: `pnpm setup:voice` /
# `pnpm setup:doctor` require the probe to match `SUPPORTED_SPEECH_CONTRACT_VERSION` in
# scripts/setup/steps/voice.mjs exactly, and the provider-neutral `whetstone-qwen` wrapper plus any
# `LOCAL_ASR_BINARY` must match that same value — so it stays in lockstep across providers.
#
# #909 added a per-utterance `language` to each output segment. That is an ADDITIVE, backward-compatible
# change (the top-level `language` is retained and every existing consumer ignores the extra field), so
# the readiness/compatibility contract is unchanged and this value is deliberately NOT bumped — bumping
# it would falsely fail the out-of-scope Qwen / `LOCAL_ASR_*` readiness, which shares this exact version.
CONTRACT_VERSION = "1"

# The flag that triggers the readiness probe. Kept as a module constant so the wrapper and its tests
# agree on the exact token the Node setup step invokes.
CONTRACT_VERSION_FLAG = "--contract-version"


def contract_version_report() -> str:
    """The machine-readable probe payload: the supported contract version as compact JSON on one line."""
    return json.dumps({"contractVersion": CONTRACT_VERSION})


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


# faster-whisper resamples every input to 16 kHz; the Silero VAD reports speech spans in samples at this
# rate, so it also converts a sample index to absolute seconds.
SAMPLING_RATE = 16000


def _detect_utterances(audio: str) -> List[Tuple[float, Any]]:  # pragma: no cover - real audio decode + Silero VAD, not unit-tested
    """Split the recording into speech utterances using the Silero VAD faster-whisper already ships.

    Decodes the file once, runs VAD, and returns each speech span as ``(offset_seconds, clip_samples)``
    in time order. The VAD model is bundled with faster-whisper, so this adds no download (see fetch.py).
    Each clip is handed to the model as an independent recording so language detection runs per utterance;
    ``offset_seconds`` shifts that clip's word timings back into absolute file time. Isolated behind the
    injectable ``segmenter`` seam so ``transcribe_to_contract`` stays testable with no real audio.
    """
    from faster_whisper.audio import decode_audio
    from faster_whisper.vad import VadOptions, get_speech_timestamps

    samples = decode_audio(audio, sampling_rate=SAMPLING_RATE)
    spans = get_speech_timestamps(samples, VadOptions())
    return [
        (span["start"] / SAMPLING_RATE, samples[span["start"] : span["end"]])
        for span in spans
    ]


def _transcribe_clip(
    model: Any, clip: Any, requested_language: Optional[str], offset: float
) -> Tuple[Optional[str], List[Tuple[str, List[dict]]]]:
    """Decode one clip and return ``(detected_language, [(segment_text, words)])``.

    ``requested_language`` is ``None`` to let the model detect (auto / per-utterance) or a forced code.
    Each word's ``start``/``end`` is shifted by ``offset`` seconds so a clip decoded in isolation lands
    back in absolute file time.
    """
    segments, info = model.transcribe(clip, language=requested_language, word_timestamps=True)
    shaped: List[Tuple[str, List[dict]]] = []
    for segment in segments:
        words = [
            {
                "word": word.word,
                "start": float(word.start) + offset,
                "end": float(word.end) + offset,
            }
            for word in segment.words or []
        ]
        shaped.append((segment.text or "", words))
    return getattr(info, "language", None), shaped


def transcribe_to_contract(
    model: Any,
    audio: str,
    language: str,
    segmenter: Callable[[str], List[Tuple[float, Any]]] = _detect_utterances,
) -> dict:
    """Map the model's word-timestamped output to the JSON contract, detecting language per utterance.

    For ``language == "auto"`` the recording is split into VAD utterances (via ``segmenter``) and each is
    detected + decoded on its own, so a capture that mixes languages keeps every utterance instead of
    losing the ones that differ from a single whole-file detection (#909). Any other value forces that
    language with the original single whole-file call. When VAD finds no utterance the whole file is
    decoded once (``language=None``) so nothing is ever dropped. Each output segment reports the language
    detected for its utterance; the top-level ``language`` is the first utterance's detection (the
    recording's opening language, null when none). Times are emitted in **seconds**; the Node adapter
    converts to integer milliseconds at its validating boundary.
    """
    requested = None if language == "auto" else language
    utterances = segmenter(audio) if language == "auto" else []
    if not utterances:
        # Forced language, or a recording VAD found no speech in: one whole-file decode, unchanged from
        # the original single call, so a single-language capture is never re-segmented or dropped.
        utterances = [(0.0, audio)]

    text_parts: List[str] = []
    out_segments: List[dict] = []
    languages: List[Optional[str]] = []
    # A running floor keeps word starts non-decreasing across utterance boundaries even if a clip's
    # timings or the VAD spans were ever ill-formed — absolute file time must stay monotonic (#909).
    floor = 0.0
    for offset, clip in utterances:
        detected, shaped = _transcribe_clip(model, clip, requested, offset)
        languages.append(detected)
        for text, words in shaped:
            monotonic: List[dict] = []
            for word in words:
                start = word["start"] if word["start"] >= floor else floor
                end = word["end"] if word["end"] >= start else start
                floor = start
                monotonic.append({"word": word["word"], "start": start, "end": end})
            text_parts.append(text)
            out_segments.append({"language": detected, "words": monotonic})

    top_language = next((lang for lang in languages if lang is not None), None)
    return {
        "text": "".join(text_parts).strip(),
        "language": top_language,
        "segments": out_segments,
    }


def _load_model(model: str) -> Any:  # pragma: no cover - real inference boundary, not unit-tested
    from faster_whisper import WhisperModel

    return WhisperModel(model)


def main(
    argv: Optional[Sequence[str]] = None,
    model_loader: Callable[[str], Any] = _load_model,
    segmenter: Callable[[str], List[Tuple[float, Any]]] = _detect_utterances,
) -> int:
    raw = list(sys.argv[1:] if argv is None else argv)
    # The cheap readiness probe: report the contract version and exit BEFORE any model load or audio
    # access, so `pnpm setup:voice` can verify compatibility without paying for inference. Checked ahead
    # of `parse_args` because the probe intentionally takes none of the transcription arguments.
    if CONTRACT_VERSION_FLAG in raw:
        sys.stdout.write(contract_version_report())
        return 0
    args = parse_args(raw)
    model = model_loader(args.model)
    contract = transcribe_to_contract(model, args.audio, args.language, segmenter=segmenter)
    json.dump(contract, sys.stdout)
    return 0


if __name__ == "__main__":  # pragma: no cover - process entry
    raise SystemExit(main())
