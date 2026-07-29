"""Decode the browser's saved capture into a waveform for Qwen3-ASR — content-sniffed, no system FFmpeg.

The voice diary saves the browser's `MediaRecorder` output (WebM/Opus) and hands the file to the local
speech provider. Two properties matter here and are the tested contract of this module:

1. **The container format is detected by CONTENT, never by the file extension.** The saved capture may
   carry a `.audio` suffix (whetstone's retained-source naming) rather than `.webm`, so any decoder that
   branches on the extension would fail. `open_audio` forwards the path to the container opener verbatim
   and never inspects or rewrites the suffix.
2. **No system FFmpeg is required.** The default opener is PyAV, whose wheels bundle the ffmpeg
   libraries, so decoding works on a clean host with nothing installed globally.

The real PyAV open + resample is an un-fakeable native boundary (`_default_opener`) and is excluded from
unit coverage the way the model load is; the suffix-independence contract is what the tests pin.
"""
from __future__ import annotations

import os
from typing import Any, Callable

# Qwen3-ASR consumes 16 kHz mono audio; the real transcriber resamples to this rate.
TARGET_SAMPLE_RATE = 16000


def _default_opener(path: str) -> Any:  # pragma: no cover - real PyAV/ffmpeg boundary, not unit-tested
    import av

    return av.open(path)


def open_audio(path: str, opener: Callable[[str], Any] = _default_opener) -> Any:
    """Open the saved capture by CONTENT, returning the container the caller decodes.

    The path is passed to `opener` exactly as given: the file extension is never read, stripped, or
    used to pick a demuxer, so a browser WebM/Opus capture saved with a `.audio` suffix opens the same
    as a `.webm` one. Raises `FileNotFoundError` before touching the opener when the file is absent, so
    a missing capture fails with a clear, decoder-independent error.
    """
    if not os.path.exists(path):
        raise FileNotFoundError(path)
    return opener(path)
