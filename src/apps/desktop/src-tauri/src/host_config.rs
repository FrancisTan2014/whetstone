//! Host runtime configuration injected into the web app before it boots.
//!
//! The web client reads `window.__WHETSTONE_HOST_CONFIG__` at startup (see the
//! `@whetstone/contracts` host runtime contract added in #445). The desktop
//! shell sets `platform = "desktop"` and the configured `apiBaseUrl`. A missing
//! or empty base URL is injected verbatim (as an empty string) so the web
//! resolver fails loud instead of silently falling back to a relative `/api`.

use serde::Serialize;

/// Global variable the web bootstrap reads for host runtime config.
///
/// Must match `hostRuntimeConfigGlobalKey` in `@whetstone/contracts`.
pub const HOST_CONFIG_GLOBAL_KEY: &str = "__WHETSTONE_HOST_CONFIG__";

/// Environment variable that supplies the API base URL for the desktop shell.
pub const API_BASE_URL_ENV: &str = "WHETSTONE_API_BASE_URL";

/// The host runtime config the shell injects before the web app boots.
///
/// Serializes to the exact shape the web resolver expects: an object with
/// `platform` and `apiBaseUrl` and nothing else.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HostConfig {
    pub platform: String,
    #[serde(rename = "apiBaseUrl")]
    pub api_base_url: String,
}

impl HostConfig {
    /// Build the desktop host config from an optional configured API base URL.
    ///
    /// A missing base yields an empty `apiBaseUrl`; the web resolver treats an
    /// empty base on a native platform as invalid and shows the fail-loud
    /// startup screen. Surrounding whitespace is trimmed.
    pub fn desktop(api_base_url: Option<&str>) -> Self {
        HostConfig {
            platform: "desktop".to_string(),
            api_base_url: api_base_url.map(str::trim).unwrap_or("").to_string(),
        }
    }
}

/// Pick the first non-empty base URL, preferring the runtime value over the
/// value baked in at compile time. Whitespace-only values are ignored.
pub fn pick_base_url(runtime: Option<&str>, compiled: Option<&str>) -> Option<String> {
    for candidate in [runtime, compiled] {
        if let Some(value) = candidate {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

/// Resolve the API base URL from the environment.
///
/// Precedence: the runtime `WHETSTONE_API_BASE_URL` variable, then the value
/// baked in at compile time (so a packaged build can carry a default).
pub fn resolve_api_base_url() -> Option<String> {
    let runtime = std::env::var(API_BASE_URL_ENV).ok();
    pick_base_url(runtime.as_deref(), option_env!("WHETSTONE_API_BASE_URL"))
}

/// The JavaScript injected before the web app boots, setting the host-config
/// global. `serde_json` guarantees the value is safely encoded.
pub fn injection_script(config: &HostConfig) -> String {
    let json = serde_json::to_string(config).expect("host config serializes to JSON");
    format!("window.{HOST_CONFIG_GLOBAL_KEY} = {json};")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_uses_provided_base_url() {
        let config = HostConfig::desktop(Some("https://api.example.com"));
        assert_eq!(config.platform, "desktop");
        assert_eq!(config.api_base_url, "https://api.example.com");
    }

    #[test]
    fn desktop_trims_surrounding_whitespace() {
        let config = HostConfig::desktop(Some("  https://api.example.com  "));
        assert_eq!(config.api_base_url, "https://api.example.com");
    }

    #[test]
    fn desktop_missing_base_url_becomes_empty() {
        let config = HostConfig::desktop(None);
        assert_eq!(config.platform, "desktop");
        assert_eq!(config.api_base_url, "");
    }

    #[test]
    fn pick_base_url_prefers_runtime_value() {
        assert_eq!(
            pick_base_url(Some("https://runtime"), Some("https://compiled")),
            Some("https://runtime".to_string())
        );
    }

    #[test]
    fn pick_base_url_falls_back_to_compiled_value() {
        assert_eq!(
            pick_base_url(None, Some("https://compiled")),
            Some("https://compiled".to_string())
        );
    }

    #[test]
    fn pick_base_url_skips_whitespace_only_values() {
        assert_eq!(pick_base_url(Some("   "), Some("https://compiled")), Some("https://compiled".to_string()));
        assert_eq!(pick_base_url(Some("   "), None), None);
        assert_eq!(pick_base_url(None, None), None);
    }

    #[test]
    fn injection_script_sets_the_expected_global() {
        let config = HostConfig::desktop(Some("https://api.example.com"));
        let script = injection_script(&config);
        assert_eq!(
            script,
            "window.__WHETSTONE_HOST_CONFIG__ = {\"platform\":\"desktop\",\"apiBaseUrl\":\"https://api.example.com\"};"
        );
    }

    #[test]
    fn injection_script_produces_valid_json_payload() {
        // The right-hand side must parse as JSON with exactly the two keys the
        // web resolver expects.
        let config = HostConfig::desktop(Some("https://api.example.com"));
        let script = injection_script(&config);
        let json = script
            .strip_prefix("window.__WHETSTONE_HOST_CONFIG__ = ")
            .and_then(|rest| rest.strip_suffix(';'))
            .expect("script wraps a JSON value");
        let value: serde_json::Value = serde_json::from_str(json).expect("valid JSON");
        assert_eq!(value["platform"], "desktop");
        assert_eq!(value["apiBaseUrl"], "https://api.example.com");
        assert_eq!(value.as_object().unwrap().len(), 2);
    }

    #[test]
    fn injection_script_escapes_untrusted_characters() {
        // A base URL containing a double quote must not break out of the JS
        // string literal; serde_json escapes it and the payload still
        // round-trips back to the original value.
        let raw = "https://x/a\"b";
        let config = HostConfig::desktop(Some(raw));
        let script = injection_script(&config);
        assert!(script.contains("\\\""), "double quote should be escaped");
        let json = script
            .strip_prefix("window.__WHETSTONE_HOST_CONFIG__ = ")
            .and_then(|rest| rest.strip_suffix(';'))
            .expect("script wraps a JSON value");
        let value: serde_json::Value = serde_json::from_str(json).expect("valid JSON");
        assert_eq!(value["apiBaseUrl"], raw);
    }
}
