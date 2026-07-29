"""Unit tests for audio.open_audio / audio.decode_waveform — the content-sniffing decode seam.

The acceptance contract: the browser's WebM/Opus capture decodes into a 16 kHz mono waveform even when
saved with a `.audio` suffix, without a system FFmpeg. `open_audio` tests pin the suffix-independence (the
path reaches the opener verbatim, never rewritten by extension) and the missing-file failure with a fake
opener — no PyAV needed. `decode_waveform` is proven two ways: a fake opener/resampler pins the
decode→resample→concat orchestration, and a real PyAV round-trip (encode a `.audio` WebM/Opus, decode it)
proves the actual native path works with PyAV's bundled ffmpeg when `av` is installed.
"""
import math
import tempfile
import unittest
from pathlib import Path

from whetstone_qwen.audio import TARGET_SAMPLE_RATE, decode_waveform, open_audio

try:
    import numpy as np  # type: ignore

    _HAVE_NP = True
except Exception:  # pragma: no cover - environment probe
    _HAVE_NP = False

try:
    import av  # type: ignore

    _HAVE_AV = True
except Exception:  # pragma: no cover - environment probe
    _HAVE_AV = False


class OpenAudioTests(unittest.TestCase):
    def test_forwards_a_dot_audio_capture_to_the_opener_verbatim(self):
        seen = {}
        with tempfile.TemporaryDirectory() as directory:
            # A browser WebM/Opus capture saved under whetstone's `.audio` retained-source suffix.
            path = Path(directory) / "capture.audio"
            path.write_bytes(b"\x1aE\xdf\xa3")  # EBML/WebM magic bytes (content, not extension)

            def opener(given):
                seen["path"] = given
                return "container"

            container = open_audio(str(path), opener=opener)
        self.assertEqual(container, "container")
        # The exact path — including the `.audio` extension — reaches the opener unchanged; decoding is
        # decided by content, never by rewriting or stripping the suffix.
        self.assertEqual(seen["path"], str(path))

    def test_a_webm_suffix_reaches_the_opener_the_same_way(self):
        seen = {}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "capture.webm"
            path.write_bytes(b"\x1aE\xdf\xa3")
            open_audio(str(path), opener=lambda given: seen.setdefault("path", given))
        self.assertEqual(seen["path"], str(Path(directory) / "capture.webm"))

    def test_raises_a_clear_error_before_opening_a_missing_capture(self):
        calls = []
        with self.assertRaises(FileNotFoundError):
            open_audio("/no/such/capture.audio", opener=lambda given: calls.append(given))
        # The opener is never reached for a missing file — the failure is decoder-independent.
        self.assertEqual(calls, [])


class _FakeFrame:
    def __init__(self, samples):
        self._samples = samples

    def to_ndarray(self):
        # PyAV hands back shape (channels, samples) for packed formats; mono is (1, N).
        return np.asarray([self._samples], dtype=np.float32)


class _FakeResampler:
    """Echoes each decoded frame and yields nothing on the flush call (frame is None)."""

    def resample(self, frame):
        return [] if frame is None else [frame]


class _FakeContainer:
    def __init__(self, frames):
        self._frames = frames
        self.closed = False

    def decode(self, audio=0):  # noqa: ARG002 - stream selector unused in the fake
        return iter(self._frames)

    def close(self):
        self.closed = True


@unittest.skipUnless(_HAVE_NP, "numpy is required for decode_waveform")
class DecodeWaveformOrchestrationTests(unittest.TestCase):
    """Pin the decode->resample->concat orchestration with a fake opener/resampler (no PyAV)."""

    def _decode(self, frames):
        container = _FakeContainer(frames)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "capture.audio"
            path.write_bytes(b"\x1aE\xdf\xa3")
            waveform, sample_rate = decode_waveform(
                str(path), opener=lambda _p: container, resampler_factory=_FakeResampler
            )
        return waveform, sample_rate, container

    def test_concatenates_every_resampled_frame_and_reports_16k(self):
        waveform, sample_rate, container = self._decode(
            [_FakeFrame([0.1, 0.2]), _FakeFrame([0.3])]
        )
        self.assertEqual(sample_rate, TARGET_SAMPLE_RATE)
        self.assertEqual(waveform.dtype, np.float32)
        np.testing.assert_allclose(waveform, [0.1, 0.2, 0.3], rtol=0, atol=1e-6)
        # The container is always closed, even though the caller keeps only the samples.
        self.assertTrue(container.closed)

    def test_silent_capture_yields_an_empty_float32_waveform(self):
        waveform, sample_rate, _ = self._decode([])
        self.assertEqual(sample_rate, TARGET_SAMPLE_RATE)
        self.assertEqual(waveform.dtype, np.float32)
        self.assertEqual(waveform.shape[0], 0)


@unittest.skipUnless(_HAVE_AV and _HAVE_NP, "PyAV + numpy are required for the real WebM/Opus round-trip")
class DecodeWaveformWebmIntegrationTests(unittest.TestCase):
    """Prove the ACTUAL native path: a browser-style WebM/Opus capture saved under a `.audio` suffix
    decodes to a 16 kHz mono waveform through PyAV's bundled ffmpeg — no system ffmpeg, extension-blind.
    This is the regression the reviewer asked for: it exercises `decode_waveform`'s real opener +
    resampler end to end, not a fake."""

    @staticmethod
    def _write_webm_opus(path, seconds, freq=440.0, sr=48000):
        # 20 ms Opus frames (960 samples @ 48 kHz) so the encoder accepts each frame directly.
        frame_samples = 960
        total = int(seconds * sr)
        container = av.open(str(path), mode="w", format="webm")
        try:
            stream = container.add_stream("libopus", rate=sr)
            stream.layout = "mono"
            pts = 0
            for start in range(0, total, frame_samples):
                block = [
                    0.2 * math.sin(2 * math.pi * freq * (start + i) / sr)
                    for i in range(frame_samples)
                ]
                frame = av.AudioFrame.from_ndarray(
                    np.asarray([block], dtype=np.float32), format="flt", layout="mono"
                )
                frame.sample_rate = sr
                frame.pts = pts
                pts += frame_samples
                for packet in stream.encode(frame):
                    container.mux(packet)
            for packet in stream.encode(None):
                container.mux(packet)
        finally:
            container.close()

    def test_decodes_a_dot_audio_webm_to_a_16k_mono_waveform(self):
        seconds = 1.0
        with tempfile.TemporaryDirectory() as directory:
            # Saved under whetstone's `.audio` retained-source suffix, NOT `.webm`.
            path = Path(directory) / "capture.audio"
            try:
                self._write_webm_opus(path, seconds)
            except Exception as error:  # pragma: no cover - codec availability varies by wheel
                self.skipTest(f"this PyAV build cannot encode WebM/Opus: {error}")
            waveform, sample_rate = decode_waveform(str(path))

        self.assertEqual(sample_rate, TARGET_SAMPLE_RATE)
        self.assertEqual(waveform.dtype, np.float32)
        # ~1 s of 16 kHz audio; Opus adds priming/padding, so allow a generous tolerance.
        expected = seconds * TARGET_SAMPLE_RATE
        self.assertGreater(waveform.shape[0], expected * 0.5)
        self.assertLess(waveform.shape[0], expected * 2.0)
        # The tone survived the round-trip — decoding produced real, non-silent samples.
        self.assertGreater(float(np.max(np.abs(waveform))), 0.0)


if __name__ == "__main__":
    unittest.main()
