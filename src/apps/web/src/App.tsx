import { AppRoutes } from "./app/AppRoutes";

// The application is the routed shell. A Router (hash in production, memory in tests) is
// provided by the composition root / test harness.
export function App(): React.JSX.Element {
  return <AppRoutes />;
}
