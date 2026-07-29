"""Decode the browser's saved capture into a waveform for Qwen3-ASR — content-sniffed, no system FFmpeg.

The voice diary saves the browser's `MediaRecorder` output (WebM/Opus) and hands the file to the local
speech provider. Two properties matter here and are the tested contract of this module:

1. **The container format is detected by CONTENT, never by the file extension.** The saved capture may
   carry a `.audio` suffix (whetstone's retained-source naming) rather than `.webm`, so any decoder that
   branches on the extension would fail. `open_audio` forwards the path to the container opener verbatim
   and never inspects or rewrites the suffix.
2. **No system FFmpeg is required.** The default opener is PyAV, whose wheels bundle the ffmpeg
   libraries, so decoding works on a clean host with nothing installed globally.

`decode_waveform` turns that container into the mono 16 kHz float32 waveform Qwen consumes, so the
provider hands the model the *decoded samples* — never the original file path. That is what keeps
decoding inside PyAV's bundled ffmpeg: if Qwen were handed the `.audio` path it would re-open it with
librosa/soundfile, which needs a system ffmpeg for WebM/Opus and keys off the extension, so a `.audio`
capture would fail on a clean host.

The real PyAV open + resample is an un-fakeable native boundary (`_default_opener` / `_default_resampler`)
and is excluded from unit coverage the way the model load is; the suffix-independence contract and the
decode→resample orchestration are what the tests pin (with a real WebM/Opus round-trip when PyAV is
available, and a fake opener/resampler otherwise).
"""
from __future__ import annotations

import os
from typing import Any, Callable, List, Tuple

# Qwen3-ASR consumes 16 kHz mono audio; `decode_waveform` resamples every capture to this rate.
TARGET_SAMPLE_RATE = 16000


def _default_opener(path: str) -> Any:  # pragma: no cover - real PyAV/ffmpeg boundary, not unit-tested
    import av

    return av.open(path)


def _default_resampler() -> Any:  # pragma: no cover - real PyAV/ffmpeg boundary, not unit-tested
    import av

    # Mono, 16 kHz, packed float32 ("flt") — exactly Qwen3-ASR's expected input, produced by PyAV's
    # bundled ffmpeg so no system resampler is required.
    return av.AudioResampler(format="flt", layout="mono", rate=TARGET_SAMPLE_RATE)


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


def decode_waveform(
    path: str,
    opener: Callable[[str], Any] = _default_opener,
    resampler_factory: Callable[[], Any] = _default_resampler,
) -> Tuple[Any, int]:
    """Decode the saved capture into a `(mono 16 kHz float32 waveform, sample_rate)` pair with PyAV.

    The capture is opened by CONTENT (see `open_audio`) and every audio frame is resampled to Qwen's
    16 kHz mono float32 input. The returned waveform — never the original file path — is what the
    provider hands to the model, so a browser WebM/Opus capture saved under a `.audio` suffix decodes
    through PyAV's bundled ffmpeg and transcribes on a clean host with no system ffmpeg installed.

    `opener` and `resampler_factory` are injected so the orchestration is testable; the defaults are the
    real PyAV boundary.
    """
    import numpy as np

    container = open_audio(path, opener=opener)
    resampler = resampler_factory()
    blocks: List[Any] = []
    try:
        for frame in container.decode(audio=0):
            for resampled in resampler.resample(frame):
                blocks.append(np.asarray(resampled.to_ndarray(), dtype=np.float32).reshape(-1))
        # Flush any samples buffered inside the resampler (its tail) so nothing is dropped.
        for resampled in resampler.resample(None):
            blocks.append(np.asarray(resampled.to_ndarray(), dtype=np.float32).reshape(-1))
    finally:
        container.close()
    waveform = np.concatenate(blocks) if blocks else np.zeros(0, dtype=np.float32)
    return waveform.astype(np.float32), TARGET_SAMPLE_RATE
