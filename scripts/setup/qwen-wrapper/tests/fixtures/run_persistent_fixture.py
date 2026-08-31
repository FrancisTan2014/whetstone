"""Test-only fixture (#884): drives the real `run_persistent` line loop as an actual OS process, so the
process-level test proves the stdin/stdout framing at the real process boundary — mirroring
speechProcess.test.ts's approach of driving a real child process instead of a real speech model. The stub
transcriber factory increments a closure counter each time it is CALLED (i.e. each time a model would be
loaded); the final count is printed to stderr once stdin closes, so the test can assert the model loaded
exactly once and served every request from the same warm process.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from whetstone_qwen.cli import run_persistent  # noqa: E402


def _stub_transcriber_factory(load_count):
    def factory(_model):
        load_count[0] += 1

        def transcribe(audio_path):
            return {"text": audio_path, "language": None}

        return transcribe

    return factory


if __name__ == "__main__":
    counter = [0]
    exit_code = run_persistent("m", _stub_transcriber_factory(counter), sys.stdin, sys.stdout)
    print(f"loadCount={counter[0]}", file=sys.stderr)
    raise SystemExit(exit_code)
