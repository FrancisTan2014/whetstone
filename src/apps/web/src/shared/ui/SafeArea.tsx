type SafeAreaProps = Readonly<{
  children: React.ReactNode;
}>;

// Full-viewport layout primitive. Uses `100svh`/`100dvh` (never `100vh`) and the
// `env(safe-area-inset-*)` insets via the `.app-safe-area` utility so the shell fits
// notched displays and keyboard-aware WebViews across web/Capacitor/Tauri.
export function SafeArea({ children }: SafeAreaProps): React.JSX.Element {
  return <div className="app-safe-area">{children}</div>;
}
