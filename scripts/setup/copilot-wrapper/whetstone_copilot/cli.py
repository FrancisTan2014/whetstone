"""The `whetstone-copilot` console script: the docs/AGENT.md agent contract over GitHub Copilot CLI.

Whetstone's agent seam (`src/apps/server/src/agent/`) is deliberately provider-neutral: its whole public
configuration is an executable path (`AGENT_BINARY`) plus a model identifier (`AGENT_MODEL`), and it
contains no table of per-CLI flags. Adapting one vendor CLI is the job of a small external shim. THIS is
that shim for GitHub Copilot CLI, and every Copilot-specific flag in the product lives in this file.

It answers the two invocations the seam makes:

1. **Readiness probe** — `whetstone-copilot --contract-version` prints the compact JSON descriptor and
   exits 0 WITHOUT starting a session, spawning `copilot`, or loading anything, so the probe is cheap
   and always answers well inside the seam's 10-second bound:

   ```json
   {"contractVersion":"1","provider":"github-copilot-cli","sessions":true}
   ```

2. **One turn** — `whetstone-copilot --model <id> --output json [--session <id>]` reads the prompt from
   **stdin** (the seam writes it and closes the stream), runs one non-interactive `copilot` invocation,
   and prints the protocol's turn JSON on stdout:

   ```json
   {"text": "A whetstone is a fine-grained stone used to sharpen a blade."}
   ```

The Copilot invocation is `copilot -p <prompt> -s --no-color --log-level none --no-ask-user
--disable-builtin-mcps --no-custom-instructions --model <id> [--session-id <id>]`:

- `-p/--prompt` runs one prompt non-interactively and exits; `-s/--silent` prints only the agent's
  answer (no stats), which is what makes the output machine-usable at all.
- `--no-color` and `--log-level none` keep decoration and progress logging out of stdout.
- `--no-ask-user` stops the agent from waiting on a human that is not there.
- `--disable-builtin-mcps` and the deliberate ABSENCE of any `--allow-tool` keep the agent **closed**:
  it is granted no tool, so a provider cannot reach Whetstone's data or the filesystem (`docs/AGENT.md`,
  "No tools, by design").
- `--no-custom-instructions` stops Copilot loading `AGENTS.md`/custom instruction files from whatever
  directory the server happens to run in. Those files are engineering instructions for a coding agent;
  silently prepending them to a diary-tidy prompt would change the answer based on the server's working
  directory, and would feed repository configuration into a product prompt.
- `--session-id <id>` carries the seam's opaque conversation id. Copilot's own flag documentation is
  "Resume an existing session or task by ID, **or set the UUID for a new session**", and that is
  confirmed empirically: two separate `copilot` processes sharing one `--session-id` continue the same
  conversation (a code word given in the first turn was recalled in the second). So the shim needs no
  session bookkeeping of its own and no separate `--resume` path — one idempotent flag both starts and
  continues a conversation, which is exactly what the protocol's `--session` means.

Failure is always **by name**, never a fabricated answer: a missing `copilot` executable, a non-zero
exit, a timeout, or an empty answer prints a message to stderr, writes NOTHING to stdout, and exits 1.
The seam maps that non-zero exit to its `agent_exit_failed` code carrying this message, so the caller
learns what broke instead of trusting invented text.

The real `subprocess` call and the PATH lookup are the un-fakeable process boundary (`_run_copilot`,
`shutil.which`); both are injected, so the argument contract, the JSON shaping, the cheap probe, and
every failure path are unit-tested with no Copilot CLI, no credential, and no network.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from typing import Any, Callable, Dict, Mapping, Optional, Sequence

# The executable argument/output contract version this shim speaks. It must match the seam's
# `agentContractVersion` in src/apps/server/src/agent/cliAgent.ts EXACTLY, or the probe is rejected and
# no prompt is ever handed over. Bumped only when the executable contract changes.
CONTRACT_VERSION = "1"

# The cheap readiness-probe flag (a module constant so the shim and its tests agree on the token).
CONTRACT_VERSION_FLAG = "--contract-version"

# The provider identifier reported to the probe. It reaches operational logs and the boot health report;
# it is never an environment value or a path.
PROVIDER = "github-copilot-cli"

# Copilot keys conversation state on the id passed to `--session-id` and resumes it across separate
# processes, so this shim honestly declares the protocol's session capability.
SESSIONS_SUPPORTED = True

# The GitHub Copilot CLI executable, resolved on PATH unless overridden. The override exists because the
# server spawns this launcher with its own environment: when `copilot` is installed somewhere that is not
# on the server process's PATH, naming the full path here beats making the whole seam unusable.
COPILOT_EXECUTABLE = "copilot"
COPILOT_BINARY_ENV = "WHETSTONE_COPILOT_BINARY"

# The shim's own wall-clock bound for one Copilot run, deliberately UNDER the seam's 120s turn bound
# (`turnTimeoutMs` in cliAgent.ts). The seam kills this launcher on its own expiry, and on Windows that
# kill does not reach a grandchild process, so the shim must be the one that stops `copilot` — otherwise
# an abandoned agent process would keep running after the turn was already given up on.
TURN_TIMEOUT_SECONDS = 110.0

# Copilot takes the prompt as a command-line argument, and a command line has a hard OS limit (32767
# characters on Windows). A prompt near that limit must fail by name here rather than be silently
# truncated into a different prompt, or blow up inside the OS with an unreadable error.
MAX_PROMPT_CHARS = 20_000


class TurnFailed(Exception):
    """One turn could not be completed. Reported by name on stderr; stdout stays empty."""


def contract_version_report() -> str:
    """The readiness-probe payload: compact JSON on one line, no session and no `copilot` process."""
    return json.dumps(
        {
            "contractVersion": CONTRACT_VERSION,
            "provider": PROVIDER,
            "sessions": SESSIONS_SUPPORTED,
        },
        separators=(",", ":"),
    )


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    """Parse the provider-neutral turn contract: `--model <id> --output json [--session <id>]`.

    `--session` is present only when the probe reported `sessions: true` (it always does here). The
    prompt is never an argument — it arrives on stdin.
    """
    parser = argparse.ArgumentParser(prog="whetstone-copilot")
    parser.add_argument("--model", required=True)
    # Accepted for contract compatibility; the output is always the JSON turn contract below.
    parser.add_argument("--output", default="json")
    parser.add_argument("--session", default=None)
    return parser.parse_args(list(argv))


def read_prompt(stream: Any) -> str:
    """Read the whole prompt the seam wrote to stdin and closed.

    Decoding is pinned to UTF-8 via the stream's binary buffer when it has one: a diary transcript is
    routinely Chinese, and Python's text stdin would otherwise decode it with the process's locale
    encoding (cp936/cp1252 on Windows) and mangle the learner's own words before Copilot ever sees them.
    A stream with no `buffer` (an in-memory test stream) is already text and is read directly.
    """
    buffer = getattr(stream, "buffer", None)
    raw = stream.read() if buffer is None else buffer.read().decode("utf-8", errors="replace")
    prompt = raw.strip()
    if not prompt:
        raise TurnFailed("no prompt arrived on stdin; the agent protocol sends the prompt there.")
    if len(prompt) > MAX_PROMPT_CHARS:
        raise TurnFailed(
            "the prompt is {actual} characters, over the {limit}-character command-line limit for "
            "GitHub Copilot CLI.".format(actual=len(prompt), limit=MAX_PROMPT_CHARS)
        )
    return prompt


def resolve_copilot(env: Mapping[str, str], which: Callable[[str], Optional[str]]) -> str:
    """Locate the Copilot CLI: the `WHETSTONE_COPILOT_BINARY` override, else `copilot` on PATH.

    A missing executable fails by name here, before any prompt is handed anywhere, so the operator reads
    what is actually wrong instead of a generic spawn error.
    """
    override = (env.get(COPILOT_BINARY_ENV) or "").strip()
    if override:
        return override

    found = which(COPILOT_EXECUTABLE)
    if found is None:
        raise TurnFailed(
            "the GitHub Copilot CLI executable `{name}` was not found on PATH. Install it and sign in "
            "(`{name} /login`), or set {env} to its full path.".format(
                env=COPILOT_BINARY_ENV, name=COPILOT_EXECUTABLE
            )
        )
    return found


def build_copilot_args(
    binary: str, model: str, prompt: str, session_id: Optional[str]
) -> list:
    """Build the non-interactive Copilot command line. See the module docstring for each flag's reason.

    No `--allow-tool` and no `--add-dir` appear here, ever: the agent is granted nothing. A blank or
    absent session id passes no `--session-id` at all, rather than an empty one Copilot would reject.
    """
    args = [
        binary,
        "-p",
        prompt,
        "-s",
        "--no-color",
        "--log-level",
        "none",
        "--no-ask-user",
        "--disable-builtin-mcps",
        "--no-custom-instructions",
        "--model",
        model,
    ]
    session = (session_id or "").strip()
    if session:
        args.extend(["--session-id", session])
    return args


def build_contract(text: str) -> Dict[str, Any]:
    """Shape one answer into the protocol's turn contract. `text` is the whole required payload."""
    return {"text": text}


def run_turn(args: Sequence[str], run: Callable[[Sequence[str], float], Any]) -> str:
    """Run one Copilot invocation and return its answer text, or fail by name.

    `-s/--silent` makes stdout the agent's answer and nothing else, so the answer needs no parsing —
    only the trailing newline is trimmed. An empty answer is a failure, not an empty diary entry: the
    seam must never receive text the provider did not actually produce.
    """
    try:
        completed = run(args, TURN_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired as exc:
        raise TurnFailed(
            "the GitHub Copilot CLI did not answer within {limit:.0f} seconds and was stopped.".format(
                limit=TURN_TIMEOUT_SECONDS
            )
        ) from exc
    except OSError as exc:
        raise TurnFailed(
            "the GitHub Copilot CLI could not be launched: {reason}".format(reason=exc)
        ) from exc

    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise TurnFailed(
            "the GitHub Copilot CLI exited with code {code}: {detail}".format(
                code=completed.returncode,
                detail=detail or "it printed no diagnostic.",
            )
        )

    text = completed.stdout.strip()
    if not text:
        raise TurnFailed("the GitHub Copilot CLI exited successfully but printed no answer.")
    return text


def _run_copilot(
    args: Sequence[str], timeout: float
) -> "subprocess.CompletedProcess":  # pragma: no cover - real process boundary
    """The un-fakeable process boundary: run Copilot, capture its output, and bound its wall clock.

    stdin is /dev/null so Copilot can never block waiting on input (the seam already closed ours), and
    output is decoded as UTF-8 regardless of the host's locale encoding so a Chinese answer survives.
    """
    return subprocess.run(
        list(args),
        capture_output=True,
        check=False,
        encoding="utf-8",
        errors="replace",
        stdin=subprocess.DEVNULL,
        timeout=timeout,
    )


def main(
    argv: Optional[Sequence[str]] = None,
    run: Callable[[Sequence[str], float], Any] = _run_copilot,
    which: Callable[[str], Optional[str]] = shutil.which,
    stdin: Any = None,
    env: Optional[Mapping[str, str]] = None,
) -> int:
    raw = list(sys.argv[1:] if argv is None else argv)
    # The cheap readiness probe: emit the descriptor and exit BEFORE resolving or spawning anything, so
    # a probe costs one Python start-up. Checked ahead of `parse_args` because the probe deliberately
    # takes none of the turn arguments.
    if CONTRACT_VERSION_FLAG in raw:
        sys.stdout.write(contract_version_report())
        return 0

    args = parse_args(raw)
    try:
        prompt = read_prompt(sys.stdin if stdin is None else stdin)
        binary = resolve_copilot(os.environ if env is None else env, which)
        text = run_turn(build_copilot_args(binary, args.model, prompt, args.session), run)
    except TurnFailed as failure:
        # Named failure: stderr carries the reason (the seam surfaces it as the turn's message) and
        # stdout stays empty, so nothing can be mistaken for an answer.
        sys.stderr.write("whetstone-copilot turn failed: {reason}\n".format(reason=failure))
        return 1

    # `ensure_ascii` (the default) escapes non-ASCII, so the contract survives any stdout encoding the
    # host happens to use — the seam decodes it back to the exact answer.
    sys.stdout.write(json.dumps(build_contract(text)))
    return 0


if __name__ == "__main__":  # pragma: no cover - process entry
    raise SystemExit(main())
