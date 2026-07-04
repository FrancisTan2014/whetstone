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
        let url = Url::parse("http://localhost:5173/").unwrap();
        assert!(!is_external_navigation(&url));
    }

    #[test]
    fn non_http_scheme_stays_in_app() {
        let tauri_url = Url::parse("tauri://localhost/index.html").unwrap();
        assert!(!is_external_navigation(&tauri_url));
        let data_url = Url::parse("data:text/html,hi").unwrap();
        assert!(!is_external_navigation(&data_url));
    }
}
