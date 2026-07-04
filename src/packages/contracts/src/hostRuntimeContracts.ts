import { z } from "zod";

// The runtime contract between a host (browser web, or a native desktop/iOS shell) and the web core.
// A native shell runs the same bundle from a local app origin (tauri://, capacitor://, file://), so
// same-origin `/api` is wrong there; the host injects the platform it is and the absolute API base the
// core must call. Browser web injects nothing and falls back to same-origin `/api` (see
// `defaultWebHostRuntimeConfig`). This is validated once at the app boundary, then trusted inward.
export const hostPlatforms = ["web", "desktop", "ios"] as const;

export const hostPlatformSchema = z.enum(hostPlatforms);

export type HostPlatform = z.infer<typeof hostPlatformSchema>;

// The global a native shell sets on `window` before the web bundle boots, e.g.
// `window.__WHETSTONE_HOST_CONFIG__ = { platform: "ios", apiBaseUrl: "https://app.example/api" }`.
export const hostRuntimeConfigGlobalKey = "__WHETSTONE_HOST_CONFIG__";

export const hostRuntimeConfigSchema = z
  .object({
    apiBaseUrl: z.string().trim().min(1),
    platform: hostPlatformSchema
  })
  .strict()
  .superRefine((value, ctx) => {
    // A native host cannot use a relative base — it has no meaningful same-origin `/api` — so require
    // an absolute http(s) URL and fail loud otherwise rather than silently building a broken URL.
    if (value.platform !== "web" && !/^https?:\/\//i.test(value.apiBaseUrl)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `platform "${value.platform}" requires an absolute http(s) apiBaseUrl`,
        path: ["apiBaseUrl"]
      });
    }
  });

export type HostRuntimeConfig = z.infer<typeof hostRuntimeConfigSchema>;

// Browser web with no host injection: same-origin `/api`.
export const defaultWebHostRuntimeConfig: HostRuntimeConfig = {
  apiBaseUrl: "/api",
  platform: "web"
};

export type HostRuntimeConfigResolution =
  | { readonly ok: true; readonly config: HostRuntimeConfig }
  | { readonly ok: false; readonly message: string };

function describeHostConfigError(error: z.ZodError): string {
  const details = error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "config"}: ${issue.message}`)
    .join("; ");

  return (
    `Invalid host runtime config (${details}). ` +
    `Expected { platform: "web" | "desktop" | "ios", apiBaseUrl: non-empty string; ` +
    `native platforms require an absolute http(s) URL } injected as ` +
    `window.${hostRuntimeConfigGlobalKey}.`
  );
}

// Resolve raw injected host config into a usable config or a fail-loud message. No injection
// (undefined/null) is the legitimate browser-web case and yields the default; a present-but-invalid
// injection never falls back to a fake default — it returns `ok: false` so the boundary can block.
export function resolveHostRuntimeConfig(raw: unknown): HostRuntimeConfigResolution {
  if (raw === undefined || raw === null) {
    return { config: defaultWebHostRuntimeConfig, ok: true };
  }

  const parsed = hostRuntimeConfigSchema.safeParse(raw);

  if (!parsed.success) {
    return { message: describeHostConfigError(parsed.error), ok: false };
  }

  return { config: parsed.data, ok: true };
}

// The canonical API URL resolver: join the host's API base with a path, collapsing any trailing slash
// on the base and ensuring exactly one separator, so `/api` + `works`, `/api/` + `/works`, and
// `https://h/api/` + `/works` all yield one clean URL.
export function resolveApiUrl(apiBaseUrl: string, path: string): string {
  const base = apiBaseUrl.replace(/\/+$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;

  return `${base}${normalizedPath}`;
}
