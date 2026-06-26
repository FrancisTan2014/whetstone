import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";

export type ToastIntent = "success" | "error";

export type ToastItem = Readonly<{
  id: number;
  intent: ToastIntent;
  message: string;
}>;

// How long a toast stays before it auto-dismisses.
const autoDismissMs = 5000;

// The enqueue API a feature reaches for to report an action result.
export type ToastApi = Readonly<{
  error: (message: string) => void;
  success: (message: string) => void;
}>;

// What the single live-region viewport needs: the current queue and a way to dismiss.
type ToastQueue = Readonly<{
  dismiss: (id: number) => void;
  toasts: ReadonlyArray<ToastItem>;
}>;

type ToastContextValue = ToastApi & ToastQueue;

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

// Owns the toast queue: enqueues messages with a per-toast auto-dismiss timer, exposes the
// enqueue API and the queue snapshot, and clears any pending timers on unmount. The queue
// is a value snapshot (never a mutable internal), so consumers cannot tamper with it.
export function ToastProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [toasts, setToasts] = useState<ReadonlyArray<ToastItem>>([]);
  const nextId = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const enqueue = useCallback(
    (message: string, intent: ToastIntent) => {
      const id = nextId.current;
      nextId.current += 1;
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), autoDismissMs)
      );
      setToasts((current) => [...current, { id, intent, message }]);
    },
    [dismiss]
  );

  // The enqueue API is referentially stable (it only closes over the stable `enqueue`), so a
  // memoized consumer can depend on it without re-running when the queue changes.
  const error = useCallback((message: string) => enqueue(message, "error"), [enqueue]);
  const success = useCallback((message: string) => enqueue(message, "success"), [enqueue]);

  useEffect(() => {
    const pending = timers.current;

    return () => {
      for (const timer of pending.values()) {
        clearTimeout(timer);
      }
      pending.clear();
    };
  }, []);

  const value = useMemo<ToastContextValue>(
    () => ({
      dismiss,
      error,
      success,
      toasts
    }),
    [dismiss, error, success, toasts]
  );

  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

function useToastContext(): ToastContextValue {
  const value = useContext(ToastContext);

  if (value === undefined) {
    throw new Error("useToast must be used within a ToastProvider.");
  }

  return value;
}

// Public hook: the enqueue API for any feature that reports an action result.
export function useToast(): ToastApi {
  const { error, success } = useToastContext();

  return useMemo(() => ({ error, success }), [error, success]);
}

// Internal hook for the single live-region viewport.
export function useToastQueue(): ToastQueue {
  const { dismiss, toasts } = useToastContext();

  return { dismiss, toasts };
}
