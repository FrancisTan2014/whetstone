import { AppRoutes } from "./app/AppRoutes";
import { ToastProvider } from "./shared/ui/toast/ToastProvider";

// The application is the routed shell wrapped in the app-wide toast provider, so any
// feature can report an action result and the shell's single live region renders it. A
// Router (hash in production, memory in tests) is provided by the composition root / test
// harness.
export function App(): React.JSX.Element {
  return (
    <ToastProvider>
      <AppRoutes />
    </ToastProvider>
  );
}
