import { useCallback, useEffect, useRef, useState } from "react";

import type {
  CaptureLanguage,
  VoiceCaptureAcceptedDto,
  VoiceCaptureStatus,
  VoiceCaptureStatusDto
} from "@whetstone/contracts";

import {
  fetchActiveVoiceCaptures,
  fetchVoiceCaptureStatus,
  retryVoiceCapture,
  submitVoiceCapture
} from "./voiceCaptureApi";

// The saved-first Tap-and-Talk model (#566): the reusable core shared by Today and Diary. It owns the
// list of pending voice captures (queued/transcribing/tidying) plus any failed ones, rebuilds that list
// from the server on mount and after every submit — so nothing lives only in the browser — and polls the
// non-terminal ones until each becomes ready or fails. A ready capture leaves this list and is handed to
// `onReady` (the Diary drops it into the Timeline in place); a failed one stays visible so it can be
// retried. The API and poll interval are injected so the whole loop tests with fakes and fake timers.

// A capture the worker is still processing (safe to keep polling). `ready` graduates out of the list;
// `failed` is terminal-but-visible (retryable), so neither is polled.
const nonTerminalStatuses: ReadonlySet<VoiceCaptureStatus> = new Set([
  "queued",
  "transcribing",
  "tidying"
]);

export function isNonTerminalVoiceCapture(capture: VoiceCaptureStatusDto): boolean {
  return nonTerminalStatuses.has(capture.status);
}

// Oldest-first, so pending rows render in the user's capture order (ISO timestamps sort chronologically).
function byCreatedAt(
  captures: ReadonlyArray<VoiceCaptureStatusDto>
): ReadonlyArray<VoiceCaptureStatusDto> {
  return [...captures].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// Fold a poll's fetched statuses back into the list: a now-ready capture drops out (it moves to the
// Timeline), any other status updates the row in place, and rows that were not polled are untouched.
function applyPolled(
  current: ReadonlyArray<VoiceCaptureStatusDto>,
  fetched: ReadonlyArray<VoiceCaptureStatusDto>
): ReadonlyArray<VoiceCaptureStatusDto> {
  const updates = new Map(fetched.map((capture) => [capture.id, capture]));
  return current.flatMap((capture) => {
    const next = updates.get(capture.id);
    if (next === undefined) {
      return [capture];
    }
    return next.status === "ready" ? [] : [next];
  });
}

export type VoiceCaptureApi = Readonly<{
  submit: (audio: Blob, language: CaptureLanguage) => Promise<VoiceCaptureAcceptedDto>;
  fetchActive: () => Promise<ReadonlyArray<VoiceCaptureStatusDto>>;
  fetchStatus: (id: string) => Promise<VoiceCaptureStatusDto>;
  retry: (id: string) => Promise<VoiceCaptureStatusDto>;
}>;

const defaultApi: VoiceCaptureApi = {
  submit: submitVoiceCapture,
  fetchActive: fetchActiveVoiceCaptures,
  fetchStatus: fetchVoiceCaptureStatus,
  retry: retryVoiceCapture
};

// How often to poll while pending work exists. Calm by design (#566): a few seconds, not a tight loop
// that would spam the local server. Polling stops entirely when nothing is non-terminal.
const DEFAULT_POLL_INTERVAL_MS = 2500;

export type UseVoiceCapturesOptions = Readonly<{
  api?: VoiceCaptureApi;
  pollIntervalMs?: number;
  onReady?: (capture: VoiceCaptureStatusDto) => void;
}>;

export type UseVoiceCapturesResult = Readonly<{
  captures: ReadonlyArray<VoiceCaptureStatusDto>;
  submitting: boolean;
  submit: (audio: Blob, language: CaptureLanguage) => Promise<boolean>;
  retry: (id: string) => Promise<boolean>;
}>;

export function useVoiceCaptures(options: UseVoiceCapturesOptions = {}): UseVoiceCapturesResult {
  const { pollIntervalMs = DEFAULT_POLL_INTERVAL_MS } = options;
  const [captures, setCaptures] = useState<ReadonlyArray<VoiceCaptureStatusDto>>([]);
  const [submitting, setSubmitting] = useState(false);

  // Injected api / onReady kept in refs so the poll loop always sees the latest without re-subscribing.
  const apiRef = useRef(options.api ?? defaultApi);
  apiRef.current = options.api ?? defaultApi;
  const onReadyRef = useRef(options.onReady);
  onReadyRef.current = options.onReady;
  // The latest committed captures, read inside the interval callback (which closes over a stale render).
  const capturesRef = useRef(captures);
  capturesRef.current = captures;

  // Rebuild the pending list from the server (mount + after each submit): the server is the single source
  // of truth, so a refresh recovers saved pending/failed captures with no local-only queue state.
  const refresh = useCallback(async () => {
    try {
      const active = await apiRef.current.fetchActive();
      setCaptures(byCreatedAt(active));
    } catch {
      // A failed refresh simply leaves the current list; the next submit/poll reconciles it.
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // One poll pass: fetch every non-terminal capture's status, fold the results in (ready ones graduate
  // to the Timeline via onReady), leaving failed ones visible for retry. Individual failures are ignored
  // so one flaky request never disturbs the rest.
  const pollOnce = useCallback(async () => {
    const pending = capturesRef.current.filter(isNonTerminalVoiceCapture);
    const settled = await Promise.allSettled(
      pending.map((capture) => apiRef.current.fetchStatus(capture.id))
    );
    const fetched = settled.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : []
    );
    const ready = fetched.filter((capture) => capture.status === "ready");
    setCaptures((current) => applyPolled(current, fetched));
    for (const capture of ready) {
      onReadyRef.current?.(capture);
    }
  }, []);

  // Poll only while there is non-terminal work; the loop is torn down the moment nothing is pending, so
  // the app never polls in a steady state. Self-scheduling (each tick re-arms only after the previous
  // poll resolves) so a slow request never stacks overlapping polls. `hasPending` restarts it as work
  // appears.
  const hasPending = captures.some(isNonTerminalVoiceCapture);
  useEffect(() => {
    if (!hasPending) {
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async (): Promise<void> => {
      await pollOnce();
      if (!cancelled) {
        timer = setTimeout(() => void tick(), pollIntervalMs);
      }
    };
    timer = setTimeout(() => void tick(), pollIntervalMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [hasPending, pollIntervalMs, pollOnce]);

  const submit = useCallback(
    async (audio: Blob, language: CaptureLanguage): Promise<boolean> => {
      setSubmitting(true);
      try {
        await apiRef.current.submit(audio, language);
        await refresh();
        return true;
      } catch {
        return false;
      } finally {
        setSubmitting(false);
      }
    },
    [refresh]
  );

  const retry = useCallback(async (id: string): Promise<boolean> => {
    try {
      const requeued = await apiRef.current.retry(id);
      setCaptures((current) =>
        byCreatedAt(current.map((capture) => (capture.id === id ? requeued : capture)))
      );
      return true;
    } catch {
      return false;
    }
  }, []);

  return { captures, submitting, submit, retry };
}
