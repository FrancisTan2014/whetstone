"""Unit tests for the whetstone-whisper wrapper — arg parsing + JSON shape against a mock model.

No real inference or network: a fake model injected via `model_loader` returns canned segments, so
the mapping logic is exercised deterministically. Run with: `python -m unittest` from this folder.
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


class FakeModel:
    def __init__(self, segments):
        self._segments = segments
        self.calls = []

    def transcribe(self, audio, language, word_timestamps):
        self.calls.append((audio, language, word_timestamps))
        return iter(self._segments), {"language": language}


class ParseArgsTests(unittest.TestCase):
    def test_parses_the_contract_arguments(self):
        args = parse_args(
            ["--model", "small", "--language", "zh", "--output", "json",
             "--word-timestamps", "/tmp/a.wav"]
        )
        self.assertEqual(args.model, "small")
        self.assertEqual(args.language, "zh")
        self.assertTrue(args.word_timestamps)
        self.assertEqual(args.audio, "/tmp/a.wav")

    def test_language_defaults_to_en(self):
        args = parse_args(["--model", "small", "/tmp/a.wav"])
        self.assertEqual(args.language, "en")
        self.assertFalse(args.word_timestamps)


class TranscribeTests(unittest.TestCase):
    def test_maps_segments_to_the_contract_in_seconds(self):
        model = FakeModel(
            [
                FakeSegment(" Help ", [FakeWord("Help", 0.0, 0.4)]),
                FakeSegment("yourself", [FakeWord("yourself", 0.4, 0.9)]),
            ]
        )
        result = transcribe_to_contract(model, "/tmp/a.wav", "en")
        self.assertEqual(result["text"], "Help yourself")
        self.assertEqual(
            result["segments"],
            [
                {"words": [{"word": "Help", "start": 0.0, "end": 0.4}]},
                {"words": [{"word": "yourself", "start": 0.4, "end": 0.9}]},
            ],
        )
        self.assertEqual(model.calls, [("/tmp/a.wav", "en", True)])

    def test_tolerates_a_segment_with_no_words(self):
        model = FakeModel([FakeSegment("", None)])
        result = transcribe_to_contract(model, "/tmp/a.wav", "en")
        self.assertEqual(result, {"text": "", "segments": [{"words": []}]})


class MainTests(unittest.TestCase):
    def test_writes_contract_json_to_stdout(self):
        model = FakeModel([FakeSegment("Hi", [FakeWord("Hi", 0.1, 0.3)])])
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            code = main(
                ["--model", "small", "--language", "en", "--output", "json",
                 "--word-timestamps", "/tmp/a.wav"],
                model_loader=lambda _model: model,
            )
        self.assertEqual(code, 0)
        emitted = json.loads(buffer.getvalue())
        self.assertEqual(emitted["text"], "Hi")
        self.assertEqual(emitted["segments"][0]["words"][0]["word"], "Hi")


if __name__ == "__main__":
    unittest.main()
