import os
import unittest

from whetstone_whisper.locate import find_launcher


class FindLauncherTests(unittest.TestCase):
    def test_returns_the_path_found_on_PATH(self):
        result = find_launcher(which=lambda _name: "/usr/local/bin/whetstone-whisper")
        self.assertEqual(result, "/usr/local/bin/whetstone-whisper")

    def test_falls_back_to_the_scripts_dir_when_not_on_PATH(self):
        exe = os.path.join("C:\\Scripts", "whetstone-whisper.exe")
        result = find_launcher(
            which=lambda _name: None,
            scripts_dir="C:\\Scripts",
            exists=lambda path: path == exe,
        )
        self.assertEqual(result, exe)

    def test_returns_empty_when_nowhere_to_be_found(self):
        result = find_launcher(
            which=lambda _name: None, scripts_dir="/nope", exists=lambda _path: False
        )
        self.assertEqual(result, "")


if __name__ == "__main__":
    unittest.main()
