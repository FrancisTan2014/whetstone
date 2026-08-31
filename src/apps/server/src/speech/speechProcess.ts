import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";

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

// #884: the persistent-mode process boundary. Unlike `CommandRunner` (one spawn per transcription,
// closed stdout captured once), a persistent process is kept OPEN across many captures: each capture
// writes one audio-path line to its stdin and reads back one JSON transcript line from its stdout,
// instead of paying a fresh spawn + model reload per capture. This is the small, injectable seam the
// lifecycle manager (`persistentSpeechManager.ts`) drives against a fake in tests and a real child
// process here and in its own process-level test.
export type PersistentProcessLineListener = (line: string) => void;
export type PersistentProcessExitListener = () => void;

export type PersistentProcessHandle = Readonly<{
  // Write one request line (an audio path) to the process's stdin. Fire-and-forget: the response
  // arrives later through the launcher's line listener - never returned from this call.
  writeLine: (line: string) => void;
  // Terminate the process outright. This is the reliable way to reclaim its resident memory (an
  // in-process "unload" cannot hand memory back to the OS the way killing the process can).
  kill: () => void;
}>;

export type PersistentProcessLauncher = (
  binaryPath: string,
  args: ReadonlyArray<string>,
  onLine: PersistentProcessLineListener,
  onExit: PersistentProcessExitListener
) => PersistentProcessHandle;

// The real persistent-process launcher: spawns the configured binary once, wires a line reader over its
// stdout (one JSON transcript per line, #884), and normalizes every way the process can stop - a natural
// exit, a signal, or a spawn failure (e.g. ENOENT) - to the single `onExit` callback, so the lifecycle
// manager has exactly one place to handle process death (crash detection + idle-unload alike). stderr is
// inherited rather than piped and left unread, so a chatty provider can never block on stdio backpressure.
export const spawnPersistentProcess: PersistentProcessLauncher = (
  binaryPath,
  args,
  onLine,
  onExit
) => {
  const child = spawn(binaryPath, [...args], { stdio: ["pipe", "pipe", "inherit"] });
  let exited = false;
  const notifyExit = (): void => {
    if (exited) {
      return;
    }
    exited = true;
    onExit();
  };

  if (child.stdout !== null) {
    const lines = createInterface({ input: child.stdout });
    lines.on("line", onLine);
  }
  child.on("exit", notifyExit);
  // A spawn failure (e.g. a missing binary) surfaces as an 'error' event with no matching 'exit'; treat
  // it as process death too so the manager's respawn/reject path is never bypassed.
  child.on("error", notifyExit);

  return Object.freeze({
    kill: () => {
      child.kill();
    },
    writeLine: (line: string) => {
      child.stdin?.write(`${line}\n`);
    }
  });
};
