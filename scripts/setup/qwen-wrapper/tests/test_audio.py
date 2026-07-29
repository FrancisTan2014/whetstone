"""Unit tests for audio.open_audio — the content-sniffing, extension-independent decode seam.

The acceptance contract: the browser's WebM/Opus capture decodes even when saved with a `.audio` suffix,
without a system FFmpeg. These tests pin the suffix-independence (the path reaches the opener verbatim,
never rewritten by extension) and the missing-file failure, with a fake opener — no PyAV needed.
"""
import tempfile
import unittest
from pathlib import Path

from whetstone_qwen.audio import open_audio


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


if __name__ == "__main__":
    unittest.main()
