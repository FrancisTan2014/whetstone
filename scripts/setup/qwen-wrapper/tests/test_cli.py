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
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

from whetstone_qwen.cli import (
    CONTRACT_VERSION,
    CONTRACT_VERSION_FLAG,
    MODEL_REVISION,
    PERSISTENT_FLAG,
    PROVIDER,
    build_contract,
    contract_version_report,
    main,
    parse_args,
    parse_persistent_args,
    run_persistent,
    _transcribe_capture,
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


class TranscribeCaptureRoutingTests(unittest.TestCase):
    """The reviewer's acceptance path: the PyAV-decoded WAVEFORM (not the file path) is what reaches
    Qwen, and Qwen's ASRTranscription result maps into the transcript-first dict. Uses a fake engine and
    a fake decode so no real model or PyAV is needed — but it fails under the old code, which handed the
    raw path straight to `engine.transcribe`."""

    def test_routes_the_decoded_waveform_not_the_path_into_the_engine(self):
        # A sentinel standing in for the decoded (waveform, sample_rate) — content-agnostic on purpose.
        decoded_waveform = object()
        seen = {}

        def fake_decode(path):
            seen["decoded_path"] = path
            return (decoded_waveform, 16000)

        class FakeEngine:
            def transcribe(self, audio):
                seen["engine_audio"] = audio

                class _Result:
                    text = "你好世界"
                    language = "Chinese"

                return [_Result()]

        result = _transcribe_capture(FakeEngine(), fake_decode, "/tmp/capture.audio")

        # decode saw the capture path...
        self.assertEqual(seen["decoded_path"], "/tmp/capture.audio")
        # ...and the ENGINE received the decoded (waveform, sr) — never the raw path. This is the
        # regression: under `engine.transcribe(audio_path)` the engine would have been handed the string.
        self.assertEqual(seen["engine_audio"], [(decoded_waveform, 16000)])
        self.assertNotIn("/tmp/capture.audio", repr(seen["engine_audio"]))
        self.assertEqual(result, {"text": "你好世界", "language": "Chinese"})

    def test_maps_a_mixed_language_result(self):
        class _Result:
            text = "hello 世界"
            language = "Chinese,English"

        result = _transcribe_capture(
            _StubEngine([_Result()]), lambda _p: (object(), 16000), "/tmp/a.audio"
        )
        self.assertEqual(result, {"text": "hello 世界", "language": "Chinese,English"})

    def test_empty_language_from_silent_audio_becomes_none(self):
        class _Result:
            text = ""
            language = "   "

        result = _transcribe_capture(
            _StubEngine([_Result()]), lambda _p: (object(), 16000), "/tmp/a.audio"
        )
        self.assertEqual(result, {"text": "", "language": None})


class _StubEngine:
    def __init__(self, results):
        self._results = results

    def transcribe(self, audio):  # noqa: ARG002 - audio unused; routing asserted elsewhere
        return self._results


class ContractVersionProbeTests(unittest.TestCase):
    def test_report_carries_version_provider_revision_and_requirements(self):
        report = json.loads(contract_version_report())
        self.assertEqual(report["contractVersion"], CONTRACT_VERSION)
        self.assertEqual(report["provider"], PROVIDER)
        self.assertEqual(report["revision"], MODEL_REVISION)
        self.assertEqual(report["requirements"], {"diskGiB": 12, "memoryGiB": 12})

    def test_report_declares_persistent_mode_support(self):
        # #884: the Node-side resolver reads this flag to auto-use the warm-process protocol.
        self.assertIs(json.loads(contract_version_report())["persistent"], True)

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


class ParsePersistentArgsTests(unittest.TestCase):
    def test_parses_the_model_with_no_audio_positional(self):
        args = parse_persistent_args(["--model", "Qwen/Qwen3-ASR-1.7B"])
        self.assertEqual(args.model, "Qwen/Qwen3-ASR-1.7B")


class RunPersistentTests(unittest.TestCase):
    """The #884 persistent-mode line loop, driven in-process against fake stdin/stdout so no real model
    or subprocess is needed — the process boundary itself is covered separately below."""

    def test_loads_the_model_exactly_once_across_two_requests(self):
        loads = []

        def factory(model):
            loads.append(model)
            return lambda audio: {"text": f"heard {audio}", "language": "en"}

        stdin = io.StringIO("a.audio\nb.audio\n")
        stdout = io.StringIO()
        code = run_persistent("m", factory, stdin, stdout)

        self.assertEqual(code, 0)
        self.assertEqual(loads, ["m"])
        lines = [line for line in stdout.getvalue().splitlines() if line]
        self.assertEqual(
            [json.loads(line)["text"] for line in lines], ["heard a.audio", "heard b.audio"]
        )

    def test_each_response_line_is_the_same_transcript_first_contract_as_one_shot(self):
        stdin = io.StringIO("clip.audio\n")
        stdout = io.StringIO()
        run_persistent("m", lambda _model: lambda audio: {"text": "  hi  ", "language": "en"}, stdin, stdout)
        emitted = json.loads(stdout.getvalue().strip())
        self.assertEqual(emitted, {"text": "hi", "language": "en", "segments": []})

    def test_blank_lines_are_ignored_not_treated_as_an_audio_path(self):
        seen = []
        stdin = io.StringIO("\na.audio\n\n")
        stdout = io.StringIO()
        run_persistent("m", lambda _model: lambda audio: seen.append(audio) or {"text": "x"}, stdin, stdout)
        self.assertEqual(seen, ["a.audio"])

    def test_returns_0_cleanly_when_stdin_closes_with_no_requests(self):
        code = run_persistent("m", lambda _model: _boom_factory, io.StringIO(""), io.StringIO())
        self.assertEqual(code, 0)

    def test_a_request_failure_is_fatal_not_an_off_contract_response_line(self):
        def factory(_model):
            def transcribe(_audio):
                raise RuntimeError("decode failed")

            return transcribe

        stdout = io.StringIO()
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            code = run_persistent("m", factory, io.StringIO("bad.audio\n"), stdout)
        self.assertEqual(code, 1)
        self.assertEqual(stdout.getvalue(), "")
        self.assertIn("decode failed", stderr.getvalue())

    def test_main_routes_persistent_flag_before_parsing_one_shot_audio_args(self):
        # No audio positional is present alongside --persistent; parse_args (one-shot) would reject this.
        stdin = io.StringIO("a.audio\n")
        stdout = io.StringIO()
        with redirect_stdout(stdout), patch.object(sys, "stdin", stdin):
            code = main(
                [PERSISTENT_FLAG, "--model", "m"],
                transcriber_factory=lambda _model: lambda audio: {"text": audio},
            )
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(stdout.getvalue().strip())["text"], "a.audio")


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

    def test_persistent_mode_serves_two_requests_from_one_real_process_without_a_real_model(self):
        # Proves the #884 line protocol at the real process boundary (mirroring speechProcess.test.ts's
        # "drive a real child process" approach): a tiny fixture script drives the real `run_persistent`
        # loop with a stub transcriber, so real stdin/stdout framing is exercised without the un-fakeable
        # Qwen model. The fixture reports how many times its factory was called (i.e. how many times a
        # model would have loaded) to stderr, proving the SAME warm process served both requests instead
        # of being respawned per capture.
        fixture = Path(__file__).resolve().parent / "fixtures" / "run_persistent_fixture.py"
        result = subprocess.run(
            [sys.executable, str(fixture)],
            cwd=str(WRAPPER_ROOT),
            input="one.audio\ntwo.audio\n",
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        lines = [line for line in result.stdout.splitlines() if line]
        emitted = [json.loads(line) for line in lines]
        self.assertEqual([entry["text"] for entry in emitted], ["one.audio", "two.audio"])
        self.assertIn("loadCount=1", result.stderr)



if __name__ == "__main__":
    unittest.main()
