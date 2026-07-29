"""Unit tests for the provider-neutral calibration pipeline — manifest, scoring, aggregate, gate, privacy.

A fake runner returns canned transcripts + resource numbers, so no executable is spawned. The key
privacy contract — the emitted report contains only aggregate numbers, never a reference/transcript/audio
path — is pinned here.
"""
import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from whetstone_qwen import calibrate
from whetstone_qwen.calibrate import TranscriptMeasurement


def _runner_for(transcripts, duration_s=1.0, peak_rss_bytes=0):
    """A fake runner that returns the transcript keyed by audio path, plus fixed resource numbers."""

    def runner(_binary, _model, audio):
        return TranscriptMeasurement(transcripts[audio], duration_s, peak_rss_bytes)

    return runner


class LoadManifestTests(unittest.TestCase):
    def _write(self, directory, payload):
        path = Path(directory) / "manifest.json"
        path.write_text(json.dumps(payload), encoding="utf-8")
        return str(path)

    def test_reads_clips_and_defaults_lang_to_zh(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self._write(directory, {"clips": [{"audio": "a.audio", "reference": "你好"}]})
            self.assertEqual(
                calibrate.load_manifest(path),
                [{"audio": "a.audio", "reference": "你好", "lang": "zh"}],
            )

    def test_accepts_a_bare_list_and_keeps_an_explicit_lang(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self._write(directory, [{"audio": "b.audio", "reference": "hi", "lang": "en"}])
            self.assertEqual(calibrate.load_manifest(path)[0]["lang"], "en")

    def test_rejects_an_empty_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self._write(directory, {"clips": []})
            with self.assertRaises(ValueError):
                calibrate.load_manifest(path)

    def test_rejects_a_clip_missing_audio_or_reference(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self._write(directory, [{"audio": "a.audio"}])
            with self.assertRaises(ValueError):
                calibrate.load_manifest(path)


class AggregateTests(unittest.TestCase):
    def test_micro_cer_max_clip_cer_wer_duration_and_peak_rss(self):
        clips = [
            {"audio": "z1", "reference": "你好世界", "lang": "zh"},
            {"audio": "z2", "reference": "天下太平", "lang": "zh"},
            {"audio": "e1", "reference": "help yourself now", "lang": "en"},
        ]
        runner = _runner_for(
            {"z1": "你好世界", "z2": "天下太山", "e1": "help yourself later"},
            duration_s=12.5,
            peak_rss_bytes=2 * 1024**3,
        )
        records = calibrate.measure_clips(clips, "bin", "model", runner)
        summary = calibrate.aggregate(records)
        self.assertEqual(summary["clips"], 3)
        self.assertEqual(summary["zh_clips"], 2)
        self.assertEqual(summary["en_clips"], 1)
        # One wrong char across 8 zh reference chars.
        self.assertAlmostEqual(summary["micro_cer"], 1 / 8)
        self.assertAlmostEqual(summary["max_clip_cer"], 0.25)
        self.assertAlmostEqual(summary["wer"], 1 / 3)
        self.assertEqual(summary["cold_duration_s"], 12.5)
        self.assertAlmostEqual(summary["peak_rss_gib"], 2.0)

    def test_aggregate_of_no_clips_is_all_zero(self):
        summary = calibrate.aggregate([])
        self.assertEqual(summary["clips"], 0)
        self.assertEqual(summary["micro_cer"], 0.0)
        self.assertEqual(summary["peak_rss_gib"], 0.0)


class EvaluateTests(unittest.TestCase):
    def test_passes_when_every_metric_is_within_the_gate(self):
        summary = {"micro_cer": 0.02, "max_clip_cer": 0.04, "cold_duration_s": 80.0, "peak_rss_gib": 9.0}
        self.assertTrue(calibrate.evaluate(summary, calibrate.DEFAULT_THRESHOLDS)["pass"])

    def test_fails_when_any_single_metric_exceeds_its_threshold(self):
        summary = {"micro_cer": 0.02, "max_clip_cer": 0.06, "cold_duration_s": 80.0, "peak_rss_gib": 9.0}
        verdict = calibrate.evaluate(summary, calibrate.DEFAULT_THRESHOLDS)
        self.assertFalse(verdict["pass"])
        self.assertFalse(verdict["checks"]["max_clip_cer"])


class MainTests(unittest.TestCase):
    def _manifest(self, directory):
        path = Path(directory) / "manifest.json"
        path.write_text(
            json.dumps(
                [
                    {"audio": "z1", "reference": "你好世界", "lang": "zh"},
                    {"audio": "e1", "reference": "help me", "lang": "en"},
                ]
            ),
            encoding="utf-8",
        )
        return str(path)

    def test_prints_only_aggregate_numbers_never_private_text(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest = self._manifest(directory)
            runner = _runner_for({"z1": "你好世界", "e1": "help me"}, duration_s=10.0)
            buffer = io.StringIO()
            with redirect_stdout(buffer):
                code = calibrate.main(
                    ["--binary", "bin", "--model", "model", "--manifest", manifest], runner=runner
                )
            output = buffer.getvalue()
        self.assertEqual(code, 0)
        report = json.loads(output)
        self.assertEqual(report["micro_cer"], 0.0)
        self.assertTrue(report["gate"]["pass"])
        # Privacy: neither the reference/transcript text nor the audio paths appear in the output.
        self.assertNotIn("你好世界", output)
        self.assertNotIn("help me", output)
        self.assertNotIn("z1", output)

    def test_exit_code_is_nonzero_when_the_gate_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest = self._manifest(directory)
            # A badly wrong zh transcript blows past the CER gate.
            runner = _runner_for({"z1": "完全不同的字", "e1": "help me"})
            with redirect_stdout(io.StringIO()):
                code = calibrate.main(
                    ["--binary", "bin", "--model", "model", "--manifest", manifest], runner=runner
                )
        self.assertEqual(code, 1)


if __name__ == "__main__":
    unittest.main()
