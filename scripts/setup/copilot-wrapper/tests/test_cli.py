"""Unit tests for the whetstone-copilot shim — argument contract, JSON shape, and every failure path.

No GitHub Copilot CLI, no credential, and no network: the process boundary (`run`) and the PATH lookup
(`which`) are injected, so a fake subprocess returns canned output and the whole contract is exercised
deterministically. This matters beyond convenience — the `pnpm validate` gate has no agent CLI installed
and must never invoke one.

Run with `python -m unittest discover -s tests` from the wrapper root, the same way whisper-wrapper's
suite runs.
"""
import io
import json
import os
import subprocess
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

from whetstone_copilot.cli import (
    CONTRACT_VERSION,
    CONTRACT_VERSION_FLAG,
    COPILOT_BINARY_ENV,
    MAX_PROMPT_CHARS,
    PROVIDER,
    TURN_TIMEOUT_SECONDS,
    TurnFailed,
    build_contract,
    build_copilot_args,
    contract_version_report,
    main,
    parse_args,
    read_prompt,
    resolve_copilot,
    run_turn,
)

WRAPPER_ROOT = Path(__file__).resolve().parent.parent


class FakeCompleted:
    """The subset of `subprocess.CompletedProcess` the shim reads."""

    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


class FakeRun:
    """A fake process boundary: records each invocation and replays a scripted outcome."""

    def __init__(self, outcome=None, raises=None):
        self._outcome = outcome if outcome is not None else FakeCompleted(stdout="tidied text\n")
        self._raises = raises
        self.calls = []

    def __call__(self, args, timeout):
        self.calls.append((list(args), timeout))
        if self._raises is not None:
            raise self._raises
        return self._outcome


def _boom_run(_args, _timeout):
    raise AssertionError("no copilot process may be spawned on this path")


def _boom_which(_name):
    raise AssertionError("the PATH must not be searched on this path")


class ContractVersionProbeTests(unittest.TestCase):
    def test_report_is_compact_json_naming_the_provider_and_session_support(self):
        report = contract_version_report()
        self.assertEqual(
            report,
            '{"contractVersion":"1","provider":"github-copilot-cli","sessions":true}',
        )
        self.assertEqual(
            json.loads(report),
            {"contractVersion": CONTRACT_VERSION, "provider": PROVIDER, "sessions": True},
        )

    def test_probe_prints_the_descriptor_and_exits_without_spawning_copilot(self):
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            # The boom fakes raise if the probe ever resolves or spawns anything — proving it is cheap
            # and, per the protocol, starts no session.
            code = main([CONTRACT_VERSION_FLAG], run=_boom_run, which=_boom_which, stdin=io.StringIO(""))
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(buffer.getvalue()), json.loads(contract_version_report()))

    def test_probe_short_circuits_even_alongside_turn_arguments(self):
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            code = main(
                ["--model", "claude-sonnet-4.5", CONTRACT_VERSION_FLAG, "--output", "json"],
                run=_boom_run,
                which=_boom_which,
                stdin=io.StringIO("a prompt"),
            )
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(buffer.getvalue())["contractVersion"], CONTRACT_VERSION)


class ParseArgsTests(unittest.TestCase):
    def test_parses_the_turn_contract_arguments(self):
        args = parse_args(["--model", "gpt-5", "--output", "json", "--session", "abc-123"])
        self.assertEqual(args.model, "gpt-5")
        self.assertEqual(args.output, "json")
        self.assertEqual(args.session, "abc-123")

    def test_session_is_optional_because_the_seam_omits_it_for_one_shot_turns(self):
        args = parse_args(["--model", "gpt-5", "--output", "json"])
        self.assertIsNone(args.session)

    def test_a_turn_without_a_model_is_rejected(self):
        with self.assertRaises(SystemExit):
            with redirect_stderr(io.StringIO()):
                parse_args(["--output", "json"])


class BuildCopilotArgsTests(unittest.TestCase):
    def test_builds_the_verified_non_interactive_invocation(self):
        self.assertEqual(
            build_copilot_args("/usr/bin/copilot", "gpt-5", "tidy this", None),
            [
                "/usr/bin/copilot",
                "-p",
                "tidy this",
                "-s",
                "--no-color",
                "--log-level",
                "none",
                "--no-ask-user",
                "--disable-builtin-mcps",
                "--no-custom-instructions",
                "--model",
                "gpt-5",
            ],
        )

    def test_a_session_id_is_passed_through_as_copilots_own_session_flag(self):
        args = build_copilot_args("copilot", "gpt-5", "tidy this", "3f2b-uuid")
        self.assertEqual(args[-2:], ["--session-id", "3f2b-uuid"])

    def test_a_blank_session_id_passes_no_session_flag_at_all(self):
        # An empty `--session-id` would be rejected by Copilot; omitting it keeps a one-shot turn valid.
        self.assertNotIn("--session-id", build_copilot_args("copilot", "gpt-5", "hi", "   "))

    def test_the_agent_is_granted_no_tool_and_no_directory(self):
        # The seam's "no tools, by design" rule is enforced here, in the only place vendor flags exist:
        # built-in MCP servers are disabled and nothing is ever allowed in.
        args = build_copilot_args("copilot", "gpt-5", "hi", "session")
        self.assertIn("--disable-builtin-mcps", args)
        for granting_flag in ("--allow-tool", "--allow-all-tools", "--allow-all", "--add-dir"):
            self.assertNotIn(granting_flag, args)

    def test_the_prompt_is_one_argument_so_it_is_never_split_or_reinterpreted(self):
        prompt = "Tidy this.\n\nTranscript:\num I, I read \"a book\" & rested"
        args = build_copilot_args("copilot", "gpt-5", prompt, None)
        self.assertEqual(args[args.index("-p") + 1], prompt)


class ReadPromptTests(unittest.TestCase):
    def test_reads_the_whole_prompt_from_a_text_stream(self):
        self.assertEqual(read_prompt(io.StringIO("line one\nline two\n")), "line one\nline two")

    def test_decodes_a_binary_stream_as_utf8_so_a_chinese_transcript_is_not_mangled(self):
        # The server writes UTF-8 bytes to the child's stdin; Python's text stdin would otherwise decode
        # them with the host locale encoding and corrupt the learner's own words.
        class BinaryStream:
            def __init__(self, data):
                self.buffer = io.BytesIO(data)

            def read(self):  # pragma: no cover - the buffer path must be preferred
                raise AssertionError("the UTF-8 buffer must be preferred over locale-decoded text")

        transcript = "今天我读了一本书，嗯，很安静。"
        self.assertEqual(read_prompt(BinaryStream(transcript.encode("utf-8"))), transcript)

    def test_an_empty_prompt_fails_by_name(self):
        with self.assertRaises(TurnFailed) as failure:
            read_prompt(io.StringIO("   \n  "))
        self.assertIn("stdin", str(failure.exception))

    def test_an_oversized_prompt_fails_by_name_instead_of_being_truncated(self):
        # Copilot takes the prompt as a command-line argument, and a silently truncated prompt would be
        # a DIFFERENT prompt — the one thing a faithful tidy must never be given.
        with self.assertRaises(TurnFailed) as failure:
            read_prompt(io.StringIO("x" * (MAX_PROMPT_CHARS + 1)))
        self.assertIn(str(MAX_PROMPT_CHARS), str(failure.exception))

    def test_a_prompt_at_the_limit_is_accepted(self):
        self.assertEqual(len(read_prompt(io.StringIO("x" * MAX_PROMPT_CHARS))), MAX_PROMPT_CHARS)


class ResolveCopilotTests(unittest.TestCase):
    def test_uses_the_executable_found_on_path(self):
        self.assertEqual(resolve_copilot({}, lambda name: "/opt/bin/" + name), "/opt/bin/copilot")

    def test_an_explicit_override_wins_over_path(self):
        resolved = resolve_copilot({COPILOT_BINARY_ENV: r"C:\tools\copilot.exe"}, _boom_which)
        self.assertEqual(resolved, r"C:\tools\copilot.exe")

    def test_a_blank_override_falls_back_to_path(self):
        self.assertEqual(resolve_copilot({COPILOT_BINARY_ENV: "  "}, lambda _name: "/bin/copilot"), "/bin/copilot")

    def test_a_missing_executable_fails_by_name_with_the_remedy(self):
        with self.assertRaises(TurnFailed) as failure:
            resolve_copilot({}, lambda _name: None)
        message = str(failure.exception)
        self.assertIn("copilot", message)
        self.assertIn(COPILOT_BINARY_ENV, message)


class RunTurnTests(unittest.TestCase):
    def test_returns_the_answer_text_and_bounds_the_run(self):
        run = FakeRun(FakeCompleted(stdout="Today I read a book.\n"))
        self.assertEqual(run_turn(["copilot", "-p", "hi"], run), "Today I read a book.")
        self.assertEqual(run.calls[0][0], ["copilot", "-p", "hi"])
        self.assertEqual(run.calls[0][1], TURN_TIMEOUT_SECONDS)

    def test_a_non_zero_exit_fails_by_name_carrying_the_cli_stderr(self):
        run = FakeRun(FakeCompleted(returncode=1, stderr="not signed in\n", stdout="partial"))
        with self.assertRaises(TurnFailed) as failure:
            run_turn(["copilot"], run)
        self.assertIn("not signed in", str(failure.exception))

    def test_a_non_zero_exit_with_no_stderr_reports_stdout_instead(self):
        run = FakeRun(FakeCompleted(returncode=2, stderr="  ", stdout="rate limited"))
        with self.assertRaises(TurnFailed) as failure:
            run_turn(["copilot"], run)
        self.assertIn("rate limited", str(failure.exception))

    def test_a_silent_non_zero_exit_still_names_the_exit_code(self):
        with self.assertRaises(TurnFailed) as failure:
            run_turn(["copilot"], FakeRun(FakeCompleted(returncode=9)))
        self.assertIn("9", str(failure.exception))

    def test_an_empty_answer_fails_rather_than_returning_nothing_as_an_answer(self):
        with self.assertRaises(TurnFailed) as failure:
            run_turn(["copilot"], FakeRun(FakeCompleted(stdout="  \n")))
        self.assertIn("no answer", str(failure.exception))

    def test_a_timeout_fails_by_name(self):
        run = FakeRun(raises=subprocess.TimeoutExpired(cmd="copilot", timeout=TURN_TIMEOUT_SECONDS))
        with self.assertRaises(TurnFailed) as failure:
            run_turn(["copilot"], run)
        self.assertIn("did not answer", str(failure.exception))

    def test_an_unlaunchable_executable_fails_by_name(self):
        run = FakeRun(raises=FileNotFoundError(2, "No such file or directory"))
        with self.assertRaises(TurnFailed) as failure:
            run_turn(["copilot"], run)
        self.assertIn("could not be launched", str(failure.exception))


class BuildContractTests(unittest.TestCase):
    def test_text_is_the_whole_required_payload(self):
        self.assertEqual(build_contract("hello"), {"text": "hello"})


class MainTurnTests(unittest.TestCase):
    def _turn(self, run, argv=None, stdin_text="tidy me", env=None):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = main(
                argv if argv is not None else ["--model", "gpt-5", "--output", "json"],
                run=run,
                which=lambda name: "/usr/bin/" + name,
                stdin=io.StringIO(stdin_text),
                env=env if env is not None else {},
            )
        return code, out.getvalue(), err.getvalue()

    def test_writes_the_turn_contract_to_stdout_for_the_prompt_read_from_stdin(self):
        run = FakeRun(FakeCompleted(stdout="Today I read a book.\n"))
        code, out, err = self._turn(run, stdin_text="um today I, I read a book\n")

        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out), {"text": "Today I read a book."})
        self.assertEqual(err, "")
        command = run.calls[0][0]
        self.assertEqual(command[0], "/usr/bin/copilot")
        self.assertEqual(command[command.index("-p") + 1], "um today I, I read a book")
        self.assertEqual(command[command.index("--model") + 1], "gpt-5")
        self.assertNotIn("--session-id", command)

    def test_forwards_the_seams_session_id_to_copilot(self):
        run = FakeRun()
        code, _out, _err = self._turn(
            run, argv=["--model", "gpt-5", "--output", "json", "--session", "4c1e-uuid"]
        )
        self.assertEqual(code, 0)
        command = run.calls[0][0]
        self.assertEqual(command[command.index("--session-id") + 1], "4c1e-uuid")

    def test_a_non_ascii_answer_survives_any_stdout_encoding(self):
        run = FakeRun(FakeCompleted(stdout="今天我读了一本书。\n"))
        code, out, _err = self._turn(run)
        self.assertEqual(code, 0)
        # Escaped on the wire (so no host encoding can mangle it), exact after the seam parses it.
        self.assertNotIn("今", out)
        self.assertEqual(json.loads(out)["text"], "今天我读了一本书。")

    def test_a_failed_turn_names_the_reason_on_stderr_and_writes_nothing_to_stdout(self):
        run = FakeRun(FakeCompleted(returncode=1, stderr="authentication failed"))
        code, out, err = self._turn(run)

        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        self.assertIn("authentication failed", err)

    def test_a_missing_copilot_executable_fails_before_any_process_is_spawned(self):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = main(
                ["--model", "gpt-5", "--output", "json"],
                run=_boom_run,
                which=lambda _name: None,
                stdin=io.StringIO("tidy me"),
                env={},
            )
        self.assertEqual(code, 1)
        self.assertEqual(out.getvalue(), "")
        self.assertIn("was not found on PATH", err.getvalue())

    def test_an_empty_prompt_fails_before_any_process_is_spawned(self):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = main(
                ["--model", "gpt-5", "--output", "json"],
                run=_boom_run,
                which=_boom_which,
                stdin=io.StringIO("\n"),
                env={},
            )
        self.assertEqual(code, 1)
        self.assertEqual(out.getvalue(), "")
        self.assertIn("stdin", err.getvalue())

    def test_the_binary_override_reaches_the_spawned_command(self):
        run = FakeRun()
        code, _out, _err = self._turn(run, env={COPILOT_BINARY_ENV: r"C:\tools\copilot.exe"})
        self.assertEqual(code, 0)
        self.assertEqual(run.calls[0][0][0], r"C:\tools\copilot.exe")


class ProcessLevelLauncherTests(unittest.TestCase):
    """Prove the readiness contract at the real process boundary, not only against mocked arguments.

    The seam runs `<AGENT_BINARY> --contract-version` as an OS process and requires an exact contract
    match, so the probe is executed here as one. It needs no Copilot CLI and no credential.
    """

    def test_the_probe_answers_the_supported_contract_as_a_real_process(self):
        env = dict(os.environ)
        env["PYTHONPATH"] = os.pathsep.join([str(WRAPPER_ROOT), env.get("PYTHONPATH", "")]).rstrip(
            os.pathsep
        )
        result = subprocess.run(
            [sys.executable, "-m", "whetstone_copilot.cli", CONTRACT_VERSION_FLAG],
            capture_output=True,
            check=False,
            cwd=str(WRAPPER_ROOT),
            env=env,
            text=True,
            timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            {"contractVersion": CONTRACT_VERSION, "provider": PROVIDER, "sessions": True},
        )


if __name__ == "__main__":
    unittest.main()
