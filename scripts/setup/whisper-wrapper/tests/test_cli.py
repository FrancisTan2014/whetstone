"""Unit tests for the whetstone-whisper wrapper — arg parsing + JSON shape against a mock model.

No real inference or network: a fake model injected via `model_loader` returns canned per-utterance
segments plus a detected-language info, and a fake `segmenter` stands in for the Silero VAD, so the
per-utterance mapping logic (#909) is exercised deterministically. Run with `python -m unittest` from
this folder.
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
    """A mock WhisperModel: returns queued ``(segments, detected_language)`` responses in call order.

    ``transcribe`` is now called once per VAD utterance, so a test queues one response per utterance and
    inspects ``calls`` to assert exactly which audio/clip and language each call received.
    """

    def __init__(self, *responses):
        self._responses = list(responses)
        self.calls = []

    def transcribe(self, audio, language, word_timestamps):
        self.calls.append((audio, language, word_timestamps))
        segments, detected = self._responses[len(self.calls) - 1]
        return iter(segments), FakeInfo(detected)


def segmenter_of(*utterances):
    """A fake VAD seam: returns the given ``(offset_seconds, clip)`` utterances, ignoring the real audio.

    ``clip`` is an opaque marker (the mock model never inspects it), so a test can assert which clip each
    per-utterance ``transcribe`` call received and that word timings are shifted by ``offset_seconds``.
    """
    return lambda _audio: list(utterances)


def exploding_segmenter(_audio):
    """A VAD seam that must never run — proves the forced-language path skips segmentation entirely."""
    raise AssertionError("segmenter must not run for a forced language")


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
    def test_auto_detects_and_decodes_each_utterance_keeping_both_languages(self):
        # AC: a mixed zh->en capture returns BOTH utterances (no dropped span); each segment reports the
        # language detected for its own utterance, with word timings in absolute file time.
        model = FakeModel(
            ([FakeSegment("你好", [FakeWord("你好", 0.0, 0.8)])], "zh"),
            ([FakeSegment(" Help", [FakeWord("Help", 0.2, 0.6)])], "en"),
        )
        result = transcribe_to_contract(
            model,
            "cap.audio",
            "auto",
            segmenter=segmenter_of((0.0, "clip-zh"), (8.8, "clip-en")),
        )
        # Each utterance clip is detected independently (language=None reaches the model), in time order.
        self.assertEqual(model.calls, [("clip-zh", None, True), ("clip-en", None, True)])
        self.assertEqual(
            result["segments"],
            [
                {"language": "zh", "words": [{"word": "你好", "start": 0.0, "end": 0.8}]},
                {"language": "en", "words": [{"word": "Help", "start": 9.0, "end": 9.4}]},
            ],
        )
        self.assertEqual(result["text"], "你好 Help")
        self.assertEqual(result["language"], "zh")  # the recording's opening language

    def test_word_timestamps_are_absolute_and_monotonic_across_boundaries(self):
        # AC: timings stay in absolute file time and non-decreasing across utterance boundaries.
        model = FakeModel(
            ([FakeSegment("a", [FakeWord("a", 0.0, 0.5), FakeWord("a2", 0.5, 1.0)])], "en"),
            ([FakeSegment("b", [FakeWord("b", 0.0, 0.4)])], "en"),
        )
        result = transcribe_to_contract(
            model, "cap.audio", "auto", segmenter=segmenter_of((0.0, "u1"), (5.0, "u2"))
        )
        starts = [w["start"] for s in result["segments"] for w in s["words"]]
        self.assertEqual(starts, [0.0, 0.5, 5.0])
        self.assertEqual(starts, sorted(starts))

    def test_ill_formed_backwards_utterances_are_clamped_monotonic(self):
        # Defensive: even if a later clip's absolute time would fall BEFORE an earlier word (VAD never
        # does this), word starts never move backwards, and end is pulled up so end >= start.
        model = FakeModel(
            ([FakeSegment("a", [FakeWord("a", 0.0, 0.5)])], "en"),
            ([FakeSegment("b", [FakeWord("b", 0.0, 0.3)])], "en"),
        )
        result = transcribe_to_contract(
            model, "cap.audio", "auto", segmenter=segmenter_of((5.0, "u1"), (1.0, "u2"))
        )
        first = result["segments"][0]["words"][0]
        second = result["segments"][1]["words"][0]
        self.assertEqual((first["start"], first["end"]), (5.0, 5.5))
        self.assertEqual((second["start"], second["end"]), (5.0, 5.0))

    def test_single_utterance_capture_is_unchanged_in_content(self):
        # AC: a single-language capture keeps its content; one utterance -> one detected language.
        model = FakeModel(
            (
                [
                    FakeSegment(" Help ", [FakeWord("Help", 0.0, 0.4)]),
                    FakeSegment("yourself", [FakeWord("yourself", 0.4, 0.9)]),
                ],
                "en",
            )
        )
        result = transcribe_to_contract(
            model, "cap.audio", "auto", segmenter=segmenter_of((0.0, "clip"))
        )
        self.assertEqual(result["text"], "Help yourself")
        self.assertEqual(result["language"], "en")
        self.assertEqual(
            result["segments"],
            [
                {"language": "en", "words": [{"word": "Help", "start": 0.0, "end": 0.4}]},
                {"language": "en", "words": [{"word": "yourself", "start": 0.4, "end": 0.9}]},
            ],
        )

    def test_auto_falls_back_to_a_whole_file_decode_when_vad_finds_no_speech(self):
        # A recording VAD finds no utterance in is still decoded once (auto), so nothing is dropped.
        model = FakeModel(([FakeSegment("Hi", [FakeWord("Hi", 0.1, 0.3)])], "en"))
        result = transcribe_to_contract(
            model, "cap.audio", "auto", segmenter=segmenter_of()
        )
        self.assertEqual(model.calls, [("cap.audio", None, True)])  # whole file, auto-detect
        self.assertEqual(
            result["segments"],
            [{"language": "en", "words": [{"word": "Hi", "start": 0.1, "end": 0.3}]}],
        )
        self.assertEqual(result["language"], "en")

    def test_a_forced_language_keeps_the_single_whole_file_call_and_skips_vad(self):
        model = FakeModel(([FakeSegment("Hi", [FakeWord("Hi", 0.1, 0.3)])], "zh"))
        result = transcribe_to_contract(
            model, "cap.audio", "zh", segmenter=exploding_segmenter
        )
        # A forced language reaches the model verbatim on the whole file; VAD is never consulted.
        self.assertEqual(model.calls, [("cap.audio", "zh", True)])
        self.assertEqual(result["language"], "zh")
        self.assertEqual(
            result["segments"],
            [{"language": "zh", "words": [{"word": "Hi", "start": 0.1, "end": 0.3}]}],
        )

    def test_tolerates_a_segment_with_no_words(self):
        model = FakeModel(([FakeSegment("", None)], "en"))
        result = transcribe_to_contract(
            model, "cap.audio", "auto", segmenter=segmenter_of((0.0, "clip"))
        )
        self.assertEqual(
            result, {"text": "", "language": "en", "segments": [{"language": "en", "words": []}]}
        )

    def test_top_level_language_is_the_first_non_null_detection(self):
        # If the opening utterance reports no language, the first utterance that did wins the top-level.
        model = FakeModel(
            ([FakeSegment("...", [FakeWord("x", 0.0, 0.1)])], None),
            ([FakeSegment(" hi", [FakeWord("hi", 0.0, 0.2)])], "en"),
        )
        result = transcribe_to_contract(
            model, "cap.audio", "auto", segmenter=segmenter_of((0.0, "u1"), (3.0, "u2"))
        )
        self.assertEqual([s["language"] for s in result["segments"]], [None, "en"])
        self.assertEqual(result["language"], "en")

    def test_top_level_language_is_null_when_no_utterance_detected_one(self):
        model = FakeModel(([FakeSegment("x", [FakeWord("x", 0.0, 0.1)])], None))
        result = transcribe_to_contract(
            model, "cap.audio", "auto", segmenter=segmenter_of((0.0, "clip"))
        )
        self.assertIsNone(result["language"])
        self.assertEqual(
            result["segments"],
            [{"language": None, "words": [{"word": "x", "start": 0.0, "end": 0.1}]}],
        )


class MainTests(unittest.TestCase):
    def test_writes_contract_json_to_stdout(self):
        model = FakeModel(([FakeSegment("Hi", [FakeWord("Hi", 0.1, 0.3)])], "en"))
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            code = main(
                ["--model", "small", "--language", "auto", "--output", "json",
                 "--word-timestamps", "/tmp/a.wav"],
                model_loader=lambda _model: model,
                segmenter=segmenter_of((0.0, "clip")),
            )
        self.assertEqual(code, 0)
        emitted = json.loads(buffer.getvalue())
        self.assertEqual(emitted["text"], "Hi")
        self.assertEqual(emitted["language"], "en")
        self.assertEqual(emitted["segments"][0]["language"], "en")
        self.assertEqual(emitted["segments"][0]["words"][0]["word"], "Hi")

    def test_passes_the_audio_path_into_the_segmenter(self):
        # `main` must feed the real audio path to the VAD seam (not a hardcoded/placeholder), and the
        # clip the seam returns is what actually reaches the model.
        model = FakeModel(([FakeSegment("Hi", [FakeWord("Hi", 0.0, 0.2)])], "en"))
        seen = {}

        def recording_segmenter(audio):
            seen["audio"] = audio
            return [(0.0, "clip")]

        buffer = io.StringIO()
        with redirect_stdout(buffer):
            code = main(
                ["--model", "small", "--language", "auto", "--word-timestamps",
                 "/tmp/cap.audio"],
                model_loader=lambda _model: model,
                segmenter=recording_segmenter,
            )
        self.assertEqual(code, 0)
        self.assertEqual(seen["audio"], "/tmp/cap.audio")
        self.assertEqual(model.calls, [("clip", None, True)])

    def test_multi_utterance_mapping_end_to_end_through_the_model_loader(self):
        # AC: the multi-utterance mapping is covered through `model_loader` with a mock model (no real
        # inference, no network): a mixed zh->en capture is emitted with both utterances, each segment's
        # own language, and absolute word times across the boundary.
        model = FakeModel(
            ([FakeSegment("你好", [FakeWord("你好", 0.0, 0.8)])], "zh"),
            ([FakeSegment(" Help", [FakeWord("Help", 0.2, 0.6)])], "en"),
        )
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            code = main(
                ["--model", "medium", "--language", "auto", "--output", "json",
                 "--word-timestamps", "/tmp/cap.audio"],
                model_loader=lambda _model: model,
                segmenter=segmenter_of((0.0, "clip-zh"), (8.8, "clip-en")),
            )
        self.assertEqual(code, 0)
        emitted = json.loads(buffer.getvalue())
        self.assertEqual(emitted["text"], "你好 Help")
        self.assertEqual(emitted["language"], "zh")
        self.assertEqual(
            emitted["segments"],
            [
                {"language": "zh", "words": [{"word": "你好", "start": 0.0, "end": 0.8}]},
                {"language": "en", "words": [{"word": "Help", "start": 9.0, "end": 9.4}]},
            ],
        )


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
