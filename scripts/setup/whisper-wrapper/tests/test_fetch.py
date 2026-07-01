import unittest

from whetstone_whisper.fetch import main


class FetchMainTests(unittest.TestCase):
    def test_loads_the_requested_model(self):
        loaded = []
        code = main(["small"], model_loader=lambda model: loaded.append(model))
        self.assertEqual(code, 0)
        self.assertEqual(loaded, ["small"])

    def test_reports_usage_when_no_model_given(self):
        code = main([], model_loader=lambda _model: None)
        self.assertEqual(code, 2)


if __name__ == "__main__":
    unittest.main()
