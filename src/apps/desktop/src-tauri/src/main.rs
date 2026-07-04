// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;
use whetstone_desktop::{host_config, navigation};

fn main() {
    // Resolve host runtime config once at startup and inject it before the web
    // app boots. A missing base URL is injected as empty so the web resolver
    // (#445) shows its fail-loud startup screen instead of guessing.
    let config = host_config::HostConfig::desktop(host_config::resolve_api_base_url().as_deref());
    let init_script = host_config::injection_script(&config);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            let handle = app.handle().clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("Whetstone")
                .inner_size(1200.0, 800.0)
                .min_inner_size(800.0, 600.0)
                .initialization_script(&init_script)
                .on_navigation(move |url| {
                    // Open external links in the system browser; keep in-app
                    // navigations (bundled assets, hash routes) in the window.
                    if navigation::is_external_navigation(url) {
                        let _ = handle.opener().open_url(url.to_string(), None::<&str>);
                        return false;
                    }
                    true
                })
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the Whetstone desktop shell");
}
