import io
import os
import sysconfig
import unittest
from unittest import mock

from whetstone_whisper import locate
from whetstone_whisper.locate import find_launcher


class FindLauncherTests(unittest.TestCase):
    def test_returns_the_path_found_on_PATH(self):
        result = find_launcher(which=lambda _name: "/usr/local/bin/whetstone-whisper")
        self.assertEqual(result, "/usr/local/bin/whetstone-whisper")

    def test_falls_back_to_a_scripts_dir_when_not_on_PATH(self):
        exe = os.path.join("C:\\Scripts", "whetstone-whisper.exe")
        result = find_launcher(
            which=lambda _name: None,
            scripts_dirs=["C:\\Scripts"],
            exists=lambda path: path == exe,
        )
        self.assertEqual(result, exe)

    def test_probes_the_user_site_scripts_dir_when_the_default_lacks_it(self):
        # Microsoft Store Python installs the console script into the per-user Scripts dir only, and
        # never adds it to PATH (#424); the launcher must still be found there.
        user_dir = (
            "C:\\Users\\me\\AppData\\Local\\Packages\\"
            "PythonSoftwareFoundation.Python.3.13_qbz5n2kfra8p0\\LocalCache\\"
            "local-packages\\Python313\\Scripts"
        )
        exe = os.path.join(user_dir, "whetstone-whisper.exe")
        result = find_launcher(
            which=lambda _name: None,
            scripts_dirs=["C:\\Python\\Scripts", user_dir],
            exists=lambda path: path == exe,
        )
        self.assertEqual(result, exe)

    def test_returns_empty_when_nowhere_to_be_found(self):
        result = find_launcher(
            which=lambda _name: None, scripts_dirs=["/nope"], exists=lambda _path: False
        )
        self.assertEqual(result, "")


class ScriptDirsTests(unittest.TestCase):
    def test_includes_the_default_and_the_user_scheme_scripts_dirs(self):
        dirs = locate.script_dirs()
        self.assertIn(sysconfig.get_path("scripts"), dirs)
        self.assertIn(locate.user_scripts_dir(), dirs)

    def test_de_duplicates_when_default_and_user_dirs_coincide(self):
        with mock.patch.object(locate.sysconfig, "get_path", return_value="/same/Scripts"):
            self.assertEqual(locate.script_dirs(), ["/same/Scripts"])


class MainTests(unittest.TestCase):
    def test_writes_only_the_launcher_to_stdout_when_found(self):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(locate, "find_launcher", return_value="/bin/whetstone-whisper"), \
                mock.patch.object(locate.sys, "stdout", out), \
                mock.patch.object(locate.sys, "stderr", err):
            self.assertEqual(locate.main(), 0)
        self.assertEqual(out.getvalue(), "/bin/whetstone-whisper")
        self.assertEqual(err.getvalue(), "")

    def test_writes_the_user_scripts_dir_to_stderr_when_not_found(self):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(locate, "find_launcher", return_value=""), \
                mock.patch.object(locate, "user_scripts_dir", return_value="C:\\User\\Scripts"), \
                mock.patch.object(locate.sys, "stdout", out), \
                mock.patch.object(locate.sys, "stderr", err):
            self.assertEqual(locate.main(), 0)
        self.assertEqual(out.getvalue(), "")
        self.assertEqual(err.getvalue(), "C:\\User\\Scripts")


if __name__ == "__main__":
    unittest.main()
