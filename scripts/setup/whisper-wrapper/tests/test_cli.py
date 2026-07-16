"""Unit tests for the whetstone-whisper wrapper — arg parsing + JSON shape against a mock model.

No real inference or network: a fake model injected via `model_loader` returns canned segments plus a
detected-language info, so the mapping logic is exercised deterministically. Run with
`python -m unittest` from this folder.
"""
import io
import json
import unittest
from contextlib import redirect_stdout

from whetstone_whisper.cli import main, parse_args, transcribe_to_contract


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


if __name__ == "__main__":
    unittest.main()
