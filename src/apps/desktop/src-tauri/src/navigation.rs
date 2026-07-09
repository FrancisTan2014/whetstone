//! Navigation policy for the desktop webview.
//!
//! The shell serves the bundled web app from an internal host. Top-level
//! navigations to any other http(s) host (e.g. an author's external link) are
//! opened in the system browser instead of hijacking the app window.

use tauri::Url;

/// Hosts the bundled webview serves the app from; navigations to these stay in
/// the app window. Tauri serves bundled assets from `tauri.localhost` on
/// Windows and uses `localhost` for the dev server.
const INTERNAL_HOSTS: [&str; 2] = ["tauri.localhost", "localhost"];

/// Returns true when a top-level navigation should open in the system browser
/// instead of inside the app webview: any http/https URL whose host is not one
/// of the internal app hosts. Non-http(s) schemes (e.g. `tauri://`) stay in-app.
pub fn is_external_navigation(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url
            .host_str()
            .map_or(true, |host| !INTERNAL_HOSTS.contains(&host))
}

/// Decision for a new-window request (`window.open` / `target="_blank"`).
///
/// Tauri routes these through `on_new_window`, a path distinct from top-level
/// `on_navigation`. The web app's external links (e.g. dictionary links in the
/// lookup panel) are `target="_blank"`, so they arrive here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NewWindowDecision {
    /// Open the URL in the system browser; do not create an in-app webview.
    OpenExternally,
    /// Let the request open in-app (internal app URLs).
    AllowInApp,
}

/// Classify a new-window request. External http(s) hosts open in the system
/// browser; internal app URLs (and non-http schemes) are allowed in-app. Shares
/// the same host policy as [`is_external_navigation`].
pub fn classify_new_window(url: &Url) -> NewWindowDecision {
    if is_external_navigation(url) {
        NewWindowDecision::OpenExternally
    } else {
        NewWindowDecision::AllowInApp
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_https_host_is_external() {
        let url = Url::parse("https://example.com/article").unwrap();
        assert!(is_external_navigation(&url));
    }

    #[test]
    fn external_http_host_is_external() {
        let url = Url::parse("http://news.example.org/x").unwrap();
        assert!(is_external_navigation(&url));
    }

    #[test]
    fn internal_bundled_host_stays_in_app() {
        let url = Url::parse("http://tauri.localhost/index.html#/reader").unwrap();
        assert!(!is_external_navigation(&url));
    }

    #[test]
    fn internal_dev_host_stays_in_app() {
        let url = Url::parse("http://localhost:5273/").unwrap();
        assert!(!is_external_navigation(&url));
    }

    #[test]
    fn non_http_scheme_stays_in_app() {
        let tauri_url = Url::parse("tauri://localhost/index.html").unwrap();
        assert!(!is_external_navigation(&tauri_url));
        let data_url = Url::parse("data:text/html,hi").unwrap();
        assert!(!is_external_navigation(&data_url));
    }

    #[test]
    fn new_window_to_external_host_opens_externally() {
        let url = Url::parse("https://en.wiktionary.org/wiki/test").unwrap();
        assert_eq!(classify_new_window(&url), NewWindowDecision::OpenExternally);
    }

    #[test]
    fn new_window_to_internal_host_stays_in_app() {
        let bundled = Url::parse("http://tauri.localhost/index.html#/reader").unwrap();
        assert_eq!(classify_new_window(&bundled), NewWindowDecision::AllowInApp);
        let dev = Url::parse("http://localhost:5273/#/library").unwrap();
        assert_eq!(classify_new_window(&dev), NewWindowDecision::AllowInApp);
    }

    #[test]
    fn new_window_with_non_http_scheme_stays_in_app() {
        let url = Url::parse("tauri://localhost/index.html").unwrap();
        assert_eq!(classify_new_window(&url), NewWindowDecision::AllowInApp);
    }
}
