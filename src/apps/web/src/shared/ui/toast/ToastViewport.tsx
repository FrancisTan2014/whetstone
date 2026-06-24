import { useEffect, useState } from "react";

import { Toast } from "../Toast.js";
import { useToastQueue } from "./ToastProvider.js";

// The app's single accessible live region for transient result notifications, mounted once
// in the app shell. Queued toasts render in a non-overlapping vertical stack pinned to the
// bottom, safe-area aware and identical on desktop and mobile. The container ignores
// pointer events so it never blocks the page; each toast re-enables them for its dismiss
// button. Reduced motion is read once and handed to each toast's spring.
export function ToastViewport(): React.JSX.Element {
  const { dismiss, toasts } = useToastQueue();
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    setPrefersReducedMotion(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }, []);

  return (
    <div
      aria-label="Notifications"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]"
      role="region"
    >
      {toasts.map((toast) => (
        <Toast
          intent={toast.intent}
          key={toast.id}
          message={toast.message}
          onDismiss={() => dismiss(toast.id)}
          prefersReducedMotion={prefersReducedMotion}
        />
      ))}
    </div>
  );
}
