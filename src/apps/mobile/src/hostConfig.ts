import { hostRuntimeConfigGlobalKey, type HostRuntimeConfig } from "@whetstone/contracts";

// The iOS shell embeds the same web bundle from a local `capacitor://` origin, where same-origin `/api`
// is meaningless. So — mirroring the desktop shell — it injects the host runtime contract onto `window`
// before the web core boots: `platform: "ios"` plus the absolute API base the app must call. The web
// boundary (`bootstrapApiRuntime`) reads it, validates it once, and fails loud on an invalid/missing
// base. These are pure string/config helpers; the actual file I/O (reading the synced `index.html`,
// writing it back) lives in the sync-time script so this logic stays testable without a native project.

// Build the iOS host runtime config from the absolute API base the app should call. Trimming keeps a
// stray-whitespace env value from producing a subtly broken base; validation (absolute http(s) URL) is
// enforced by the shared `hostRuntimeConfigSchema` at the injection boundary and again in the web core.
export function iosHostConfig(apiBaseUrl: string): HostRuntimeConfig {
  return { apiBaseUrl: apiBaseUrl.trim(), platform: "ios" };
}

// The JS the shell runs before the web bundle: sets the injected global to the JSON-encoded config.
// JSON.stringify safely encodes the URL string, so no manual escaping can go wrong.
export function hostConfigInjectionScript(config: HostRuntimeConfig): string {
  return `window.${hostRuntimeConfigGlobalKey} = ${JSON.stringify(config)};`;
}

const closingHead = "</head>";

// Insert the injection `<script>` into the synced `index.html` just before `</head>`, so the global is
// set before the module bundle (loaded later in `<body>`) runs. Fail loud if the document has no
// `</head>` rather than silently producing an app whose API base is never injected.
export function injectHostConfigScript(html: string, script: string): string {
  if (!html.includes(closingHead)) {
    throw new Error(
      "Cannot inject the iOS host config: the synced index.html has no </head>. " +
        "Re-run `cap sync ios` to regenerate it from the web build, then retry."
    );
  }

  return html.replace(closingHead, `  <script>${script}</script>\n  ${closingHead}`);
}
