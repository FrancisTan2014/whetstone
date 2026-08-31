import {
  spawnPersistentProcess,
  type PersistentProcessHandle,
  type PersistentProcessLauncher
} from "./speechProcess.js";

// #884: keep the configured local speech provider's process warm across a burst of captures instead of
// paying a full cold model load on every single one. Started lazily on first capture (never at boot);
// a fixed 5-minute sliding idle window then keeps it resident only while captures keep landing, and
// kills it outright once the window elapses so its memory is reliably handed back to the OS (an
// in-process "unload" cannot do that - see docs/SPEECH.md). A crash mid-request is detected and the
// in-flight request rejects (so the caller's existing `transcription_failed` retry path handles it,
// never a hang); the NEXT capture transparently respawns and pays the cold-start cost again.

// Not a new env var - the config surface stays exactly what #799 already exposes (LOCAL_ASR_BINARY /
// LOCAL_ASR_MODEL). A fixed, named constant so the window is auditable and tests can pin it exactly.
export const IDLE_UNLOAD_MS = 5 * 60 * 1000;

const PERSISTENT_MODE_FLAG = "--persistent";

export type PersistentSpeechManagerConfig = Readonly<{
  binaryPath: string;
  modelIdentifier: string;
}>;

// The CLI arguments that start a provider in persistent mode (#884): the model identifier and nothing
// else - no audio positional, since each capture's audio path arrives later, one per stdin line.
export function buildPersistentModeArgs(
  config: PersistentSpeechManagerConfig
): ReadonlyArray<string> {
  return [PERSISTENT_MODE_FLAG, "--model", config.modelIdentifier];
}

export type PersistentSpeechManagerDependencies = Readonly<{
  config: PersistentSpeechManagerConfig;
  launch?: PersistentProcessLauncher;
}>;

export type PersistentSpeechManager = Readonly<{
  // Route one capture's audio path to the persistent process, lazily starting it on first call and
  // transparently respawning after a crash or an idle-unload. Resolves with the raw stdout JSON line -
  // the SAME transcript contract one-shot mode returns - or rejects when the process dies before
  // responding. Rejects immediately, without touching the process, if a request is already in flight
  // (#565: one capture at a time - a defensive guard, never expected to trigger given the worker's own
  // single-capture-at-a-time loop).
  transcribe: (audioPath: string) => Promise<string>;
  // Best-effort shutdown hook: kill any resident process and cancel its idle timer. Called once from
  // the server's own shutdown path so a restart never leaves an orphaned child process behind.
  close: () => void;
}>;

type PendingRequest = Readonly<{
  reject: (error: Error) => void;
  resolve: (stdout: string) => void;
}>;

export function createPersistentSpeechManager(
  dependencies: PersistentSpeechManagerDependencies
): PersistentSpeechManager {
  const launch = dependencies.launch ?? spawnPersistentProcess;

  // `generation` invalidates a process's callbacks the instant it is retired (idle-unload or crash), so
  // a late event from an already-dead process (its real OS exit can lag behind the synchronous
  // idle-unload kill) can never be mistaken for an event from whatever fresh process replaced it.
  let generation = 0;
  let activeHandle: PersistentProcessHandle | undefined;
  let pending: PendingRequest | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  function clearIdleTimer(): void {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  }

  function retire(): void {
    generation += 1;
    clearIdleTimer();
    activeHandle = undefined;
  }

  function scheduleIdleUnload(): void {
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      // The sliding window elapsed with no new capture: kill the process outright rather than leave it
      // resident. `retire()` flips `activeHandle` to undefined synchronously, so a capture arriving the
      // instant after this fires always spawns a fresh process rather than racing the real OS exit. No
      // generation guard is needed here: `retire()` always clears this exact timer, so this callback can
      // never still be pending once the generation it was scheduled for has moved on.
      activeHandle?.kill();
      retire();
    }, IDLE_UNLOAD_MS);
  }

  function ensureProcess(): PersistentProcessHandle {
    if (activeHandle !== undefined) {
      return activeHandle;
    }
    const myGeneration = generation;
    const handle = launch(
      dependencies.config.binaryPath,
      buildPersistentModeArgs(dependencies.config),
      (line) => {
        if (myGeneration !== generation) {
          return;
        }
        const request = pending;
        pending = undefined;
        scheduleIdleUnload();
        request?.resolve(line);
      },
      () => {
        if (myGeneration !== generation) {
          return;
        }
        // An unexpected exit while a request was in flight is a crash (#884): fail that one capture
        // cleanly through its existing rejection path and reset so the next capture respawns, instead
        // of hanging the worker or leaving a corrupted, half-initialized process behind.
        const inFlight = pending;
        pending = undefined;
        retire();
        inFlight?.reject(new Error("The persistent local speech process exited unexpectedly."));
      }
    );
    activeHandle = handle;
    return handle;
  }

  return Object.freeze({
    close(): void {
      const handle = activeHandle;
      retire();
      handle?.kill();
    },
    transcribe(audioPath: string): Promise<string> {
      if (pending !== undefined) {
        return Promise.reject(
          new Error("The persistent local speech process is already handling a request.")
        );
      }
      // Any capture resets the idle countdown - including one that merely STARTS while a stale timer
      // from the previous capture is still pending, so the process is never killed out from under an
      // in-flight request.
      clearIdleTimer();
      const handle = ensureProcess();
      return new Promise<string>((resolve, reject) => {
        pending = { reject, resolve };
        handle.writeLine(audioPath);
      });
    }
  });
}
