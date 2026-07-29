"""Unit tests for the pure calibration metrics — normalized CER/WER, edit distance, and micro-averaging."""
import unittest

from whetstone_qwen import metrics


class NormalizationTests(unittest.TestCase):
    def test_cer_normalization_drops_punctuation_and_spaces_and_folds_width(self):
        # Full-width and half-width digits fold together; spaces and punctuation are removed.
        self.assertEqual(metrics.normalize_chars("你好，世界！"), list("你好世界"))
        self.assertEqual(metrics.normalize_chars("ＡB １2"), list("AB12"))

    def test_wer_tokenization_lowercases_and_splits_on_punctuation(self):
        self.assertEqual(metrics.normalize_tokens("Help, yourself!  Now"), ["help", "yourself", "now"])


class EditDistanceTests(unittest.TestCase):
    def test_counts_substitutions_insertions_and_deletions(self):
        self.assertEqual(metrics.edit_distance(list("kitten"), list("sitting")), 3)
        self.assertEqual(metrics.edit_distance([], ["a", "b"]), 2)
        self.assertEqual(metrics.edit_distance(["a"], []), 1)
        self.assertEqual(metrics.edit_distance(list("abc"), list("abc")), 0)


class ClipRateTests(unittest.TestCase):
    def test_cer_ignores_punctuation_differences(self):
        self.assertEqual(metrics.clip_rate("你好世界", "你好，世界", "zh"), 0.0)

    def test_cer_counts_a_single_wrong_character(self):
        self.assertAlmostEqual(metrics.clip_rate("你好世界", "你好世ा", "zh"), 0.25)

    def test_wer_counts_a_single_wrong_word(self):
        self.assertAlmostEqual(metrics.clip_rate("help yourself now", "help yourself later", "en"), 1 / 3)

    def test_empty_reference_is_a_full_miss_when_output_is_produced(self):
        self.assertEqual(metrics.clip_rate("", "anything", "zh"), 1.0)

    def test_empty_reference_and_empty_output_is_perfect(self):
        self.assertEqual(metrics.clip_rate("", "", "zh"), 0.0)


class MicroRateTests(unittest.TestCase):
    def test_micro_averages_edits_over_total_reference_units(self):
        counts = [{"edits": 1, "reference_units": 10}, {"edits": 2, "reference_units": 10}]
        self.assertAlmostEqual(metrics.micro_rate(counts), 3 / 20)

    def test_micro_rate_of_no_clips_is_zero(self):
        self.assertEqual(metrics.micro_rate([]), 0.0)


if __name__ == "__main__":
    unittest.main()
