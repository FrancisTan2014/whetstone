//! Whetstone desktop shell library.
//!
//! The pure, unit-testable glue for the Tauri shell lives here so it can be
//! exercised with `cargo test --lib` without compiling the Tauri application
//! bundle (which embeds the built web assets via `generate_context!`).

pub mod host_config;
pub mod navigation;
