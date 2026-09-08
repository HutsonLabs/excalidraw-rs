//! The standalone app's Rust half.
//!
//! Deliberately thin. The document model is `xd-core` compiled to wasm and
//! living in the webview; the drawing is a canvas. What is left for the native
//! side is the two things a webview cannot do: read and write a file the user
//! chose, and know which file the OS asked us to open at launch.
//!
//! Every path that arrives here came from a `tauri-plugin-dialog` picker or
//! from the OS's own open-document event, so there is no path-sanitising to do
//! that the dialog has not already done — but the reads are still capped, and
//! writes still go through a temporary file, because the failure mode of a
//! drawing app that half-writes a save is the user's work.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{Emitter, Manager, State};

/// A `.excalidraw` scene is JSON with base64 image blobs inline, so it is
/// allowed to be large — but not unbounded. 256 MB is far past any real
/// drawing and still small enough that a mistargeted file fails fast instead
/// of taking the window down with it.
const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;

/// The file the OS asked us to open, parked until the frontend is ready to be
/// told about it. macOS delivers a double-clicked document as an
/// `Opened { urls }` event that can arrive before the webview has a listener,
/// so it has to be held rather than emitted into nowhere.
#[derive(Default)]
struct Startup(Mutex<Option<String>>);

#[tauri::command]
fn xd_read_file(path: String) -> Result<String, String> {
    let path = PathBuf::from(path);
    let meta = fs::metadata(&path).map_err(|e| format!("Couldn't open {}: {e}", show(&path)))?;
    if meta.len() > MAX_FILE_BYTES {
        return Err(format!(
            "{} is {} MB — too large to open.",
            show(&path),
            meta.len() / (1024 * 1024)
        ));
    }
    fs::read_to_string(&path).map_err(|e| format!("Couldn't read {}: {e}", show(&path)))
}

/// Write atomically: a temporary file beside the target, then a rename.
///
/// The alternative — truncate and write — leaves a zero-byte drawing on disk
/// if the process dies mid-save, and this app autosaves. A rename on the same
/// filesystem is atomic, so a reader either sees the old file or the new one.
#[tauri::command]
fn xd_write_file(path: String, contents: String) -> Result<(), String> {
    write_atomically(&PathBuf::from(path), contents.as_bytes())
}

/// The temporary-file-then-rename dance, shared by the text and bytes commands
/// so there is one place where saving is made durable rather than two that can
/// drift apart.
fn write_atomically(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let tmp = dir.join(format!(
        ".{}.tmp",
        path.file_name().and_then(|s| s.to_str()).unwrap_or("scene.excalidraw")
    ));
    let write = || -> std::io::Result<()> {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        // fsync before the rename: the rename being durable is worth nothing
        // if the bytes it points at are still in a buffer.
        f.sync_all()?;
        fs::rename(&tmp, path)
    };
    write().map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Couldn't save {}: {e}", show(path))
    })
}

/// Write bytes atomically. The same discipline as `xd_write_file`, and it
/// exists as a second command rather than a flag on the first because the
/// difference is the payload type, not the behaviour: a PNG through a `String`
/// would be mangled at every byte that is not valid UTF-8, which is most of
/// them. Tauri hands `Vec<u8>` across the boundary without transcoding, so an
/// export arrives here as the bytes the canvas produced.
#[tauri::command]
fn xd_write_bytes(path: String, contents: Vec<u8>) -> Result<(), String> {
    write_atomically(&PathBuf::from(path), &contents)
}

/// The document this launch was asked to open, if any — taken, not read, so a
/// reload of the webview doesn't reopen it a second time over the user's work.
#[tauri::command]
fn xd_startup_path(state: State<'_, Startup>) -> Option<String> {
    state.0.lock().ok().and_then(|mut s| s.take())
}

/// A path as the user would recognise it: the file name, not the full path,
/// because the full path in an error dialog is noise around the one word that
/// identifies which file went wrong.
fn show(path: &Path) -> String {
    path.file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("that file")
        .to_string()
}

/// The first `.excalidraw` argument on the command line. Linux and Windows
/// deliver a double-clicked document this way; macOS uses the Opened event.
fn arg_path() -> Option<String> {
    std::env::args().skip(1).find(|a| !a.starts_with('-'))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(Startup(Mutex::new(arg_path())))
        .invoke_handler(tauri::generate_handler![
            xd_read_file,
            xd_write_file,
            xd_write_bytes,
            xd_startup_path
        ])
        .on_window_event(|_window, _event| {})
        .build(tauri::generate_context!())
        .expect("error while building excalidraw-rs")
        .run(|app, event| {
            // macOS: a document opened from Finder or dropped on the dock.
            // Before the frontend exists it is parked in Startup and collected
            // by xd_startup_path; after, it arrives as an event.
            if let tauri::RunEvent::Opened { urls } = event {
                let path = urls
                    .iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .find_map(|p| p.to_str().map(str::to_owned));
                if let Some(path) = path {
                    let emitted = app
                        .get_webview_window("main")
                        .map(|w| w.emit("xd://open", path.clone()).is_ok())
                        .unwrap_or(false);
                    if !emitted {
                        if let Some(state) = app.try_state::<Startup>() {
                            if let Ok(mut slot) = state.0.lock() {
                                *slot = Some(path);
                            }
                        }
                    }
                }
            }
        });
}
