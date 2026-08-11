//! Window lifecycle: closing the app without losing unsaved work.
//!
//! Until 0.5.0 the editor wrote every buffer to disk 800ms after the last keystroke, so
//! quitting could discard at most that. Autosave is now a setting that is off by
//! default, which means a quit can throw away an afternoon — so the window no longer
//! closes on its own.
//!
//! Every close request is cancelled and handed to the webview, which asks about each
//! modified file and then calls [`app_confirm_close`]. That command is the only way the
//! window actually goes away.

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;

/// Set once the frontend has settled every unsaved file and the quit may proceed.
///
/// A flag rather than managed state because the window-event handler is a plain closure
/// with no access to one — and because this is genuinely one bit: either the question
/// has been answered or it has not.
static CLOSE_CONFIRMED: AtomicBool = AtomicBool::new(false);

/// Close the main window for real.
///
/// The only way past the guard in [`install_close_guard`]. It asks nothing itself: by
/// the time the frontend calls this, the user has already answered for every file.
#[tauri::command]
pub fn app_confirm_close(window: tauri::Window) {
    CLOSE_CONFIRMED.store(true, Ordering::SeqCst);
    let _ = window.destroy();
}

/// Cancel a close and ask the frontend instead.
///
/// Wired into the Tauri builder's `on_window_event`.
pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    let tauri::WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
    if CLOSE_CONFIRMED.load(Ordering::SeqCst) {
        return;
    }
    api.prevent_close();

    // A failed emit means the webview is gone or wedged, and nothing will ever call
    // `app_confirm_close`. Let the close through rather than leaving a window that
    // cannot be shut — an unclosable app is worse than an unprompted quit.
    if window.emit("close-requested", ()).is_err() {
        CLOSE_CONFIRMED.store(true, Ordering::SeqCst);
        let _ = window.destroy();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn close_starts_unconfirmed() {
        // The guard is only useful if it begins closed: a flag that started true would
        // let the first quit through without asking.
        assert!(!CLOSE_CONFIRMED.load(Ordering::SeqCst));
    }
}
