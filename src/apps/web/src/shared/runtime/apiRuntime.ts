import {
  defaultWebHostRuntimeConfig,
  hostRuntimeConfigGlobalKey,
  resolveApiUrl,
  resolveHostRuntimeConfig,
  type HostPlatform,
  type HostRuntimeConfig,
  type HostRuntimeConfigResolution
} from "@whetstone/contracts";

// The one runtime every web API call resolves its URL through, so a single host contract decides where
// calls go: browser web keeps same-origin `/api`, a native desktop/iOS shell points them at its
// injected absolute origin. The app boundary calls `bootstrapApiRuntime` once at startup; until then
// (and in unit tests) the runtime serves the browser-web default, which is why callers never hardcode
// `/api` and tests need no setup.
let activeConfig: HostRuntimeConfig = defaultWebHostRuntimeConfig;

// Install a validated host config as the active runtime. Called by the boundary after resolution; also
// usable in tests to exercise a native host without touching globals.
export function initializeApiRuntime(config: HostRuntimeConfig): void {
  activeConfig = config;
}

// The canonical API URL resolver used by every feature: `apiUrl("/works")` -> `/api/works` on web, or
// `https://app.example/api/works` under a native host. Feature code passes the path with no `/api`
// prefix so the host base is the single source of truth.
export function apiUrl(path: string): string {
  return resolveApiUrl(activeConfig.apiBaseUrl, path);
}

// The active host platform, for the rare UI that must branch on where it runs.
export function hostPlatform(): HostPlatform {
  return activeConfig.platform;
}

// Read the host injection from a scope (the browser `window`), resolve it, and install it when valid.
// Returns the resolution so the boundary can render a blocking error (fail loud) on an invalid host
// injection instead of silently starting with a wrong base.
export function bootstrapApiRuntime(scope: Record<string, unknown>): HostRuntimeConfigResolution {
  const resolution = resolveHostRuntimeConfig(scope[hostRuntimeConfigGlobalKey]);

  if (resolution.ok) {
    initializeApiRuntime(resolution.config);
  }

  return resolution;
}
