import { execFile } from "node:child_process";

// The OS-process boundary shared by every local speech adapter: run a configured binary with arguments
// and return its stdout. Injected into an adapter so the transcript-mapping logic stays testable against
// a fake, while this thin runner is itself exercised end-to-end against a real child process. It is
// provider-neutral - the legacy Whisper adapter and the provider-neutral LocalSpeechInput both drive
// their configured executable through it.
export type CommandRunner = (binaryPath: string, args: ReadonlyArray<string>) => Promise<string>;

// Word-timestamp JSON for a long utterance can be sizeable; allow a generous stdout buffer.
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

export const runCommand: CommandRunner = (binaryPath, args) =>
  new Promise((resolve, reject) => {
    execFile(binaryPath, [...args], { maxBuffer: MAX_OUTPUT_BYTES }, (error, stdout) => {
      if (error !== null) {
        reject(error);
        return;
      }

      resolve(stdout);
    });
  });
