"""Unit tests for the whetstone-qwen launcher — arg contract, JSON shaping, and the cheap probe.

No real model, inference, or network: `main` is driven with a fake transcriber, so only the argument
contract and JSON mapping are exercised. Run with `python -m unittest` from the wrapper folder.
"""
import io
import json
import os
import subprocess
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from whetstone_qwen.cli import (
    CONTRACT_VERSION,
    CONTRACT_VERSION_FLAG,
    MODEL_REVISION,
    PROVIDER,
    build_contract,
    contract_version_report,
    main,
    parse_args,
)

WRAPPER_ROOT = Path(__file__).resolve().parent.parent


def _boom_factory(_model):
    raise AssertionError("the contract-version probe must not build a transcriber")


class ParseArgsTests(unittest.TestCase):
    def test_parses_the_neutral_contract_arguments(self):
        args = parse_args(["--model", "Qwen/Qwen3-ASR-1.7B", "--output", "json", "/tmp/a.audio"])
        self.assertEqual(args.model, "Qwen/Qwen3-ASR-1.7B")
        self.assertEqual(args.output, "json")
        self.assertEqual(args.audio, "/tmp/a.audio")

    def test_output_defaults_to_json(self):
        args = parse_args(["--model", "m", "/tmp/a.audio"])
        self.assertEqual(args.output, "json")


class BuildContractTests(unittest.TestCase):
    def test_transcript_first_with_empty_segments_and_detected_language(self):
        self.assertEqual(
            build_contract({"text": "  你好世界 ", "language": "zh"}),
            {"text": "你好世界", "language": "zh", "segments": []},
        )

    def test_language_is_null_when_absent_or_not_a_string(self):
        self.assertIsNone(build_contract({"text": "hi"})["language"])
        self.assertIsNone(build_contract({"text": "hi", "language": 42})["language"])

    def test_missing_text_becomes_an_empty_transcript_not_a_crash(self):
        self.assertEqual(build_contract({}), {"text": "", "language": None, "segments": []})

    def test_segments_are_always_empty_no_aligner(self):
        self.assertEqual(build_contract({"text": "a", "language": "en"})["segments"], [])


class MainTranscribeTests(unittest.TestCase):
    def test_writes_the_transcript_first_contract_from_the_transcriber(self):
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            code = main(
                ["--model", "m", "--output", "json", "/tmp/a.audio"],
                transcriber_factory=lambda _model: lambda audio: {"text": "你好", "language": "zh"},
            )
        self.assertEqual(code, 0)
        emitted = json.loads(buffer.getvalue())
        self.assertEqual(emitted, {"text": "你好", "language": "zh", "segments": []})

    def test_passes_the_audio_path_to_the_transcriber_verbatim(self):
        seen = {}

        def factory(model):
            self.assertEqual(model, "m")

            def transcribe(audio):
                seen["audio"] = audio
                return {"text": ""}

            return transcribe

        with redirect_stdout(io.StringIO()):
            main(["--model", "m", "--output", "json", "/tmp/capture.audio"], transcriber_factory=factory)
        self.assertEqual(seen["audio"], "/tmp/capture.audio")


class ContractVersionProbeTests(unittest.TestCase):
    def test_report_carries_version_provider_revision_and_requirements(self):
        report = json.loads(contract_version_report())
        self.assertEqual(report["contractVersion"], CONTRACT_VERSION)
        self.assertEqual(report["provider"], PROVIDER)
        self.assertEqual(report["revision"], MODEL_REVISION)
        self.assertEqual(report["requirements"], {"diskGiB": 12, "memoryGiB": 12})

    def test_probe_prints_the_descriptor_without_building_a_transcriber(self):
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            code = main([CONTRACT_VERSION_FLAG], transcriber_factory=_boom_factory)
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(buffer.getvalue())["contractVersion"], CONTRACT_VERSION)

    def test_probe_short_circuits_even_alongside_transcription_arguments(self):
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            code = main(
                ["--model", "m", CONTRACT_VERSION_FLAG, "/tmp/a.audio"],
                transcriber_factory=_boom_factory,
            )
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(buffer.getvalue())["provider"], PROVIDER)


class ProcessLevelProbeTests(unittest.TestCase):
    """Execute the launcher as a real subprocess so the readiness probe is proven at the process
    boundary, not only against in-process argument strings."""

    def test_probe_reports_the_supported_contract_version(self):
        env = dict(os.environ)
        env["PYTHONPATH"] = os.pathsep.join([str(WRAPPER_ROOT), env.get("PYTHONPATH", "")]).rstrip(
            os.pathsep
        )
        result = subprocess.run(
            [sys.executable, "-m", "whetstone_qwen.cli", CONTRACT_VERSION_FLAG],
            cwd=str(WRAPPER_ROOT),
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["contractVersion"], CONTRACT_VERSION)


if __name__ == "__main__":
    unittest.main()
