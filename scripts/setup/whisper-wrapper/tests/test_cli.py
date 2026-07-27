"""Unit tests for the whetstone-whisper wrapper — arg parsing + JSON shape against a mock model.

No real inference or network: a fake model injected via `model_loader` returns canned segments plus a
detected-language info, so the mapping logic is exercised deterministically. Run with
`python -m unittest` from this folder.
"""
import io
import json
import os
import subprocess
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from whetstone_whisper.cli import (
    CONTRACT_VERSION,
    CONTRACT_VERSION_FLAG,
    contract_version_report,
    main,
    parse_args,
    transcribe_to_contract,
)

WRAPPER_ROOT = Path(__file__).resolve().parent.parent
OLD_LAUNCHER = Path(__file__).resolve().parent / "fixtures" / "old_launcher.py"


def _boom_loader(_model):
    raise AssertionError("the contract-version probe must not load a model")


class FakeWord:
    def __init__(self, word, start, end):
        self.word = word
        self.start = start
        self.end = end


class FakeSegment:
    def __init__(self, text, words):
        self.text = text
        self.words = words


class FakeInfo:
    def __init__(self, language):
        self.language = language


class FakeModel:
    def __init__(self, segments, detected_language="en"):
        self._segments = segments
        self._detected_language = detected_language
        self.calls = []

    def transcribe(self, audio, language, word_timestamps):
        self.calls.append((audio, language, word_timestamps))
        return iter(self._segments), FakeInfo(self._detected_language)


class ParseArgsTests(unittest.TestCase):
    def test_parses_the_contract_arguments(self):
        args = parse_args(
            ["--model", "small", "--language", "auto", "--output", "json",
             "--word-timestamps", "/tmp/a.wav"]
        )
        self.assertEqual(args.model, "small")
        self.assertEqual(args.language, "auto")
        self.assertTrue(args.word_timestamps)
        self.assertEqual(args.audio, "/tmp/a.wav")

    def test_language_defaults_to_auto(self):
        args = parse_args(["--model", "small", "/tmp/a.wav"])
        self.assertEqual(args.language, "auto")
        self.assertFalse(args.word_timestamps)


class TranscribeTests(unittest.TestCase):
    def test_maps_segments_to_the_contract_in_seconds(self):
        model = FakeModel(
            [
                FakeSegment(" Help ", [FakeWord("Help", 0.0, 0.4)]),
                FakeSegment("yourself", [FakeWord("yourself", 0.4, 0.9)]),
            ],
            detected_language="en",
        )
        result = transcribe_to_contract(model, "/tmp/a.wav", "auto")
        self.assertEqual(result["text"], "Help yourself")
        self.assertEqual(result["language"], "en")
        self.assertEqual(
            result["segments"],
            [
                {"words": [{"word": "Help", "start": 0.0, "end": 0.4}]},
                {"words": [{"word": "yourself", "start": 0.4, "end": 0.9}]},
            ],
        )

    def test_auto_maps_to_faster_whisper_detection_not_the_literal_string(self):
        model = FakeModel(
            [FakeSegment("你好", [FakeWord("你好", 0.0, 0.5)])], detected_language="zh"
        )
        result = transcribe_to_contract(model, "/tmp/a.wav", "auto")
        # `auto` must reach the model as `language=None` (detection), never the literal "auto".
        self.assertEqual(model.calls, [("/tmp/a.wav", None, True)])
        self.assertEqual(result["language"], "zh")

    def test_an_explicit_language_is_forced_not_detected(self):
        model = FakeModel(
            [FakeSegment("Hi", [FakeWord("Hi", 0.1, 0.3)])], detected_language="en"
        )
        transcribe_to_contract(model, "/tmp/a.wav", "zh")
        self.assertEqual(model.calls, [("/tmp/a.wav", "zh", True)])

    def test_tolerates_a_segment_with_no_words(self):
        model = FakeModel([FakeSegment("", None)])
        result = transcribe_to_contract(model, "/tmp/a.wav", "auto")
        self.assertEqual(result, {"text": "", "language": "en", "segments": [{"words": []}]})

    def test_reports_null_language_when_the_model_detects_none(self):
        model = FakeModel(
            [FakeSegment("Hi", [FakeWord("Hi", 0.1, 0.3)])], detected_language=None
        )
        result = transcribe_to_contract(model, "/tmp/a.wav", "auto")
        self.assertIsNone(result["language"])


class MainTests(unittest.TestCase):
    def test_writes_contract_json_to_stdout(self):
        model = FakeModel(
            [FakeSegment("Hi", [FakeWord("Hi", 0.1, 0.3)])], detected_language="en"
        )
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            code = main(
                ["--model", "small", "--language", "auto", "--output", "json",
                 "--word-timestamps", "/tmp/a.wav"],
                model_loader=lambda _model: model,
            )
        self.assertEqual(code, 0)
        emitted = json.loads(buffer.getvalue())
        self.assertEqual(emitted["text"], "Hi")
        self.assertEqual(emitted["language"], "en")
        self.assertEqual(emitted["segments"][0]["words"][0]["word"], "Hi")


class ContractVersionProbeTests(unittest.TestCase):
    def test_report_is_machine_readable_json_carrying_the_contract_version(self):
        self.assertEqual(json.loads(contract_version_report()), {"contractVersion": CONTRACT_VERSION})

    def test_probe_prints_the_version_and_exits_without_loading_a_model(self):
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            # `_boom_loader` raises if the probe ever loads a model — proving the probe is cheap.
            code = main([CONTRACT_VERSION_FLAG], model_loader=_boom_loader)
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(buffer.getvalue()), {"contractVersion": CONTRACT_VERSION})

    def test_probe_short_circuits_even_alongside_transcription_arguments(self):
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            code = main(
                ["--model", "small", CONTRACT_VERSION_FLAG, "--word-timestamps", "/tmp/a.wav"],
                model_loader=_boom_loader,
            )
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(buffer.getvalue()), {"contractVersion": CONTRACT_VERSION})


class ProcessLevelLauncherTests(unittest.TestCase):
    """Execute the current and a stale (pre-#647) launcher as real subprocesses.

    The readiness contract must be provable at the process boundary, not only against mocked argument
    strings: the current launcher answers `--contract-version` with the supported version and exits 0,
    while the stale launcher rejects the unknown flag (nonzero) and would forward the literal `auto`.
    """

    def _run(self, args, cwd, env=None):
        return subprocess.run(
            args, cwd=str(cwd), env=env, capture_output=True, text=True, check=False
        )

    def test_current_launcher_probe_reports_the_supported_contract_version(self):
        env = dict(os.environ)
        env["PYTHONPATH"] = os.pathsep.join(
            [str(WRAPPER_ROOT), env.get("PYTHONPATH", "")]
        ).rstrip(os.pathsep)
        result = self._run(
            [sys.executable, "-m", "whetstone_whisper.cli", CONTRACT_VERSION_FLAG],
            cwd=WRAPPER_ROOT,
            env=env,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {"contractVersion": CONTRACT_VERSION})

    def test_stale_launcher_probe_exits_nonzero_on_the_unknown_flag(self):
        result = self._run(
            [sys.executable, str(OLD_LAUNCHER), CONTRACT_VERSION_FLAG], cwd=WRAPPER_ROOT
        )
        self.assertNotEqual(result.returncode, 0)

    def test_stale_launcher_forwards_the_literal_auto_language(self):
        # Demonstrates the bug the probe guards against: the stale launcher never maps `auto` to
        # detection, so `auto` reaches transcription verbatim (faster-whisper then raises ValueError).
        result = self._run(
            [
                sys.executable,
                str(OLD_LAUNCHER),
                "--model",
                "small",
                "--language",
                "auto",
                "--word-timestamps",
                "/tmp/a.wav",
            ],
            cwd=WRAPPER_ROOT,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["language"], "auto")


if __name__ == "__main__":
    unittest.main()
