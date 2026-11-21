/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * Source:  https://github.com/gitakoos/photos-desktop
 * Website: https://www.photosforproton.eu
 *
 * This file is part of Photos for Proton.
 *
 * Photos for Proton is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3 as
 * published by the Free Software Foundation.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

// The "Proton Photos" folder: the app's own place in Windows Explorer, and the
// default destination for downloaded originals. It appears in the Explorer
// navigation pane like a cloud drive once registered as a Cloud Filter sync root
// (see register.rs / the sync-root layer). Registration is best-effort: if it is
// not available the folder is still a normal, usable folder and downloads still
// work, so this layer never blocks the app.

use std::path::PathBuf;

#[cfg(windows)]
mod empty_folders;
#[cfg(windows)]
mod identity;
#[cfg(windows)]
mod relocate;
#[cfg(windows)]
mod verify;

pub(crate) const FOLDER_NAME: &str = "Proton Photos";

/// `%USERPROFILE%\Proton Photos`, a stable, top-level per-user location, the same
/// pattern OneDrive uses for its own folder. Where the folder lives until another place
/// is chosen in Settings.
pub(crate) fn default_sync_root() -> PathBuf {
    PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default()).join(FOLDER_NAME)
}

/// Where the folder is: the place chosen in Settings, else the default.
pub fn sync_root_path() -> PathBuf {
    #[cfg(windows)]
    {
        crate::sync_location::current().path
    }
    #[cfg(not(windows))]
    {
        default_sync_root()
    }
}

/// Whether the folder's drive is there. A folder chosen on a drive that is gone, or on another
/// disk that took its letter, is left alone: nothing is created, registered or deleted for it.
pub fn sync_root_available() -> bool {
    #[cfg(windows)]
    {
        crate::sync_location::available()
    }
    #[cfg(not(windows))]
    {
        true
    }
}

/// Create the folder if it is missing. Cheap and idempotent; safe on every launch.
pub fn ensure_folder() {
    if sync_root_available() {
        let _ = std::fs::create_dir_all(sync_root_path());
    }
}

#[cfg(windows)]
pub(crate) const PREF_KEY: &str = "Software\\PhotosForProton";
#[cfg(windows)]
const PREF_VALUE: &str = "ShowInExplorer";

/// Whether the Explorer "Proton Photos" mount is enabled. Default ON when the value
/// is missing. Set by the installer checkbox and the Settings toggle; read once at
/// startup to decide whether to mount.
#[cfg(windows)]
pub fn show_in_explorer_enabled() -> bool {
    winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
        .open_subkey(PREF_KEY)
        .and_then(|k| k.get_value::<u32, _>(PREF_VALUE))
        .map(|v| v != 0)
        .unwrap_or(true)
}
#[cfg(not(windows))]
pub fn show_in_explorer_enabled() -> bool {
    false
}

/// Where sign-out notes that it turned the folder off, with how many files it left there.
#[cfg(windows)]
const EXPLORER_OFF_NOTICE: &str = "explorer_off.txt";

/// Once, for the account that signs in next: the folder was turned off when the previous one
/// left, and this many files it had downloaded are still in it.
#[tauri::command]
pub fn take_explorer_notice(app: tauri::AppHandle) -> Option<u64> {
    #[cfg(windows)]
    {
        let left = crate::secure_store::read_sealed(&app, EXPLORER_OFF_NOTICE).ok().flatten()?;
        if let Ok(dir) = crate::secure_store::app_dir(&app) {
            let _ = std::fs::remove_file(dir.join(EXPLORER_OFF_NOTICE));
        }
        left.trim().parse().ok()
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        None
    }
}

/// Every file under `dir`, at any depth.
#[cfg(windows)]
fn files_under(dir: &std::path::Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    entries
        .flatten()
        .map(|e| match e.file_type() {
            Ok(t) if t.is_dir() => files_under(&e.path()),
            Ok(t) if t.is_file() => 1,
            _ => 0,
        })
        .sum()
}

/// The current preference, for the Settings toggle.
#[tauri::command]
pub fn show_in_explorer() -> bool {
    show_in_explorer_enabled()
}

/// Set the preference. Applies on the next app start (registering/unregistering the
/// sync root live is deliberately avoided — cleaner and less error-prone).
#[tauri::command]
pub fn set_show_in_explorer(enabled: bool) {
    #[cfg(windows)]
    if let Ok((key, _)) =
        winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER).create_subkey(PREF_KEY)
    {
        let _ = key.set_value(PREF_VALUE, &u32::from(enabled));
    }
    #[cfg(not(windows))]
    let _ = enabled;
}

/// Where the folder is, and whether its drive is there.
#[derive(Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocationInfo {
    path: String,
    is_default: bool,
    available: bool,
    moving: bool,
}

/// What `check_explorer_location` says about a picked folder: the place the folder would go to
/// and the room its drive has, or the reason it cannot.
#[derive(Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocationCheck {
    ok: bool,
    reason: Option<&'static str>,
    path: String,
    free: Option<u64>,
    adjusted: bool,
}

#[derive(serde::Serialize)]
#[cfg_attr(not(windows), allow(dead_code))]
pub struct LocationMoved {
    path: String,
    /// Files the user had put in the old folder, which stay there.
    left: u64,
}

#[tauri::command]
pub fn explorer_location() -> LocationInfo {
    #[cfg(windows)]
    {
        relocate::info()
    }
    #[cfg(not(windows))]
    LocationInfo {
        path: default_sync_root().to_string_lossy().into_owned(),
        is_default: true,
        available: true,
        moving: false,
    }
}

/// Whether the folder could go to the picked place.
#[tauri::command]
pub async fn check_explorer_location(path: String) -> LocationCheck {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || relocate::check(&path)).await.unwrap_or_default()
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        LocationCheck::default()
    }
}

/// Moves the folder to the picked place. The error is a code the window words.
#[tauri::command]
pub async fn move_explorer_location(app: tauri::AppHandle, path: String) -> Result<LocationMoved, String> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || relocate::move_folder(&app, std::path::Path::new(&path)))
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = (app, path);
        Err("unsupported".into())
    }
}

/// Starts watching the folder's drive, so a drive that was away is picked up again.
pub fn watch_drive(app: tauri::AppHandle) {
    #[cfg(windows)]
    relocate::watch_drive(app);
    #[cfg(not(windows))]
    let _ = app;
}

#[cfg(windows)]
const AUTO_DL_VALUE: &str = "AutoDownload";

/// The "Automatically download new photos" switch of the builds before, one value for the
/// whole Windows account. Read once and removed: it becomes the choice of the account signed
/// in at the time, and an account signing in later starts with nothing kept.
#[cfg(windows)]
pub(crate) fn take_legacy_auto_download() -> bool {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
    let Ok(key) = winreg::RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(PREF_KEY, KEY_READ | KEY_WRITE) else {
        return false;
    };
    let on = key.get_value::<u32, _>(AUTO_DL_VALUE).map(|v| v != 0).unwrap_or(false);
    let _ = key.delete_value(AUTO_DL_VALUE);
    on
}

/// What the folder keeps on this PC by itself: "off", "new" or "all".
#[tauri::command]
pub fn download_mode(app: tauri::AppHandle) -> String {
    #[cfg(windows)]
    {
        crate::keep_all::mode(&app).as_str().to_string()
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        "off".to_string()
    }
}

#[tauri::command]
pub fn set_download_mode(app: tauri::AppHandle, mode: String) {
    #[cfg(windows)]
    if let Some(next) = crate::keep_all::Mode::parse(&mode) {
        // Keeping photos runs through the folder: with the folder turned off only "off" is taken.
        if next != crate::keep_all::Mode::Off && !show_in_explorer_enabled() {
            return;
        }
        crate::keep_all::set_mode(&app, next);
    }
    #[cfg(not(windows))]
    let _ = (app, mode);
}

/// How the pass that keeps photos on this PC stands, for the Settings page.
#[tauri::command]
pub fn keep_status(app: tauri::AppHandle) -> crate::keep_all::KeepStatus {
    #[cfg(windows)]
    {
        crate::keep_all::status(&app)
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        crate::keep_all::KeepStatus::default()
    }
}

#[tauri::command]
pub fn keep_pause(app: tauri::AppHandle, paused: bool) {
    #[cfg(windows)]
    crate::keep_all::set_paused(&app, paused);
    #[cfg(not(windows))]
    let _ = (app, paused);
}

/// What keeping every photo would still download, and the room the drive has for it.
#[derive(Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeepEstimate {
    photos: u64,
    bytes: u64,
    free: Option<u64>,
}

#[tauri::command]
pub async fn keep_estimate() -> KeepEstimate {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(|| {
            let mut out = KeepEstimate { free: free_space(), ..Default::default() };
            for uid in timeline_uids() {
                if is_cloud_only(&uid) {
                    out.photos += 1;
                    out.bytes += cloud_size(&uid).unwrap_or(0);
                }
            }
            out
        })
        .await
        .unwrap_or_default()
    }
    #[cfg(not(windows))]
    KeepEstimate::default()
}

/// The answer about copies held back because too many photos went to the trash at once:
/// let go of them now, or keep them as the user's own. Returns how many were let go of.
#[tauri::command]
pub async fn keep_held_answer(app: tauri::AppHandle, remove: bool) -> u32 {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            let held = crate::keep_all::held(&app);
            let mut gone = 0u32;
            if remove {
                for (_, path, rel) in downloaded_copies_of(&held) {
                    if let_go_of_copy(&path, &rel) {
                        gone += 1;
                    }
                }
                rescan_hydrated();
            }
            crate::keep_all::clear_held(&app, &held);
            crate::note(&app, &format!("[keep] held copies answered: {gone} let go of"));
            gone
        })
        .await
        .unwrap_or(0)
    }
    #[cfg(not(windows))]
    {
        let _ = (app, remove);
        0
    }
}

#[cfg(windows)]
const EDITS_VALUE: &str = "ExplorerEdits";

/// Written by the uninstaller (same key and name in `setup`) before it clears the
/// folder's cloud-only files while the app still runs.
#[cfg(windows)]
const DETACHING_VALUE: &str = "Detaching";

/// Whether the uninstaller is clearing the folder: what disappears from it then is the
/// uninstall's doing, never the user's, so nothing goes to the trash and every delete
/// is let through.
#[cfg(windows)]
pub fn detaching() -> bool {
    winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
        .open_subkey(PREF_KEY)
        .and_then(|k| k.get_value::<u32, _>(DETACHING_VALUE))
        .is_ok_and(|v| v != 0)
}

#[cfg(windows)]
pub fn clear_detaching() {
    if let Ok(key) = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
        .open_subkey_with_flags(PREF_KEY, winreg::enums::KEY_SET_VALUE)
    {
        let _ = key.delete_value(DETACHING_VALUE);
    }
}
#[cfg(not(windows))]
pub fn clear_detaching() {}

/// Whether deleting and renaming in File Explorer reach the library. Default ON, as on
/// Linux. With it off, Explorer refuses what would take a photo or an album away.
#[cfg(windows)]
pub fn explorer_edits_enabled() -> bool {
    winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
        .open_subkey(PREF_KEY)
        .and_then(|k| k.get_value::<u32, _>(EDITS_VALUE))
        .map(|v| v != 0)
        .unwrap_or(true)
}

/// The current preference, for the Settings toggle.
#[tauri::command]
pub fn explorer_edits() -> bool {
    #[cfg(windows)]
    {
        explorer_edits_enabled()
    }
    #[cfg(not(windows))]
    false
}

/// Set the preference. Applies at once: the callbacks and the watcher read it each time.
#[tauri::command]
pub fn set_explorer_edits(enabled: bool) {
    #[cfg(windows)]
    if let Ok((key, _)) =
        winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER).create_subkey(PREF_KEY)
    {
        let _ = key.set_value(EDITS_VALUE, &u32::from(enabled));
    }
    #[cfg(not(windows))]
    let _ = enabled;
}

/// Register the folder as a Cloud Filter sync root (so it shows in the Explorer
/// nav pane as "Proton Photos" with the app icon, like OneDrive) and connect the
/// sync engine (so cloud-photo placeholders hydrate on open). Runs on one
/// COM-initialized thread: registration MUST come before connect (you can only
/// connect to a registered root). Best-effort and non-blocking — any failure just
/// leaves an ordinary folder where downloads still work. Registration lives in
/// HKCU and persists across reboots, so registering once is enough.
#[cfg(windows)]
pub fn mount(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        com_init();
        let _life = crate::sync_location::lifecycle();
        attach(&app);
    });
}

/// The Storage Provider (register) APIs need an initialized COM apartment.
#[cfg(windows)]
fn com_init() {
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    }
}

/// The engine's connection to the folder. Kept so it can be let go of when the folder moves or
/// its drive goes away; dropping it disconnects.
#[cfg(windows)]
struct Held {
    _connection: cloud_filter::root::Connection<ProtonSyncFilter>,
}

// SAFETY: the connection is a key, a channel and a thread handle. It is only ever dropped, by
// whichever thread ends the mount, and never used through this static.
#[cfg(windows)]
unsafe impl Send for Held {}

#[cfg(windows)]
static CONNECTION: std::sync::Mutex<Option<Held>> = std::sync::Mutex::new(None);

#[cfg(windows)]
fn mounted() -> bool {
    CONNECTION.lock().unwrap_or_else(|p| p.into_inner()).is_some()
}

/// Registers the folder, connects the engine and starts what watches over the folder. Nothing
/// happens while the folder's drive is not there, and nothing twice. True once connected.
#[cfg(windows)]
fn attach(app: &tauri::AppHandle) -> bool {
    use cloud_filter::root::Session;
    if mounted() {
        // Still connected after a move that stopped part way: the watcher is there again too.
        crate::explorer_sync::start(app.clone(), sync_root_path());
        return true;
    }
    if !sync_root_available() {
        crate::note(app, "[cloud] the drive of the folder is not connected, waiting");
        return false;
    }
    match try_register_sync_root(app) {
        Ok(()) => crate::note(app, "[cloud] sync root registered"),
        Err(e) => crate::note(app, &format!("[cloud] register skipped: {e}")),
    }
    let folder = sync_root_path();
    match Session::new().connect(&folder, ProtonSyncFilter { app: app.clone() }) {
        Ok(connection) => {
            crate::note(app, "[cloud] sync engine connected");
            *CONNECTION.lock().unwrap_or_else(|p| p.into_inner()) = Some(Held { _connection: connection });
            start_hydrated_scanner();
            crate::keep_all::start(app.clone());
            crate::explorer_sync::start(app.clone(), folder);
            true
        }
        Err(e) => {
            crate::note(app, &format!("[cloud] connect failed: {e:?}"));
            false
        }
    }
}

/// Stops watching the folder and disconnects the engine. The registration stays.
#[cfg(windows)]
fn detach() -> Result<(), String> {
    if !crate::explorer_sync::stop() {
        return Err("the folder's watcher did not stop".into());
    }
    let held = CONNECTION.lock().unwrap_or_else(|p| p.into_inner()).take();
    if let Some(held) = held {
        // Disconnecting reports a failure by panicking.
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || drop(held)))
            .map_err(|_| "the sync engine did not disconnect".to_string())?;
    }
    Ok(())
}

/// Sweep our own leftovers out of the system temp dir at startup.
///
/// Five kinds accumulate, none of which can be in use while this process is only
/// just starting:
///   - `pfp-hyd-*.bin`: a decrypted download staged for a placeholder transfer. The
///     host deletes each right after its transfer, so any here is an orphan from an
///     earlier crash, and it is plaintext photo data that should not linger.
///   - `pfp-view/`: the same thing for the viewer's full-resolution upgrade. The
///     sidecar keeps one file there at a time and deletes it as soon as the viewer
///     moves on, so anything left is a crash orphan and is emptied wholesale. This
///     is also the ONLY folder the webview's asset protocol is scoped to, so leaving
///     stale plaintext there would keep it readable as well as on disk.
///   - `pfp-frame/`: the pictures Windows produced for the videos in an upload. The
///     sidecar deletes each as it is spent, including for a file that turned out to
///     be a duplicate and one the upload never reached, so anything here outlived a
///     crash or a kill mid-upload.
///   - `pfp-uninstall-old-*.exe`: the ~57 MB uninstaller copy an uninstall moves out
///     of the install folder before deleting it.
///   - `pfp-cleanup-*.ps1`: the detached post-uninstall cleanup script.
///
/// The last two are supposed to remove themselves once the uninstall finishes, but
/// a script cannot reliably delete the file PowerShell is executing, so in practice
/// they pile up (228 MB of stale uninstallers on the author's machine). Sweeping at
/// startup does not depend on that working. Safe by timing: an uninstall kills this
/// app, so nothing is mid-uninstall while we are booting.
#[cfg(windows)]
pub fn reap_temp_leftovers() {
    // The staging folders, emptied whole: nothing else puts a file in them.
    let _ = std::fs::remove_dir_all(std::env::temp_dir().join("pfp-view"));
    let _ = std::fs::remove_dir_all(std::env::temp_dir().join(crate::upload_frame::FRAME_DIR));
    // Copies of files in the Explorer folder made to upload from: the originals stay in
    // the folder, so a copy an earlier run left behind is only a stray.
    let _ = std::fs::remove_dir_all(std::env::temp_dir().join("pfp-drop"));

    // %TEMP% can hold tens of thousands of entries, so it is scanned off the startup path.
    // A hydration of this run may already be staging there, so only older files go.
    let started = std::time::SystemTime::now();
    std::thread::spawn(move || {
        let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let ours = is_hydrate_leftover(&name)
                || (name.starts_with("pfp-uninstall-old-") && name.ends_with(".exe"))
                || (name.starts_with("pfp-cleanup-") && name.ends_with(".ps1"));
            let stale = entry
                .metadata()
                .and_then(|m| m.modified())
                .is_ok_and(|modified| modified < started);
            if ours && stale {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    });
}

/// Linux sweeps only the first kind above: the downloads the sidecar stages in the temp folder
/// (the video editor's go to its own staging folder, swept with it). Each is plaintext a crash
/// left behind.
#[cfg(not(windows))]
pub fn reap_temp_leftovers() {
    sweep_hydrate_leftovers(&std::env::temp_dir());
}

/// A decrypted download the sidecar staged: `pfp-hyd-<id>.bin`.
fn is_hydrate_leftover(name: &str) -> bool {
    name.starts_with("pfp-hyd-") && name.ends_with(".bin")
}

/// Deletes the staged downloads in `dir`, and nothing else there.
#[cfg_attr(windows, allow(dead_code))]
fn sweep_hydrate_leftovers(dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let is_file = entry.file_type().is_ok_and(|t| t.is_file());
        if is_file && is_hydrate_leftover(&entry.file_name().to_string_lossy()) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod leftover_tests {
    #[test]
    fn only_staged_downloads_are_swept() {
        let dir = std::env::temp_dir().join(format!("pfp-hyd-sweep-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("pfp-hyd-folder.bin")).unwrap();
        for name in ["pfp-hyd-0b9c.bin", "pfp-hyd-1.bin", "pfp-hyd-2.txt", "photo.bin", "pfp-view.bin"] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        super::sweep_hydrate_leftovers(&dir);
        let mut left: Vec<String> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        left.sort();
        assert_eq!(left, vec!["pfp-hyd-2.txt", "pfp-hyd-folder.bin", "pfp-view.bin", "photo.bin"]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(windows)]
fn try_register_sync_root(app: &tauri::AppHandle) -> Result<(), String> {
    use cloud_filter::root::{is_supported, SecurityId, SyncRootIdBuilder};

    let folder = sync_root_path();
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;

    if !is_supported().map_err(|e| format!("{e:?}"))? {
        return Err("Cloud Files API unavailable on this Windows build".into());
    }

    let id = SyncRootIdBuilder::new("ProtonPhotos") // stable provider id, no '!'
        .user_security_id(SecurityId::current_user().map_err(|e| format!("{e:?}"))?)
        .build();

    // Re-register ONCE when the registration policy changes (bump POLICY_VERSION), so
    // a registration made by an older build with an incorrect policy is refreshed.
    // Otherwise skip — the registration persists in HKCU across reboots.
    //
    // 4: the registration stores the nav-pane icon as an absolute path to the app's
    // executable, which was renamed. Nothing else re-reads that value, so without a
    // bump the entry keeps naming a file that no longer exists and the folder loses
    // its icon for good.
    //
    // 5: pinning is allowed, so Explorer shows "Always keep on this device" and "Free up
    // space" on the folder's photos and albums.
    const POLICY_VERSION: u32 = 5;
    let registered = id.is_registered().map_err(|e| format!("{e:?}"))?;
    // A registration of another place (a move that stopped half way) is no use for this one.
    let elsewhere = registered
        && crate::sync_location::own_registered_root()
            .is_some_and(|root| !crate::sync_location::same_place(&root, &folder));
    if registered && !elsewhere && policy_version() == POLICY_VERSION {
        return Ok(());
    }
    if registered {
        if !elsewhere {
            // The unregister turns this folder's downloaded copies into plain files, which are
            // the photos' own copies, not files put there to upload.
            crate::explorer_sync::note_seen(app, &downloaded_copies_under(&folder));
        }
        let _ = id.unregister(); // stale policy or place -> refresh with the current ones
    }

    // Point the nav-pane icon at the app executable's embedded icon (index 0).
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe = exe.to_string_lossy();
    let icon = exe.strip_prefix(r"\\?\").unwrap_or(&exe);

    register_with_insync_policy(&id, &folder, &format!("{icon},0")).map_err(|e| format!("{e:?}"))?;
    set_policy_version(POLICY_VERSION);
    Ok(())
}

/// The folder-relative paths of the downloaded placeholders in a folder, at any depth. Only a
/// file holding its data is opened, for its placeholder record: a directory listing does not
/// always show a placeholder's reparse point (before the engine connects it did not).
#[cfg(windows)]
fn downloaded_copies_under(root: &std::path::Path) -> Vec<String> {
    use std::os::windows::fs::MetadataExt;
    const RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                stack.push(entry.path());
            } else if meta.is_file()
                && meta.file_attributes() & RECALL_ON_DATA_ACCESS == 0
                && identity::read(&entry.path()).is_some()
            {
                if let Some(rel) = crate::explorer_sync::relative(root, &entry.path()) {
                    out.push(rel);
                }
            }
        }
    }
    out
}

/// Register the sync root directly through cloud-filter's own `windows` (0.58) so we
/// can set `InSyncPolicy = PreserveInsyncForSyncEngine` — the one policy that keeps a
/// download-only provider's files in-sync through hydration, which is what lets
/// Explorer "Free up space" work (a not-in-sync placeholder is never dehydrated, so
/// the NOTIFY_DEHYDRATE callback is not even reached). The crate's typed builder
/// cannot express this flag. Everything else matches what the crate would set.
#[cfg(windows)]
fn register_with_insync_policy(
    id: &cloud_filter::root::SyncRootId,
    folder: &std::path::Path,
    icon: &str,
) -> windows058::core::Result<()> {
    use windows058::core::HSTRING;
    use windows058::Security::Cryptography::{BinaryStringEncoding, CryptographicBuffer};
    use windows058::Storage::Provider::{
        StorageProviderHydrationPolicy, StorageProviderInSyncPolicy, StorageProviderPopulationPolicy,
        StorageProviderProtectionMode, StorageProviderSyncRootInfo, StorageProviderSyncRootManager,
    };
    use windows058::Storage::StorageFolder;

    let path_h = HSTRING::from(folder.to_string_lossy().as_ref());
    let storage_folder = StorageFolder::GetFolderFromPathAsync(&path_h)?.get()?;

    let info = StorageProviderSyncRootInfo::new()?;
    info.SetId(id.as_hstring())?;
    info.SetPath(&storage_folder)?;
    info.SetDisplayNameResource(&HSTRING::from("Proton Photos"))?;
    info.SetIconResource(&HSTRING::from(icon))?;
    info.SetHydrationPolicy(StorageProviderHydrationPolicy::Full)?;
    info.SetPopulationPolicy(StorageProviderPopulationPolicy::AlwaysFull)?;
    info.SetInSyncPolicy(StorageProviderInSyncPolicy::PreserveInsyncForSyncEngine)?;
    // Explorer's "Always keep on this device" and "Free up space" only mark a file pinned
    // or unpinned; the folder's watcher sees the mark and downloads or frees the copy
    // through the app's own Download and Free up (`apply_pin_marks`), so no file is left
    // waiting on Windows to act.
    info.SetAllowPinning(true)?;
    info.SetShowSiblingsAsGroup(false)?;
    info.SetProtectionMode(StorageProviderProtectionMode::Unknown)?;
    info.SetVersion(&HSTRING::from("1.0.0"))?;
    let ctx = CryptographicBuffer::ConvertStringToBinary(id.as_hstring(), BinaryStringEncoding::Utf8)?;
    info.SetContext(&ctx)?;
    StorageProviderSyncRootManager::Register(&info)?;
    Ok(())
}

/// The registration-policy version last written, so we re-register only when it changes.
#[cfg(windows)]
fn policy_version() -> u32 {
    winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
        .open_subkey(PREF_KEY)
        .and_then(|k| k.get_value::<u32, _>("RegPolicyVersion"))
        .unwrap_or(0)
}
#[cfg(windows)]
fn set_policy_version(v: u32) {
    if let Ok((key, _)) =
        winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER).create_subkey(PREF_KEY)
    {
        let _ = key.set_value("RegPolicyVersion", &v);
    }
}

/// Remove the Explorer "Proton Photos" sync-root registration (nav-pane entry).
/// Called at startup when the preference is off, so opting out actually takes it
/// out of Explorer instead of only skipping the mount (the registration persists
/// in HKCU, so it would otherwise linger).
#[cfg(windows)]
pub fn unmount(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        use cloud_filter::root::{SecurityId, SyncRootIdBuilder};
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        }
        let Ok(sid) = SecurityId::current_user() else {
            return;
        };
        let id = SyncRootIdBuilder::new("ProtonPhotos").user_security_id(sid).build();
        if id.is_registered().unwrap_or(false) {
            let _life = crate::sync_location::lifecycle();
            let registered = crate::sync_location::own_registered_root();
            match id.unregister() {
                Ok(()) => {
                    crate::note(&app, "[cloud] unmounted (opt-out)");
                    remove_left_folders(&app, registered.as_deref());
                }
                Err(e) => crate::note(&app, &format!("[cloud] unmount failed: {e:?}")),
            }
        }
    });
}

/// After the registration is gone: the fill's folders it left empty go, in the folder that
/// was registered and only when that is the folder the app uses now and its drive is there.
/// Asked twice, a little apart, in case Windows is still taking placeholders away the first
/// time.
#[cfg(windows)]
fn remove_left_folders(app: &tauri::AppHandle, registered: Option<&std::path::Path>) {
    let root = sync_root_path();
    let ours = registered.is_some_and(|r| crate::sync_location::same_place(r, &root));
    if !ours || !sync_root_available() {
        crate::note(app, "[cloud] left the folders as they are (not the folder in use)");
        return;
    }
    let mut removed = empty_folders::remove_empty_app_folders(&root);
    std::thread::sleep(std::time::Duration::from_secs(5));
    removed.extend(empty_folders::remove_empty_app_folders(&root));
    crate::note(app, &format!("[cloud] opt-out: {}", empty_folders::summary(&removed)));
}

#[cfg(not(windows))]
pub fn mount(_app: tauri::AppHandle) {}
#[cfg(not(windows))]
pub fn unmount(_app: tauri::AppHandle) {}

/// Mark one path as "in sync" so Explorer shows it as available (a green check)
/// rather than "waiting for sync". In a sync root a plain new entry reads as a
/// pending upload; converting it to an in-sync placeholder (data kept, NOT
/// dehydrated) fixes the status without touching the bytes. Used by
/// `mark_folders_in_sync` to settle our own subfolders.
#[cfg(windows)]
fn mark_one_in_sync(path: &std::path::Path) -> Result<(), String> {
    use cloud_filter::placeholder::{ConvertOptions, OpenOptions};
    let mut placeholder = OpenOptions::new()
        .write_access()
        .open(path)
        .map_err(|e| format!("{e:?}"))?;
    placeholder
        .convert_to_placeholder(ConvertOptions::default().mark_in_sync(), None)
        .map_err(|e| format!("{e:?}"))?;
    Ok(())
}

// ---- Cloud photos as files-on-demand placeholders (the "green cloud") ----

/// Windows FILETIME (100ns ticks since 1601) from unix milliseconds.
#[cfg(windows)]
fn unix_ms_to_filetime(ms: i64) -> i64 {
    if ms <= 0 {
        return 0;
    }
    (ms + 11_644_473_600_000) * 10_000
}

/// Make a photo name safe as a file name (strip path separators / illegal chars).
#[cfg(windows)]
fn sanitize_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if "\\/:*?\"<>|".contains(c) || (c as u32) < 32 {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim().to_string();
    if trimmed.is_empty() {
        "photo".to_string()
    } else if is_reserved_device_name(&trimmed) {
        // `NUL.jpg` or `COM1` names a device, not a file, in any Windows folder.
        format!("_{trimmed}")
    } else {
        trimmed
    }
}

/// CON, PRN, AUX, NUL, COM1-9 and LPT1-9, with or without an extension, in any case.
#[cfg(windows)]
fn is_reserved_device_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
}

/// uid -> the placeholder paths (relative to the sync root) that stand for it,
/// filled during populate. A photo has one entry under `Photos\` and one more per
/// album it belongs to, so the app's Download / Free up can act on every copy.
#[cfg(windows)]
static MOUNT_INDEX: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, Vec<String>>>,
> = std::sync::OnceLock::new();

#[cfg(windows)]
fn mount_index() -> &'static std::sync::Mutex<std::collections::HashMap<String, Vec<String>>> {
    MOUNT_INDEX.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// The index and sizes a fill is building, uid to paths and uid to size. They are put in place
/// whole when the fill has placed everything (`publish_index`), so whatever reads the index
/// meanwhile (Free up, Download, the watcher) sees the previous fill's, never a part of this
/// one's; a fill that fails part way leaves the previous one in place.
#[cfg(windows)]
type IndexBuild = (std::collections::HashMap<String, Vec<String>>, std::collections::HashMap<String, u64>);

#[cfg(windows)]
static NEXT_INDEX: std::sync::Mutex<Option<IndexBuild>> = std::sync::Mutex::new(None);

#[cfg(windows)]
fn begin_index() {
    *NEXT_INDEX.lock().unwrap_or_else(|p| p.into_inner()) = Some(Default::default());
}

/// Puts the index the fill built in place of the one before, in one step.
#[cfg(windows)]
fn publish_index() {
    let Some((index, sizes)) = NEXT_INDEX.lock().unwrap_or_else(|p| p.into_inner()).take() else {
        return;
    };
    *mount_sizes().lock().unwrap() = sizes;
    *mount_index().lock().unwrap() = index;
}

/// Record one placeholder path (relative to the sync root) for a photo, in the index the fill
/// is building. The first path recorded is its primary (`Photos\`) copy, the one Download
/// hydrates.
///
/// Only ever called for a path this process created or adopted, never for one that
/// merely bears the right name. Everything that acts on a photo acts through this
/// index, including free-up, which discards local data. A photo whose `Photos\` copy
/// could not be created or adopted therefore has an album copy first, or no entry at
/// all, which is what leaves the colliding file untouched.
#[cfg(windows)]
fn index_push(uid: &str, rel: &str) {
    if let Some((index, _)) = NEXT_INDEX.lock().unwrap_or_else(|p| p.into_inner()).as_mut() {
        index.entry(uid.to_string()).or_default().push(rel.to_string());
    }
}

/// The cloud file's size for a photo, in the index the fill is building.
#[cfg(windows)]
fn size_push(uid: &str, size: u64) {
    if let Some((_, sizes)) = NEXT_INDEX.lock().unwrap_or_else(|p| p.into_inner()).as_mut() {
        sizes.insert(uid.to_string(), size);
    }
}

/// uid -> the size the cloud file has, as the last populate listed it. Recorded for
/// every photo in the listing, and read by exactly one caller: the free-up fallback
/// that discards a file's bytes, which has to establish first that the file still
/// holds what the cloud holds.
#[cfg(windows)]
static MOUNT_SIZES: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, u64>>,
> = std::sync::OnceLock::new();

#[cfg(windows)]
fn mount_sizes() -> &'static std::sync::Mutex<std::collections::HashMap<String, u64>> {
    MOUNT_SIZES.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

#[cfg(windows)]
fn cloud_size(uid: &str) -> Option<u64> {
    mount_sizes().lock().unwrap().get(uid).copied()
}

/// Keep one file on the device as a placeholder of this photo, whatever state it is in. A
/// cloud placeholder carrying this photo's uid is hydrated in place (its data downloaded; the
/// download marks it in sync once its bytes check out). A plain file that has lost its
/// placeholder status (e.g. after a provider disconnect across app restarts) is converted to a
/// placeholder with its data preserved and its uid restored, so a later Free up can find it;
/// it stays out of sync until Free up has compared its bytes with the cloud file's.
/// Returns whether it ended up local.
#[cfg(windows)]
fn keep_offline_one(
    app: &tauri::AppHandle,
    base: &std::path::Path,
    rel: &str,
    uid: Option<&str>,
) -> bool {
    use cloud_filter::placeholder::OpenOptions;
    let path = base.join(rel);
    // Read without opening it for its data: a placeholder of another photo under this name
    // would download that photo.
    if let Some(info) = identity::read(&path) {
        if !uid.is_some_and(|uid| info.is(uid)) {
            crate::note(app, "[keep] the file at this name is another photo's, left alone");
            return false;
        }
        // The oplock handle is dropped at the end of this block.
        return match OpenOptions::new().write_access().open(&path) {
            Ok(mut ph) => ph.hydrate(..).is_ok(),
            Err(_) => false,
        };
    }
    if file_attribute_data(&path).is_none() {
        return false;
    }
    match convert_file_to_placeholder(&path, uid.unwrap_or("")) {
        Ok(()) => {
            if let (Some(uid), Some(entry)) = (uid, file_attribute_data(&path)) {
                verify::want(app, &path, uid, stamp_of(&entry));
            }
            true
        }
        Err(e) => {
            // No file name / uid in the log — just the outcome and the OS error.
            crate::note(app, &format!("[keep] convert failed: {e}"));
            false
        }
    }
}

/// What the file already sitting at one of our names turned out to be.
///
/// Two questions get asked of that file and they are not the same one. "Did this
/// pass have to fix anything?" only feeds a log count. "Does this path belong to
/// the mount?" decides whether the index may list it, and everything that acts on
/// a photo acts through the index, including free-up, which discards local data.
/// Collapsing the two is what left the index empty on every populate after the
/// first: a cloud-only placeholder needs no work, which is not the same as it not
/// being ours, and unindexed it could not be downloaded or freed up at all.
#[cfg(windows)]
#[derive(PartialEq)]
enum Existing {
    /// Ours, and this pass fixed it up (given this photo's identity, or converted back).
    Adopted,
    /// Ours, and there was nothing to do.
    Ours,
    /// Someone else's file that merely shares the name. Never indexed.
    Foreign,
}

/// Bring a file already sitting at one of the fill's names into the sync engine, as this
/// photo's, or say it is not.
///
/// `PlaceholderFile::create` fails on a name collision, so every fill after the first meets
/// its own placeholders here, and after a reinstall the downloaded copies left as plain files.
/// The index the fill builds names a path for this photo only when the file there carries this
/// photo's uid, because the uid is what the file opens, and everything else (delete, rename,
/// move, free up) acts through the index. Same-named photos are named `IMG.jpg`, `IMG (2).jpg`
/// in listing order, so the photo at a name can change between fills.
#[cfg(windows)]
fn reconcile_existing(
    app: &tauri::AppHandle,
    path: &std::path::Path,
    uid: &str,
    size: u64,
    filetime: i64,
) -> Existing {
    const RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;
    // Decide from the directory entry and the placeholder's own record, both read without
    // opening the file for its data: to the Cloud Filter driver any other open of a cloud-only
    // placeholder is a data access, and asking it "are you alright?" would download it. Every
    // fill after the first asks this of the whole library.
    let Some(entry) = file_attribute_data(path) else {
        return Existing::Foreign; // unreadable: nothing may act on it
    };
    let placeholder = identity::read(path);
    if entry.dwFileAttributes & RECALL_ON_DATA_ACCESS != 0 {
        // Cloud-only: no bytes here, so whichever photo it stood for, nothing is lost by making
        // it stand for this one. It is retargeted rather than adopted as it is, or the name
        // would lead to this photo while the file opens another.
        return match placeholder {
            Some(info) if info.is(uid) => Existing::Ours,
            Some(_) => match identity::retarget_cloud_only(path, uid, size, filetime) {
                Ok(()) => Existing::Adopted,
                Err(e) => {
                    crate::note(app, &format!("[reconcile] retarget failed: {e}"));
                    Existing::Foreign
                }
            },
            None => Existing::Foreign,
        };
    }
    if let Some(info) = placeholder {
        // One of ours holding data: this photo's only if it carries this photo's uid. Another
        // photo's copy under a name this one now takes keeps its bytes and its own identity,
        // and stays out of the index under this photo. Its in-sync state is left as the driver
        // keeps it: only a check of the bytes may set it, which an out-of-sync copy is handed
        // to (`verify`).
        if !info.is(uid) {
            return Existing::Foreign;
        }
        if !info.in_sync {
            verify::want(app, path, uid, stamp_of(&entry));
        }
        return Existing::Ours;
    }
    // A plain file holding data, sharing a name with one of the cloud photos. It is either our
    // own copy left behind by an earlier install, or a file the user put here that merely
    // collides: camera names repeat constantly, which is the whole reason `unique_name` exists.
    // A size other than the cloud file's is not that copy, and is left completely alone. One of
    // the same size gets this photo's uid but stays out of sync, the same size being no proof of
    // the same bytes: an edit of the date in place keeps the size. It is marked in sync once its
    // SHA-1 is shown to be the cloud revision's (`verify`), and nothing frees it before its
    // bytes have been checked (`free_up_one`).
    let on_disk = ((entry.nFileSizeHigh as u64) << 32) | entry.nFileSizeLow as u64;
    if on_disk != size {
        return Existing::Foreign;
    }
    match convert_file_to_placeholder(path, uid) {
        Ok(()) => {
            if let Some(entry) = file_attribute_data(path) {
                verify::want(app, path, uid, stamp_of(&entry));
            }
            Existing::Adopted
        }
        Err(e) => {
            // No file name / uid in the log — just the outcome and the OS error.
            // Without the uid attached nothing could act on it correctly anyway,
            // so it stays out of the index.
            crate::note(app, &format!("[reconcile] convert failed: {e}"));
            Existing::Foreign
        }
    }
}

// ---- The mount's own uid lists ----
//
// Two of them: the snapshot of what the library held at the last populate, and the
// albums the user asked to keep on this device. Both are sealed with the app's data
// key now, like everything else in that directory. A node uid names one photo in the
// account, so a plain list of them was a readable index of the library sitting among
// caches that are all encrypted, next to a thumbnail store that is content-addressed
// precisely so no uid ever appears in a file name.
//
// Sealed rather than hashed, even though set membership is all the "seen" snapshot
// ever needs: the album list is read back OUT again (`synced_albums` hands it to the
// Albums view, and populate looks each uid up in ALBUM_INDEX), so a one-way digest
// cannot serve it. One mechanism for both is simpler than two, and it reuses a key
// the app already manages.

/// The library snapshot from the previous populate, and the albums kept offline.
///
/// Both keep the names they have always had, and only their contents change. The
/// sidecar deletes these two paths BY NAME when the account signs out, so that one
/// account's uid list can never greet the next one signing in on this machine.
/// Renaming them here would leave that sweep deleting files nobody writes any more,
/// and the stale snapshot would then make every photo in the next account look new
/// to the auto-download pass.
#[cfg(windows)]
const SEEN_LIST: &str = "mount_seen.txt";
#[cfg(windows)]
const ALBUM_LIST: &str = "synced_albums.txt";

/// Read one list, taking over the plain one an older build wrote to the same path.
///
/// A sealed blob only ever comes back through `read_sealed`, which authenticates it,
/// so the fallback cannot be reached by an unreadable or tampered one being mistaken
/// for text. What it will accept as a legacy list is checked for shape first, and
/// anything else is reported as no list at all, which every caller reads as "nothing
/// recorded yet". That is the safe answer in both directions: guessing wrong the
/// other way would hand the auto-download pass a baseline of nonsense, and every
/// photo in the account would look like a new arrival to be pulled down.
#[cfg(windows)]
fn load_uid_list(app: &tauri::AppHandle, file: &str) -> Option<String> {
    if let Ok(Some(text)) = crate::secure_store::read_sealed(app, file) {
        return Some(text);
    }
    let path = crate::secure_store::app_dir(app).ok()?.join(file);
    let text = std::fs::read_to_string(path).ok()?;
    if !looks_like_uid_list(&text) {
        return None;
    }
    // Sealed in place, at the same path. Left alone if that fails, so a list is
    // never lost to a write that did not happen.
    save_uid_list(app, file, &text);
    Some(text)
}

/// Whether a file's contents can be one of these lists: uids, and nothing else. The
/// character set is what a node uid is made of, base64url with its padding and the
/// separator between the two halves.
#[cfg(windows)]
fn looks_like_uid_list(text: &str) -> bool {
    text.lines().all(|line| {
        line.trim()
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "+/_-=~.".contains(c))
    })
}

#[cfg(windows)]
fn save_uid_list(app: &tauri::AppHandle, file: &str, text: &str) {
    let _ = crate::secure_store::write_sealed(app, file, text);
}

/// The uids present at the last populate, or None if there is no snapshot yet
/// (a first run, which only seeds the snapshot and downloads nothing).
#[cfg(windows)]
fn load_seen(app: &tauri::AppHandle) -> Option<std::collections::HashSet<String>> {
    let text = load_uid_list(app, SEEN_LIST)?;
    Some(text.lines().map(str::trim).filter(|l| !l.is_empty()).map(String::from).collect())
}

#[cfg(windows)]
fn save_seen(app: &tauri::AppHandle, uids: &[String]) {
    save_uid_list(app, SEEN_LIST, &uids.join("\n"));
}

/// Older builds created placeholders directly at the sync-root top level; this
/// build groups them under `Photos\` and `Albums\`. Remove the stale loose
/// placeholders so the folder is not left with a duplicate beside the new layout.
/// Only dehydrated (cloud-only) top-level files are touched — never a subfolder
/// and never a file the user kept offline.
#[cfg(windows)]
fn cleanup_stale_root(folder: &std::path::Path) {
    use std::os::windows::fs::MetadataExt;
    const RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;
    let Ok(entries) = std::fs::read_dir(folder) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            if let Ok(meta) = entry.metadata() {
                if meta.file_attributes() & RECALL_ON_DATA_ACCESS != 0 {
                    crate::explorer_sync::expect_own(&entry.file_name().to_string_lossy());
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }
}

/// How many heavy sidecar operations (populate, per-file hydration, album sync) are
/// in flight right now. The mount is "busy" whenever this is above zero.
///
/// A depth counter, not a bool, because these operations nest: `pin_selected` and the
/// populate passes hold it while their inner `fetch_data` hydrations take it again
/// (`ph.hydrate` inside `keep_offline_one` drives the sync engine's `fetch_data` on a
/// separate thread). A bare bool's inner release would clear the busy state while the
/// outer work is still running, letting the thumbnail warmer pile back on too early.
/// With the counter, only the outermost pair flips the state.
#[cfg(windows)]
static BUSY_DEPTH: std::sync::Mutex<i32> = std::sync::Mutex::new(0);

/// Tell the UI the mount is doing heavy sidecar work (populate / hydration), so the
/// background thumbnail warmer pauses and lets that work own the single sidecar RPC
/// channel. Paired true/false around each heavy operation (see `BusyGuard`); only the
/// outermost pair actually flips the state, so nested operations never clear it early.
#[cfg(windows)]
fn set_busy(app: &tauri::AppHandle, busy: bool) {
    use tauri::Emitter;
    let mut depth = BUSY_DEPTH.lock().unwrap();
    let was_busy = *depth > 0;
    if busy {
        *depth += 1;
    } else if *depth > 0 {
        *depth -= 1;
    }
    let now_busy = *depth > 0;
    // Emit only on the real idle<->busy transition, and while still holding the lock,
    // so the warmer's pause/resume events can never arrive out of order with the depth
    // changes that caused them.
    if now_busy != was_busy {
        let _ = app.emit("mount-busy", now_busy);
    }
}

/// RAII pairing for `set_busy`: marks the mount busy while alive and clears that mark
/// on drop, so every exit path (an early `?`, an error return, a panic) still releases
/// it. Essential in `fetch_data`, which has several early returns where a bare
/// `set_busy(false)` at the end would be skipped.
#[cfg(windows)]
struct BusyGuard {
    app: tauri::AppHandle,
}

#[cfg(windows)]
impl BusyGuard {
    fn new(app: &tauri::AppHandle) -> Self {
        set_busy(app, true);
        BusyGuard { app: app.clone() }
    }
}

#[cfg(windows)]
impl Drop for BusyGuard {
    fn drop(&mut self) {
        set_busy(&self.app, false);
    }
}

/// What the folder is busy with, for the app to say instead of a bare "Syncing": the
/// fill that keeps the folder matching the library, a file something opened, or
/// photos kept on this device. `done` of `total` while there is a count to give. On
/// Linux the file-manager drive reports through the same, so the window says it once.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MountActivity {
    what: &'static str,
    name: Option<String>,
    by: Option<String>,
    done: u64,
    total: u64,
    /// Which part of a fill runs: the photos (none named), then "albums", then "tidy".
    phase: Option<&'static str>,
}

static ACTIVITY: std::sync::Mutex<Option<MountActivity>> = std::sync::Mutex::new(None);

#[cfg_attr(target_os = "macos", allow(dead_code))]
fn show_activity(app: &tauri::AppHandle, now: Option<MountActivity>) {
    use tauri::Emitter;
    let mut cur = ACTIVITY.lock().unwrap();
    *cur = now;
    let _ = app.emit("mount-activity", cur.clone());
}

/// Names the outermost piece of work while it runs: one nested inside it (a download
/// a fill set off) leaves the outer name standing, and only its owner clears it.
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub(crate) struct Doing {
    app: tauri::AppHandle,
    owns: bool,
}

#[cfg_attr(target_os = "macos", allow(dead_code))]
impl Doing {
    pub(crate) fn new(app: &tauri::AppHandle, what: &'static str, name: Option<String>, by: Option<String>) -> Self {
        let owns = ACTIVITY.lock().unwrap().is_none();
        if owns {
            show_activity(app, Some(MountActivity { what, name, by, done: 0, total: 0, phase: None }));
        }
        Doing { app: app.clone(), owns }
    }
}

impl Drop for Doing {
    fn drop(&mut self) {
        if self.owns {
            show_activity(&self.app, None);
        }
    }
}

/// The fill's count of photos placed, shown only while a fill is what the folder is doing.
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub(crate) fn fill_progress(app: &tauri::AppHandle, done: u64, total: u64) {
    fill_phase(app, None, done, total);
}

/// The part of the fill that runs now and how far it has got, so the window never shows
/// the photos' last count standing while the albums and the tidying still run.
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub(crate) fn fill_phase(app: &tauri::AppHandle, phase: Option<&'static str>, done: u64, total: u64) {
    let next = match ACTIVITY.lock().unwrap().clone() {
        Some(a) if a.what == "fill" => Some(MountActivity { done, total, phase, ..a }),
        _ => return,
    };
    show_activity(app, next);
}

/// Whether this run has started its first fill, and when a fill last finished.
#[cfg(windows)]
static FILL_STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
#[cfg(windows)]
static LAST_FILL: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);
/// How long a finished fill stands before a page load may check the folder again.
#[cfg(windows)]
const REFILL_AFTER: std::time::Duration = std::time::Duration::from_secs(15 * 60);

#[cfg(windows)]
fn filled() {
    *LAST_FILL.lock().unwrap() = Some(std::time::Instant::now());
}

/// Whether a page load fills the folder now, and whether it is this run's first fill
/// (the one worth showing). After the first, a finished fill stands for REFILL_AFTER.
#[cfg(windows)]
fn claim_page_fill() -> Option<bool> {
    let first = !FILL_STARTED.swap(true, std::sync::atomic::Ordering::SeqCst);
    if !first && !LAST_FILL.lock().unwrap().is_some_and(|at| at.elapsed() >= REFILL_AFTER) {
        return None;
    }
    Some(first)
}

/// Forgets the fills of the account that signed out, so the next sign-in fills the
/// emptied folder on its first page load instead of up to REFILL_AFTER later.
#[cfg(windows)]
fn forget_fills() {
    FILL_STARTED.store(false, std::sync::atomic::Ordering::SeqCst);
    *LAST_FILL.lock().unwrap() = None;
}

/// What the folder is busy with right now, for a window that opens while it already is.
#[tauri::command]
pub fn mount_activity() -> Option<MountActivity> {
    ACTIVITY.lock().unwrap().clone()
}

/// The current sync state, for the tray popup's status line (live updates arrive via
/// the "mount-busy" event; this is the value to show when the popup first opens).
#[tauri::command]
pub fn sync_busy() -> bool {
    #[cfg(windows)]
    {
        *BUSY_DEPTH.lock().unwrap() > 0
    }
    #[cfg(not(windows))]
    false
}

/// A path's directory entry — attributes and size — WITHOUT opening it. `None` if
/// the path is unreadable.
///
/// Never use `std::fs::metadata` on anything inside the sync root. It opens the
/// file to stat it, and to the Cloud Filter driver an open that is not flagged
/// no-recall is a data access: merely asking "is this file downloaded?" downloads
/// it. That is not theoretical. It is what made the app pull the entire library
/// on its own: the 4-second `hydrated_uids` poll stat-ed every placeholder, so
/// hydration began the moment populate filled the index and never stopped.
/// `GetFileAttributesExW` reads the directory entry instead and never touches the
/// file's data, so it cannot trigger a recall.
#[cfg(windows)]
fn file_attribute_data(
    path: &std::path::Path,
) -> Option<windows::Win32::Storage::FileSystem::WIN32_FILE_ATTRIBUTE_DATA> {
    use windows::core::HSTRING;
    use windows::Win32::Storage::FileSystem::{
        GetFileAttributesExW, GetFileExInfoStandard, WIN32_FILE_ATTRIBUTE_DATA,
    };
    let mut data = WIN32_FILE_ATTRIBUTE_DATA::default();
    let wide = HSTRING::from(path.as_os_str());
    unsafe {
        GetFileAttributesExW(
            &wide,
            GetFileExInfoStandard,
            &mut data as *mut _ as *mut core::ffi::c_void,
        )
    }
    .ok()?;
    Some(data)
}

/// A file's size and last write time from its directory entry, which tell the checker in
/// `verify` whether a copy changed since it was last looked at.
#[cfg(windows)]
fn stamp_of(entry: &windows::Win32::Storage::FileSystem::WIN32_FILE_ATTRIBUTE_DATA) -> verify::Stamp {
    let size = ((entry.nFileSizeHigh as u64) << 32) | entry.nFileSizeLow as u64;
    let written = ((entry.ftLastWriteTime.dwHighDateTime as i64) << 32) | entry.ftLastWriteTime.dwLowDateTime as i64;
    (size, written)
}

/// A path's attributes, read from its directory entry. See `file_attribute_data` for
/// why this never goes through `std::fs::metadata`.
#[cfg(windows)]
fn file_attributes(path: &std::path::Path) -> Option<u32> {
    file_attribute_data(path).map(|d| d.dwFileAttributes)
}

/// Keep the photos out of the Windows Search index's content extraction.
///
/// The whole of `%USERPROFILE%` is the indexer's default crawl scope, and a
/// downloaded photo here is an ordinary JPEG, so the photo property handler runs
/// over it and lifts its EXIF into the index in plaintext, GPS coordinates and all.
/// That outlives the photo: freeing the space back up does not remove what the
/// index already extracted, so a single open would leave a permanent trace of where
/// the picture was taken.
///
/// `FILE_ATTRIBUTE_NOT_CONTENT_INDEXED` stops the filter and property handlers from
/// running at all. The name, size and dates stay indexed, but those are on the
/// placeholder for anyone to read anyway; the EXIF is not. Setting it also purges
/// whatever the index already holds for the file.
///
/// A folder passes this to files created inside it LATER, but not to ones already
/// there, so placeholders are marked individually as well. Cheap and idempotent:
/// one directory-entry read, and a write only when the bit is actually missing.
#[cfg(windows)]
fn mark_not_indexed(path: &std::path::Path) {
    use windows::core::HSTRING;
    use windows::Win32::Storage::FileSystem::{SetFileAttributesW, FILE_FLAGS_AND_ATTRIBUTES};
    const NOT_CONTENT_INDEXED: u32 = 0x0000_2000;
    let Some(current) = file_attributes(path) else {
        return;
    };
    if current & NOT_CONTENT_INDEXED != 0 {
        return;
    }
    let wide = HSTRING::from(path.as_os_str());
    let _ = unsafe {
        SetFileAttributesW(&wide, FILE_FLAGS_AND_ATTRIBUTES(current | NOT_CONTENT_INDEXED))
    };
}

/// Whether one placeholder (relative path from the sync root) is hydrated (has its
/// data on the device). Dehydrated cloud-only placeholders carry RECALL_ON_DATA_ACCESS.
#[cfg(windows)]
fn is_hydrated(base: &std::path::Path, rel: &str) -> bool {
    const RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;
    file_attributes(&base.join(rel))
        .map(|a| a & RECALL_ON_DATA_ACCESS == 0)
        .unwrap_or(false)
}

/// The bytes one placeholder holds on the device, or `None` if it is cloud-only. A
/// dehydrated placeholder still reports the full size of the file it stands for, so
/// the size alone says nothing about local storage — the recall flag is what
/// separates "on this device" from "in the cloud". One directory-entry read serves
/// both, and neither can trigger a recall.
#[cfg(windows)]
fn hydrated_size(base: &std::path::Path, rel: &str) -> Option<u64> {
    const RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;
    let data = file_attribute_data(&base.join(rel))?;
    if data.dwFileAttributes & RECALL_ON_DATA_ACCESS != 0 {
        return None;
    }
    Some(((data.nFileSizeHigh as u64) << 32) | data.nFileSizeLow as u64)
}

/// Convert a plain file (one that lost its placeholder status, e.g. after the sync
/// provider was disconnected across app restarts, which strands it "waiting to sync"
/// and un-freeable) back into a Cloud Filter placeholder. `CfConvertToPlaceholder`
/// needs a real Win32 file handle; the cloud-filter crate only exposes convert through
/// its oplock handle, which the API rejects with ERROR_INVALID_HANDLE, so we call it
/// directly on a `CreateFile`/std handle. The data is kept, and the uid is stored as the
/// file identity so a later hydrate / free-up can find the cloud file.
#[cfg(windows)]
fn convert_file_to_placeholder(path: &std::path::Path, uid: &str) -> Result<(), String> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::CloudFilters::{CfConvertToPlaceholder, CF_CONVERT_FLAG_NONE};
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|e| format!("open: {e}"))?;
    let blob = uid.as_bytes();
    let (id_ptr, id_len) = if blob.is_empty() {
        (None, 0u32)
    } else {
        (Some(blob.as_ptr() as *const core::ffi::c_void), blob.len() as u32)
    };
    // Not marked in sync: a file that only has the cloud file's name and size is no proof of
    // its bytes, and a copy in sync may be freed, which throws its bytes away.
    unsafe {
        CfConvertToPlaceholder(HANDLE(file.as_raw_handle() as _), id_ptr, id_len, CF_CONVERT_FLAG_NONE, None, None)
    }
    .map_err(|e| format!("{e:?}"))
}

/// Convert our subfolders (`Photos\`, `Albums\`, each album) to in-sync placeholders.
/// A folder freshly created inside a sync root otherwise reads as "sync pending" in
/// Explorer's status column. Best-effort (cosmetic; a failure changes nothing else).
#[cfg(windows)]
fn mark_folders_in_sync(root: &std::path::Path) {
    let _ = mark_one_in_sync(&root.join("Photos"));
    let albums = root.join("Albums");
    if albums.is_dir() {
        let _ = mark_one_in_sync(&albums);
        if let Ok(entries) = std::fs::read_dir(&albums) {
            for e in entries.flatten() {
                if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    let _ = mark_one_in_sync(&e.path());
                }
            }
        }
    }
}

// ---- Selective per-album sync (keep a chosen album's photos on the device) ----

/// albumUid -> the album-folder placeholder paths (relative to the sync root) of its
/// photos, filled during populate so a "keep this album offline" toggle can hydrate
/// exactly the `Albums\<name>\` copies (so that Explorer folder fills, not just the
/// timeline copy).
#[cfg(windows)]
static ALBUM_INDEX: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, Vec<String>>>,
> = std::sync::OnceLock::new();

#[cfg(windows)]
fn album_index() -> &'static std::sync::Mutex<std::collections::HashMap<String, Vec<String>>> {
    ALBUM_INDEX.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// The album uids the user chose to keep offline (empty if none).
#[cfg(windows)]
fn load_synced_albums(app: &tauri::AppHandle) -> std::collections::HashSet<String> {
    load_uid_list(app, ALBUM_LIST)
        .map(|t| t.lines().map(str::trim).filter(|l| !l.is_empty()).map(String::from).collect())
        .unwrap_or_default()
}

#[cfg(windows)]
fn save_synced_albums(app: &tauri::AppHandle, set: &std::collections::HashSet<String>) {
    let list: Vec<&str> = set.iter().map(String::as_str).collect();
    save_uid_list(app, ALBUM_LIST, &list.join("\n"));
}

/// One album's own copies: the `Albums\<name>\` placeholder paths ALBUM_INDEX
/// recorded for it during populate.
///
/// This is the only thing that ever says which copies belong to an album, and it
/// says it in paths that populate itself created. A photo's `Photos\` copy and its
/// copy in any other album are different placeholders at different paths, so they
/// are not in here and cannot be caught by anything acting on this list. Nothing
/// is ever matched by name.
#[cfg(windows)]
fn album_copies(album_uid: &str) -> Vec<String> {
    album_index().lock().unwrap().get(album_uid).cloned().unwrap_or_default()
}

/// rel -> photo uid, so a copy that has lost its placeholder status can be
/// converted back with its blob.
#[cfg(windows)]
fn rel_to_uid() -> std::collections::HashMap<String, String> {
    let index = mount_index().lock().unwrap();
    let mut m = std::collections::HashMap::new();
    for (u, rs) in index.iter() {
        for r in rs {
            m.insert(r.clone(), u.clone());
        }
    }
    m
}

/// The album uids currently kept offline, for the Albums view toggles.
#[tauri::command]
pub fn synced_albums(app: tauri::AppHandle) -> Vec<String> {
    #[cfg(windows)]
    {
        load_synced_albums(&app).into_iter().collect()
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Vec::new()
    }
}

/// How many of one album's own copies are on this device, so the app can ask about
/// the storage only when there is some to reclaim. Attributes only, never a read:
/// stat-ing a placeholder by opening it would hydrate the very photos being counted.
#[tauri::command]
pub async fn album_local_count(uid: String) -> u32 {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            let base = sync_root_path();
            album_copies(&uid).iter().filter(|rel| is_hydrated(&base, rel)).count() as u32
        })
        .await
        .unwrap_or(0)
    }
    #[cfg(not(windows))]
    {
        let _ = uid;
        0
    }
}

/// Free up what one album downloaded, and nothing else.
///
/// Scoped entirely through ALBUM_INDEX, so only this album's own `Albums\<name>\`
/// copies are touched. A photo kept offline in its own right holds a separate
/// `Photos\` placeholder that is not in this list and survives untouched, and so
/// does its copy in every other album. Two photos sharing a name are two paths and
/// are never confused for each other. Returns how many copies are no longer on this
/// device. Off the main thread: a large album is a long pass.
#[tauri::command]
pub async fn free_up_album(app: tauri::AppHandle, uid: String) -> u32 {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            let base = sync_root_path();
            let rev = rel_to_uid();
            let mut freed = 0u32;
            let mut photos = Vec::new();
            for rel in album_copies(&uid) {
                // No uid means the copy is not in the mount's index, so there is no
                // blob to restore it with and it is not ours to touch.
                let Some(photo) = rev.get(&rel) else { continue };
                if free_up_one(&app, &base, photo, &rel) {
                    freed += 1;
                }
                photos.push(photo.clone());
            }
            crate::note(&app, &format!("[album-sync] freed {freed} album copies"));
            crate::keep_all::note_album_freed(&app, &photos);
            rescan_hydrated();
            freed
        })
        .await
        .unwrap_or(0)
    }
    #[cfg(not(windows))]
    {
        let _ = (app, uid);
        0
    }
}

/// Forgets an album an earlier build downloaded into the Explorer folder by itself. Albums are
/// kept offline inside the app now; this is what moving one over leaves behind, together with
/// `free_up_album` for what it had downloaded.
#[tauri::command]
pub fn set_album_synced(app: tauri::AppHandle, uid: String, enabled: bool) {
    #[cfg(windows)]
    {
        let mut set = load_synced_albums(&app);
        if enabled {
            set.insert(uid);
        } else {
            set.remove(&uid);
        }
        save_synced_albums(&app, &set);
    }
    #[cfg(not(windows))]
    let _ = (app, uid, enabled);
}

/// Marks a file just downloaded in sync once its bytes are still the ones the download wrote,
/// trying a few times while the program that opened it holds it for writing. A file that
/// changed in the meantime stays out of sync, and no free up throws the change away.
#[cfg(windows)]
fn settle_after_download(app: &tauri::AppHandle, path: &std::path::Path, uid: &str, written: (u64, u64)) {
    for wait in [700u64, 3_000, 15_000] {
        std::thread::sleep(std::time::Duration::from_millis(wait));
        match identity::mark_in_sync_if_same(path, written) {
            Ok(true) => return,
            Ok(false) => {
                crate::note(app, "[cloud] changed right after its download, left out of sync");
                return;
            }
            Err(_) => {}
        }
    }
    crate::note(app, "[cloud] in use after its download, left out of sync");
    // Checked against the revision's digest instead, in the background.
    if let Some(entry) = file_attribute_data(path) {
        verify::want(app, path, uid, stamp_of(&entry));
    }
}

/// The smallest and largest page populate asks the sidecar for. A cold page resolves
/// every photo in it over the network, so it starts small; one answered from cache
/// costs milliseconds, and paging four at a time would turn a large library into hours.
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub(crate) const POPULATE_PAGE_MIN: u64 = 4;
#[cfg_attr(target_os = "macos", allow(dead_code))]
const POPULATE_PAGE_MAX: u64 = 200;

/// The next page size and the rest before asking for it, from how long the last page
/// took: fast pages double, slow ones halve and leave the channel free for a moment.
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub(crate) fn next_populate_page(page: u64, took: std::time::Duration) -> (u64, std::time::Duration) {
    use std::time::Duration;
    if took < Duration::from_millis(300) {
        ((page * 2).min(POPULATE_PAGE_MAX), Duration::ZERO)
    } else if took > Duration::from_millis(1500) {
        ((page / 2).max(POPULATE_PAGE_MIN), Duration::from_millis(250))
    } else {
        (page, Duration::from_millis(100))
    }
}

/// Whether a path sits in a folder whose contents are not this account's to change.
#[cfg(windows)]
fn read_only_place(rel: &str) -> bool {
    use crate::explorer_rules::{place_of_dir, place_of_parent, Place};
    let parts: Vec<&str> = rel.split('\\').collect();
    matches!(place_of_parent(rel), Place::Shared | Place::Trash) || matches!(place_of_dir(&parts), Place::Shared | Place::Trash)
}

/// The Cloud Filter sync engine. When Explorer opens a placeholder, `fetch_data`
/// downloads the file through the sidecar and streams it into the placeholder.
#[cfg(windows)]
struct ProtonSyncFilter {
    app: tauri::AppHandle,
}

#[cfg(windows)]
impl cloud_filter::filter::SyncFilter for ProtonSyncFilter {
    fn fetch_data(
        &self,
        request: cloud_filter::filter::Request,
        ticket: cloud_filter::filter::ticket::FetchData,
        info: cloud_filter::filter::info::FetchData,
    ) -> cloud_filter::error::CResult<()> {
        use cloud_filter::error::CloudErrorKind;
        use cloud_filter::utility::WriteAt;
        use std::io::Read;

        // Hydrating a whole file holds the single sidecar channel; mark the mount busy
        // for the duration so the thumbnail warmer pauses instead of piling on. The
        // guard clears it on every return path below (download failure, size mismatch,
        // transfer error, success). It nests: when this hydration was triggered by
        // `pin_selected` or a populate pass, that outer guard keeps the busy state set
        // across the gap, so nothing is cleared early.
        let uid = String::from_utf8_lossy(request.file_blob()).into_owned();
        // A download of the pass that keeps every photo runs for days on end on the
        // background lane, so it neither pauses the warmer nor names itself as a file
        // something opened.
        let in_pass = crate::keep_all::in_pass(&uid);
        let _busy = (!in_pass).then(|| BusyGuard::new(&self.app));
        let want = request.file_size();
        // Diagnostic: name the process that triggered this hydration (exe basename only,
        // no path or PII) and whether it was an explicit pin ("keep offline") or an
        // implicit read. A "the app downloads my whole library on its own" report is
        // almost always some background reader (SearchIndexer.exe, MsMpEng.exe / an
        // antivirus, explorer.exe thumbnails) touching cloud-only placeholders, which
        // under the Full hydration policy pulls each entire file. This line shows who.
        let by = request
            .process()
            .path()
            .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
            .unwrap_or_else(|| "unknown".into());
        crate::note(
            &self.app,
            &format!("[cloud] hydrate start (size={want} by={by} explicit={})", info.explicit_hydration()),
        );
        let opened = request.path().file_name().map(|n| n.to_string_lossy().into_owned());
        let _doing = (!in_pass).then(|| Doing::new(&self.app, "open", opened, Some(by.clone())));
        // An album or favourites copy of a photo whose timeline copy is on this PC already
        // is filled from that copy, so it opens without a connection and is not fetched a
        // second time. Otherwise the sidecar streams the download to a temp file; either
        // way it is transferred into the placeholder a chunk at a time, so a large video
        // never sits in memory.
        // Noted before anything is written, so the fill never changes this file's identity
        // while the download runs, and checked against the file as it is now: the identity the
        // request carries was read when it was raised.
        let _filling = identity::Filling::begin(&request.path());
        if identity::read(&request.path()).is_some_and(|info| !info.is(&uid)) {
            crate::note(&self.app, "[cloud] hydrate aborted: the file now stands for another photo");
            return Err(CloudErrorKind::ValidationFailed);
        }
        let local = local_timeline_copy(&uid, &request.path(), want);
        let (temp, got) = match &local {
            Some(path) => (path.clone(), want),
            None => crate::hydrate_to_temp(&self.app, &uid).map_err(|e| {
                crate::note(&self.app, &format!("[cloud] hydrate download failed: {e}"));
                CloudErrorKind::NetworkUnavailable
            })?,
        };
        let staged = local.is_none();
        // Refuse a wrong-sized transfer instead of writing a broken partial. A short
        // read would leave the placeholder half-hydrated and stranded — undeletable,
        // with the shell reporting "the cloud provider is not running"; a long read
        // means the declared size is wrong. Aborting here writes nothing, so the file
        // stays a clean cloud-only placeholder that can be reopened or deleted.
        if got == 0 || got != want {
            crate::note(&self.app, &format!("[cloud] hydrate aborted (got {got} want {want})"));
            if staged {
                let _ = std::fs::remove_file(&temp);
            }
            return Err(CloudErrorKind::ValidationFailed);
        }

        // Stream the temp file into the placeholder. The OS requires each transfer to
        // be a multiple of 4KiB or to end exactly on the file size. Each chunk is one
        // CfExecute call, so a large chunk keeps a big video from costing hundreds of
        // thousands of them.
        const CHUNK: usize = 1 << 20;
        const PROGRESS_EVERY: std::time::Duration = std::time::Duration::from_millis(100);
        // What was written, for checking the file still holds exactly it before it is marked
        // in sync.
        let mut written = identity::Digest::default();
        let transfer = (|| -> Result<(), CloudErrorKind> {
            let mut f = std::fs::File::open(&temp).map_err(|e| {
                crate::note(&self.app, &format!("[cloud] hydrate open temp failed: {e:?}"));
                CloudErrorKind::Unsuccessful
            })?;
            let mut buf = vec![0u8; CHUNK];
            let mut offset = 0u64;
            let mut remaining = got;
            let mut reported = std::time::Instant::now();
            while remaining > 0 {
                let this = std::cmp::min(CHUNK as u64, remaining) as usize;
                f.read_exact(&mut buf[..this]).map_err(|e| {
                    crate::note(&self.app, &format!("[cloud] hydrate read temp failed: {e:?}"));
                    CloudErrorKind::Unsuccessful
                })?;
                ticket.write_at(&buf[..this], offset).map_err(|e| {
                    crate::note(&self.app, &format!("[cloud] transfer failed at {offset}: {e:?}"));
                    CloudErrorKind::InvalidRequest
                })?;
                written.add(&buf[..this]);
                offset += this as u64;
                remaining -= this as u64;
                if remaining == 0 || reported.elapsed() >= PROGRESS_EVERY {
                    let _ = ticket.report_progress(got, offset);
                    reported = std::time::Instant::now();
                }
            }
            Ok(())
        })();
        if staged {
            let _ = std::fs::remove_file(&temp);
        }
        transfer?;
        if !in_pass {
            crate::note(&self.app, &format!("[cloud] hydrate done ({got} bytes)"));
        }
        mark_hydrated(&uid, true);
        // Settle the in-sync state once the hydration handle is released, so the file can be
        // freed up later instead of being stranded on "waiting to sync", but only while it
        // still holds exactly what was written: a program that opened it may write to it
        // straight away, and a copy in sync may be freed, which throws its bytes away.
        let path = request.path();
        let app = self.app.clone();
        let written = written.finish();
        let downloaded = uid.clone();
        std::thread::spawn(move || settle_after_download(&app, &path, &downloaded, written));
        Ok(())
    }

    fn delete(
        &self,
        request: cloud_filter::filter::Request,
        ticket: cloud_filter::filter::ticket::Delete,
        _info: cloud_filter::filter::info::Delete,
    ) -> cloud_filter::error::CResult<()> {
        let root = sync_root_path();
        let Some(rel) = crate::explorer_sync::relative(&root, &request.path()) else {
            return ticket.pass().map_err(|_| cloud_filter::error::CloudErrorKind::InvalidRequest);
        };
        if !crate::explorer_sync::is_own(&rel)
            && !detaching()
            && (read_only_place(&rel) || !explorer_edits_enabled())
        {
            // The trash is never emptied from here, and what others shared is theirs.
            return Err(cloud_filter::error::CloudErrorKind::AccessDenied);
        }
        // The photo this file opens, for reading the delete back once the file is gone.
        crate::explorer_sync::note_identity(&rel, &String::from_utf8_lossy(request.file_blob()));
        ticket.pass().map_err(|_| cloud_filter::error::CloudErrorKind::InvalidRequest)
    }

    fn rename(
        &self,
        request: cloud_filter::filter::Request,
        ticket: cloud_filter::filter::ticket::Rename,
        info: cloud_filter::filter::info::Rename,
    ) -> cloud_filter::error::CResult<()> {
        let root = sync_root_path();
        let from = crate::explorer_sync::relative(&root, &request.path());
        let to = if info.target_in_scope() { crate::explorer_sync::relative(&root, &info.target_path()) } else { None };
        if let Some(from) = &from {
            if !crate::explorer_sync::is_own(from) {
                let restoring = to.as_deref().is_some_and(|to| {
                    crate::explorer_rules::place_of_parent(from) == crate::explorer_rules::Place::Trash
                        && !read_only_place(to)
                });
                let into_read_only = to.as_deref().is_some_and(|to| {
                    crate::explorer_rules::place_of_parent(to) == crate::explorer_rules::Place::Shared
                });
                if (read_only_place(from) && !restoring) || into_read_only {
                    return Err(cloud_filter::error::CloudErrorKind::AccessDenied);
                }
                // Leaving the folder as an ordinary copy is not a deletion. The Recycle Bin
                // is a move out too, and that one is: the watcher sees it go to the trash.
                let recycled = to.is_none() && in_recycle_bin(&info.target_path());
                if (to.is_some() || recycled) && !explorer_edits_enabled() {
                    let dir = std::fs::symlink_metadata(request.path()).is_ok_and(|m| m.is_dir());
                    if crate::explorer_rules::takes_away(from, to.as_deref(), dir) {
                        return Err(cloud_filter::error::CloudErrorKind::AccessDenied);
                    }
                }
                if to.is_none() && !recycled {
                    crate::explorer_sync::note_moved_out(from);
                }
                // The photo this file opens, for reading the move back once it has left `from`.
                crate::explorer_sync::note_identity(from, &String::from_utf8_lossy(request.file_blob()));
            }
        }
        ticket.pass().map_err(|_| cloud_filter::error::CloudErrorKind::InvalidRequest)
    }

    fn dehydrate(
        &self,
        request: cloud_filter::filter::Request,
        ticket: cloud_filter::filter::ticket::Dehydrate,
        _info: cloud_filter::filter::info::Dehydrate,
    ) -> cloud_filter::error::CResult<()> {
        use crate::keep_all::OsFree;
        let path = request.path();
        let unpinned = file_attributes(&path).is_some_and(|a| a & FILE_ATTRIBUTE_UNPINNED != 0);
        let blob_uid = String::from_utf8_lossy(request.file_blob()).into_owned();
        let listed = listed_copy(&blob_uid, &path);
        let decision = crate::keep_all::os_free(
            crate::keep_all::mode(&self.app),
            dehydrating_ourselves(&path),
            listed,
            unpinned,
        );
        if decision == OsFree::Refuse {
            crate::note(
                &self.app,
                if listed {
                    "[cloud] dehydrate refused: every photo is kept on this PC"
                } else {
                    "[cloud] dehydrate refused: the copy is not a photo of the library"
                },
            );
            return Err(cloud_filter::error::CloudErrorKind::AccessDenied);
        }
        // Approve "free up space": the local data is dropped and the file goes back
        // to a dehydrated cloud placeholder (green cloud, still in sync). Logged so
        // a "stuck on waiting to sync" report shows whether Windows even reaches the
        // provider (if this line is absent from the log, the file was not in-sync and
        // Windows blocked the free-up before calling us).
        crate::note(&self.app, "[cloud] dehydrate (free up space) requested");
        match ticket.pass() {
            Ok(()) => {
                crate::note(&self.app, "[cloud] dehydrate approved");
                if decision == OsFree::Record {
                    note_os_freed(&self.app, &blob_uid, &path);
                }
                rescan_hydrated();
                Ok(())
            }
            Err(e) => {
                crate::note(&self.app, &format!("[cloud] dehydrate pass failed: {e:?}"));
                Err(cloud_filter::error::CloudErrorKind::InvalidRequest)
            }
        }
    }
}

/// Create dehydrated placeholders (green cloud) for the cloud photos. Called by the
/// frontend once the timeline has loaded (so the sidecar is signed in). Runs off
/// the main thread; per-photo errors are non-fatal.
#[tauri::command]
pub fn populate_mount(app: tauri::AppHandle) {
    #[cfg(windows)]
    std::thread::spawn(move || {
        // Opting out has to actually opt out. The frontend calls this as soon as the
        // timeline loads, with no idea of the preference, so the gate belongs here
        // rather than at the caller: otherwise a user who turned the Explorer
        // integration off still got the folder tree, one subfolder named after each
        // of their albums, and the uid snapshot written to disk.
        if !show_in_explorer_enabled() {
            return;
        }
        // The page asks again each time it loads, which a window brought back from the
        // tray does. The first fill of a run is the one worth showing; after it, the
        // folder is only checked again quietly, and not more often than REFILL_AFTER.
        let Some(first) = claim_page_fill() else { return };
        let _busy = BusyGuard::new(&app);
        let _doing = first.then(|| Doing::new(&app, "fill", None, None));
        match try_populate(&app) {
            Ok(()) => filled(),
            Err(e) => eprintln!("[cloud_mount] populate failed: {e}"),
        }
    });
    #[cfg(not(windows))]
    let _ = app;
}

/// The tray "Sync now" action: fills the folder again and asks the open window to reload
/// its view. What it downloads is only what the chosen mode already asks for, and the
/// worker does that outside the fill, so the button itself never starts a download of
/// the library. Safe to press at any time.
#[tauri::command]
pub fn sync_now(app: tauri::AppHandle) {
    #[cfg(windows)]
    std::thread::spawn(move || {
        // Only touch the mount when the user opted into it. The view refresh below is
        // worth doing either way, so the button still means something with the
        // Explorer integration off.
        if show_in_explorer_enabled() {
            // Scoped to this block, so the busy mark is cleared before the refresh
            // below.
            let _busy = BusyGuard::new(&app);
            let _doing = Doing::new(&app, "fill", None, None);
            match try_populate(&app) {
                Ok(()) => filled(),
                Err(e) => eprintln!("[cloud_mount] sync_now failed: {e}"),
            }
        }
        // Reload the open window's timeline / albums, like a manual refresh.
        use tauri::Emitter;
        let _ = app.emit("refresh-view", ());
    });
    #[cfg(not(windows))]
    let _ = app;
}

/// Clears out what the library no longer has: a cloud-only placeholder this fill did not
/// make or find again stands for a photo deleted elsewhere, trashed, or taken out of
/// that album, and only the app ever makes placeholders. An album folder that held
/// nothing else is removed with them, unless it is still an album.
///
/// A downloaded copy in `Photos\` whose photo left the library stays, unless Drive itself
/// says what became of it (`keep_all::release_decision`): a hidden photo's copy goes, so it
/// is not left in the plain folder, and while every photo is kept, the copy of a photo that
/// went to the Proton trash goes too. Leaving the listing alone is never reason enough.
///
/// A downloaded copy under a name the photo no longer has (renamed in the app or on
/// another device) takes the new name instead, in place of the empty placeholder this
/// fill just made for it, so the bytes already on this PC are kept and the photo does not
/// show twice.
#[cfg(windows)]
fn prune_stale(
    app: &tauri::AppHandle,
    root: &std::path::Path,
    previous: &std::collections::HashMap<String, String>,
) {
    const RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;
    let current = rel_to_uid();
    let known: std::collections::HashSet<String> = current.keys().map(|rel| rel.to_lowercase()).collect();
    // Where each photo now sits, by folder: the path this fill gave it there.
    let mut now_at: std::collections::HashMap<(String, String), String> = std::collections::HashMap::new();
    for (rel, uid) in &current {
        let folder = rel.rsplit_once('\\').map(|(f, _)| f.to_lowercase()).unwrap_or_default();
        now_at.insert((folder, uid.clone()), rel.clone());
    }
    let previous: std::collections::HashMap<String, String> =
        previous.iter().map(|(rel, uid)| (rel.to_lowercase(), uid.clone())).collect();
    let mut renamed = 0usize;
    let mut folders = vec![
        "Photos".to_string(),
        "Photos\\Favorites".to_string(),
        "Trash".to_string(),
        "Shared".to_string(),
    ];
    if let Ok(entries) = std::fs::read_dir(root.join("Shared")) {
        for entry in entries.flatten() {
            if entry.file_type().is_ok_and(|t| t.is_dir()) {
                folders.push(format!("Shared\\{}", entry.file_name().to_string_lossy()));
            }
        }
    }
    if let Ok(entries) = std::fs::read_dir(root.join("Albums")) {
        for entry in entries.flatten() {
            if entry.file_type().is_ok_and(|t| t.is_dir()) {
                folders.push(format!("Albums\\{}", entry.file_name().to_string_lossy()));
            }
        }
    }
    let mut removed = 0usize;
    // Downloaded copies in `Photos\` whose photo is not in the library, for Drive to say why.
    let mut orphans: Vec<(String, std::path::PathBuf, String)> = Vec::new();
    // The photos this mode downloaded and the ones hidden in the app, asked for only when a
    // downloaded copy turns up whose photo this fill did not list.
    let mut known_tails: Option<(std::collections::HashSet<String>, Vec<String>)> = None;
    for folder in &folders {
        let Ok(entries) = std::fs::read_dir(root.join(folder)) else { continue };
        for entry in entries.flatten() {
            // The directory entry only: opening a cloud-only file would download it.
            if !entry.file_type().is_ok_and(|t| t.is_file()) {
                continue;
            }
            let rel = format!("{folder}\\{}", entry.file_name().to_string_lossy());
            if known.contains(&rel.to_lowercase()) {
                continue;
            }
            let cloud_only = file_attributes(&entry.path()).is_some_and(|a| a & RECALL_ON_DATA_ACCESS != 0);
            if !cloud_only {
                // Downloaded: the photo's own copy under an old name, when the previous
                // fill had it here and this one placed the same photo here as well.
                let here = folder.to_lowercase();
                let uid = previous.get(&rel.to_lowercase()).cloned().or_else(|| {
                    // The uid the file carries, read back cut short at the front (see
                    // `downloaded_uid`), so it is matched by its end against the photos
                    // this fill placed in the same folder.
                    let tail = downloaded_uid(&entry.path())?;
                    now_at
                        .keys()
                        .find(|(f, u)| *f == here && u.ends_with(&tail) && u.len() - tail.len() <= 16)
                        .map(|(_, u)| u.clone())
                });
                let uid = uid.or_else(|| {
                    // Not in this folder any more: matched against the timeline instead.
                    let tail = downloaded_uid(&entry.path())?;
                    let mut on_timeline = now_at
                        .keys()
                        .filter(|(f, u)| f == "photos" && u.ends_with(&tail) && u.len() - tail.len() <= 16);
                    match (on_timeline.next(), on_timeline.next()) {
                        (Some((_, u)), None) => Some(u.clone()),
                        _ => None,
                    }
                });
                let uid = match uid {
                    Some(uid) => Some(uid),
                    None if here == "photos" => {
                        // Not a photo of this listing at all: one of the copies this mode kept,
                        // or a photo hidden in the app, matched by the end of the uid it carries.
                        let Some(tail) = downloaded_uid(&entry.path()) else { continue };
                        let (kept, hidden) = known_tails.get_or_insert_with(|| {
                            let hidden = crate::sidecar_rpc(app, "mountHidden", serde_json::json!({}))
                                .ok()
                                .and_then(|r| serde_json::from_value::<Vec<String>>(r).ok())
                                .unwrap_or_default();
                            (crate::keep_all::kept(app), hidden)
                        });
                        if let Some(h) = hidden.iter().find(|h| !h.is_empty() && (h.ends_with(&tail) || tail.ends_with(h.as_str()))) {
                            // Hidden: out of the plain folder whatever the mode, and whoever
                            // downloaded it, once Drive says the photo is still there, behind the
                            // lock. Hidden and deleted for good, the copy is all that is left, and
                            // it stays as the user's own (`release_orphans`).
                            let listed = now_at.keys().map(|(_, u)| u.as_str());
                            if let Some(uid) = crate::keep_all::hidden_copy_uid(&tail, h, listed) {
                                orphans.push((uid, entry.path(), rel));
                            }
                            continue;
                        }
                        let mut matches = kept.iter().filter(|u| u.ends_with(&tail) && u.len() - tail.len() <= 16);
                        match (matches.next(), matches.next()) {
                            (Some(u), None) => Some(u.clone()),
                            _ => None,
                        }
                    }
                    None => None,
                };
                let Some(uid) = uid else { continue };
                let Some(new_rel) = now_at.get(&(here.clone(), uid.clone())) else {
                    // A downloaded copy in a favourites or album folder the photo has left,
                    // while the photo is still on the timeline: only a second copy of it.
                    // It goes once it is back to cloud-only, which the driver allows only
                    // for a copy still identical to the cloud file, so nothing of the
                    // user's own is ever thrown away.
                    let view = here == "photos\\favorites" || here.starts_with("albums\\");
                    if view && now_at.contains_key(&("photos".to_string(), uid.clone())) && let_go_of_copy(&entry.path(), &rel) {
                        removed += 1;
                    }
                    if here == "photos" && !now_at.contains_key(&("photos".to_string(), uid.clone())) {
                        orphans.push((uid, entry.path(), rel));
                    }
                    continue;
                };
                let new_path = root.join(new_rel);
                let new_is_empty = file_attributes(&new_path).is_some_and(|a| a & RECALL_ON_DATA_ACCESS != 0);
                if !new_is_empty {
                    continue;
                }
                crate::explorer_sync::expect_own(new_rel);
                crate::explorer_sync::expect_own(&rel);
                if std::fs::remove_file(&new_path).is_ok() && std::fs::rename(entry.path(), &new_path).is_ok() {
                    renamed += 1;
                }
                continue;
            }
            crate::explorer_sync::expect_own(&rel);
            if std::fs::remove_file(entry.path()).is_ok() {
                removed += 1;
            }
        }
        // A shared album no longer shared, now empty, goes the same way.
        if folder.starts_with("Shared\\") {
            let path = root.join(folder);
            if std::fs::read_dir(&path).is_ok_and(|mut d| d.next().is_none()) {
                crate::explorer_sync::expect_own(folder);
                let _ = std::fs::remove_dir(&path);
            }
        }
        // An album folder the library no longer has, now empty, goes too.
        if let Some(name) = folder.strip_prefix("Albums\\") {
            if album_for_folder(name).is_none() {
                let path = root.join(folder);
                if std::fs::read_dir(&path).is_ok_and(|mut d| d.next().is_none()) {
                    crate::explorer_sync::expect_own(folder);
                    let _ = std::fs::remove_dir(&path);
                }
            }
        }
    }
    removed += release_orphans(app, orphans);
    if removed > 0 {
        crate::note(app, &format!("[cloud] populate: removed {removed} placeholders the library no longer has"));
    }
    if renamed > 0 {
        crate::note(app, &format!("[cloud] populate: renamed {renamed} downloaded copies to their new names"));
    }
}

/// Turns a downloaded copy back to cloud-only and removes it. The driver refuses to
/// dehydrate a copy that differs from the cloud file, and then the copy stays.
#[cfg(windows)]
fn let_go_of_copy(path: &std::path::Path, rel: &str) -> bool {
    use cloud_filter::ext::FileExt;
    if file_attributes(path).is_some_and(|a| a & FILE_ATTRIBUTE_PINNED != 0) {
        clear_pin_mark(path, false);
    }
    let Ok(file) = std::fs::OpenOptions::new().read(true).write(true).open(path) else {
        return false;
    };
    let dehydrated = {
        let _own = OwnDehydrate::new(path);
        file.dehydrate(..).is_ok()
    };
    if !dehydrated {
        return false;
    }
    drop(file);
    crate::explorer_sync::expect_own(rel);
    std::fs::remove_file(path).is_ok()
}

/// The paths the app itself is turning back to cloud-only right now. While every photo is
/// kept, a dehydration Windows starts by itself (Storage Sense) is refused, so a kept copy
/// is not freed behind the user's back and then downloaded again; these are let through.
#[cfg(windows)]
fn own_dehydrations() -> &'static std::sync::Mutex<std::collections::HashSet<String>> {
    static OWN: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> = std::sync::OnceLock::new();
    OWN.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()))
}

#[cfg(windows)]
struct OwnDehydrate(String);

#[cfg(windows)]
impl OwnDehydrate {
    fn new(path: &std::path::Path) -> Self {
        let key = path.to_string_lossy().to_lowercase();
        own_dehydrations().lock().unwrap().insert(key.clone());
        OwnDehydrate(key)
    }
}

#[cfg(windows)]
impl Drop for OwnDehydrate {
    fn drop(&mut self) {
        own_dehydrations().lock().unwrap().remove(&self.0);
    }
}

/// Whether the folder's index lists this file as a copy of the photo it carries.
#[cfg(windows)]
fn listed_copy(uid: &str, path: &std::path::Path) -> bool {
    let Some(rel) = crate::explorer_sync::relative(&sync_root_path(), path) else { return false };
    let rel = rel.to_lowercase();
    mount_index().lock().unwrap().get(uid).is_some_and(|rels| rels.iter().any(|r| r.to_lowercase() == rel))
}

#[cfg(windows)]
fn dehydrating_ourselves(path: &std::path::Path) -> bool {
    own_dehydrations().lock().unwrap().contains(&path.to_string_lossy().to_lowercase())
}

/// Records a copy Windows freed as the app's Free up records it: the timeline copy as the
/// photo, any other copy as an album's.
#[cfg(windows)]
fn note_os_freed(app: &tauri::AppHandle, uid: &str, path: &std::path::Path) {
    if uid.is_empty() {
        return;
    }
    let copy = match crate::explorer_sync::relative(&sync_root_path(), path) {
        Some(rel) => crate::keep_all::freed_copy(&rel, timeline_rel(uid).as_deref()),
        None => crate::keep_all::FreedCopy::Album,
    };
    crate::keep_all::note_copy_freed(app, &[uid.to_string()], copy);
}

/// Lets go of the downloaded copies whose photos left the library, by Drive's own answer
/// for each (see `keep_all::release_decision`), and returns how many went.
#[cfg(windows)]
fn release_orphans(app: &tauri::AppHandle, orphans: Vec<(String, std::path::PathBuf, String)>) -> usize {
    if orphans.is_empty() {
        return 0;
    }
    let uids: Vec<String> = orphans.iter().map(|(uid, _, _)| uid.clone()).collect();
    let mut fates: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for chunk in uids.chunks(100) {
        if let Ok(answer) = crate::sidecar_rpc(app, "mountFates", serde_json::json!({ "uids": chunk })) {
            if let Ok(map) = serde_json::from_value::<std::collections::HashMap<String, String>>(answer) {
                fates.extend(map);
            }
        }
    }
    let kept = crate::keep_all::kept(app);
    let decision = crate::keep_all::release_decision(&uids, &fates, &kept, crate::keep_all::mode(app));
    let go: std::collections::HashSet<&String> = decision.let_go.iter().collect();
    let mut released = Vec::new();
    for (uid, path, rel) in &orphans {
        if go.contains(uid) && let_go_of_copy(path, rel) {
            released.push(uid.clone());
        }
    }
    crate::keep_all::settle(app, &released, &decision.held, &decision.forget);
    crate::note(
        app,
        &format!(
            "[keep] {} copies whose photos left the library: {} let go of, {} held, {} kept as the user's",
            orphans.len(),
            released.len(),
            decision.held.len(),
            decision.forget.len()
        ),
    );
    if !decision.held.is_empty() {
        use tauri::Emitter;
        let _ = app.emit("keep-progress", crate::keep_all::status(app));
    }
    released.len()
}

/// The downloaded copies in `Photos\` of the given photos, found by the uid each carries.
#[cfg(windows)]
fn downloaded_copies_of(uids: &[String]) -> Vec<(String, std::path::PathBuf, String)> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(sync_root_path().join("Photos")) else { return out };
    for entry in entries.flatten() {
        if !entry.file_type().is_ok_and(|t| t.is_file()) {
            continue;
        }
        let Some(tail) = downloaded_uid(&entry.path()) else { continue };
        let mut matches = uids.iter().filter(|u| u.ends_with(&tail) && u.len() - tail.len() <= 16);
        if let (Some(uid), None) = (matches.next(), matches.next()) {
            let rel = format!("Photos\\{}", entry.file_name().to_string_lossy());
            out.push((uid.clone(), entry.path(), rel));
        }
    }
    out
}

/// The timeline's photos as the last fill listed them, newest first.
#[cfg(windows)]
fn timeline_order() -> &'static std::sync::Mutex<Vec<String>> {
    static ORDER: std::sync::OnceLock<std::sync::Mutex<Vec<String>>> = std::sync::OnceLock::new();
    ORDER.get_or_init(|| std::sync::Mutex::new(Vec::new()))
}

/// The copy of a photo in `Photos\` itself, the one a download keeps. None for a photo
/// whose timeline copy this fill could not make, which only has an album copy.
#[cfg(windows)]
fn timeline_rel(uid: &str) -> Option<String> {
    mount_index()
        .lock()
        .unwrap()
        .get(uid)
        .and_then(|rels| rels.first())
        .filter(|rel| rel.starts_with("Photos\\") && !rel.starts_with("Photos\\Favorites\\"))
        .cloned()
}

/// The timeline copy of a photo, when it is on this PC already with the size the cloud
/// file has and is not the very file being filled, so another copy of the same photo (in
/// an album or the favourites) can be filled from it. Only a copy of this photo in sync,
/// which is the cloud file's bytes: one changed here would carry the change into the other.
#[cfg(windows)]
fn local_timeline_copy(uid: &str, asking: &std::path::Path, size: u64) -> Option<std::path::PathBuf> {
    let base = sync_root_path();
    let rel = timeline_rel(uid)?;
    let path = base.join(&rel);
    if path.to_string_lossy().eq_ignore_ascii_case(&asking.to_string_lossy()) {
        return None;
    }
    if hydrated_size(&base, &rel)? != size {
        return None;
    }
    identity::read(&path).is_some_and(|info| info.is(uid) && info.in_sync).then_some(path)
}

/// The photos the last fill placed in `Photos\`, newest first.
#[cfg(windows)]
pub(crate) fn timeline_uids() -> Vec<String> {
    let order = timeline_order().lock().unwrap().clone();
    order.into_iter().filter(|uid| timeline_rel(uid).is_some()).collect()
}

/// Whether a photo's timeline copy holds no data on this PC right now.
#[cfg(windows)]
pub(crate) fn is_cloud_only(uid: &str) -> bool {
    const RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;
    timeline_rel(uid)
        .and_then(|rel| file_attributes(&sync_root_path().join(rel)))
        .is_some_and(|a| a & RECALL_ON_DATA_ACCESS != 0)
}

/// Whether any copy of a photo, in `Photos\` or in an album, holds its data on this PC.
#[cfg(windows)]
pub(crate) fn any_copy_local(uid: &str) -> bool {
    const RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;
    let rels = mount_index().lock().unwrap().get(uid).cloned().unwrap_or_default();
    let base = sync_root_path();
    rels.iter()
        .any(|rel| file_attributes(&base.join(rel)).is_some_and(|a| a & RECALL_ON_DATA_ACCESS == 0))
}

#[cfg(windows)]
pub(crate) fn cloud_size_of(uid: &str) -> Option<u64> {
    cloud_size(uid)
}

/// Downloads a photo's timeline copy in place, but only while it is cloud-only: a file that
/// is local already, or is no placeholder at all, is left exactly as it is. Unlike
/// `keep_offline_one`, it never adopts a plain file, which by now could be the user's own.
/// The download itself marks the copy in sync once its bytes check out.
#[cfg(windows)]
pub(crate) fn hydrate_cloud_only(uid: &str) -> bool {
    use cloud_filter::placeholder::OpenOptions;
    if !is_cloud_only(uid) {
        return false;
    }
    let Some(rel) = timeline_rel(uid) else { return false };
    let path = sync_root_path().join(rel);
    // Read without opening it for its data: a placeholder of another photo under this name
    // would download that photo.
    if !identity::read(&path).is_some_and(|info| info.is(uid)) {
        return false;
    }
    let Ok(mut ph) = OpenOptions::new().write_access().open(&path) else { return false };
    ph.hydrate(..).is_ok()
}

/// Free space on the drive the folder is on, as this user may use it.
#[cfg(windows)]
pub(crate) fn free_space() -> Option<u64> {
    use windows::core::HSTRING;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let root = HSTRING::from(sync_root_path().to_string_lossy().as_ref());
    let mut free = 0u64;
    unsafe { GetDiskFreeSpaceExW(&root, Some(&mut free), None, None) }.ok()?;
    Some(free)
}

/// The quarter-hourly fill while the app sits in the tray, so new photos arrive and the
/// folder follows the library without the window. Only after a fill of this run has
/// happened, which means the account is signed in, and never sooner than a page load's.
#[cfg(windows)]
pub(crate) fn timed_fill(app: &tauri::AppHandle) {
    if !show_in_explorer_enabled() || !FILL_STARTED.load(std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    if !LAST_FILL.lock().unwrap().is_some_and(|at| at.elapsed() >= REFILL_AFTER) {
        return;
    }
    let _busy = BusyGuard::new(app);
    match try_populate(app) {
        Ok(()) => filled(),
        Err(e) => crate::note(app, &format!("[cloud] timed fill failed: {e}")),
    }
}

/// The uid a downloaded placeholder carries, as far as it can be read back. The
/// cloud-filter crate's `blob()` starts a few bytes past where the identity really does
/// (it skips the whole padded header struct), so what comes back is the uid's END, not
/// all of it; callers match it against the uids they know. Opening the file reads
/// nothing from the cloud, its bytes being here already: never call this on a
/// cloud-only one, where opening is what downloads it.
#[cfg(windows)]
fn downloaded_uid(path: &std::path::Path) -> Option<String> {
    const RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;
    const REPARSE_POINT: u32 = 0x400;
    let attrs = file_attributes(path)?;
    if attrs & RECALL_ON_DATA_ACCESS != 0 || attrs & REPARSE_POINT == 0 {
        return None;
    }
    let placeholder = cloud_filter::placeholder::OpenOptions::new().open(path).ok()?;
    let info = placeholder.info().ok().flatten()?;
    let uid = String::from_utf8(info.blob().to_vec()).ok()?;
    (!uid.is_empty()).then_some(uid)
}

/// One folder of placeholders for photos that show somewhere else too: the favourites,
/// the trash, and what others shared. Each copy is the same cloud file, behind the same
/// uid, made the way the timeline's are.
#[cfg(windows)]
fn populate_flat(app: &tauri::AppHandle, root: &std::path::Path, rel_dir: &str, photos: &[(String, String, u64, i64)]) -> usize {
    use cloud_filter::metadata::{Metadata, MetadataExt};
    use cloud_filter::placeholder_file::PlaceholderFile;
    let dir = root.join(rel_dir);
    if !dir.exists() {
        crate::explorer_sync::expect_own(rel_dir);
    }
    if std::fs::create_dir_all(&dir).is_err() {
        return 0;
    }
    mark_not_indexed(&dir);
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut made = 0usize;
    for (uid, base, size, ft) in photos {
        if *size == 0 {
            continue;
        }
        let unique = unique_name(base, &mut seen);
        let placeholder = PlaceholderFile::new(&unique)
            .mark_in_sync()
            .metadata(Metadata::file().size(*size).creation_time(*ft).last_write_time(*ft))
            .blob(uid.as_bytes().to_vec());
        let owned = if placeholder.create::<&std::path::Path>(&dir).is_ok() {
            made += 1;
            true
        } else {
            reconcile_existing(app, &dir.join(&unique), uid, *size, *ft) != Existing::Foreign
        };
        mark_not_indexed(&dir.join(&unique));
        if owned {
            index_push(uid, &format!("{rel_dir}\\{unique}"));
        }
    }
    made
}

/// The folders beside the timeline and the albums: `Photos\Favorites\`, `Trash\`, and
/// `Shared\` with a folder per album others shared. The trash and the shared folders are
/// read-only from Explorer; the sync filter refuses changes there.
#[cfg(windows)]
fn populate_extras(app: &tauri::AppHandle, root: &std::path::Path, favorites: &[(String, String, u64, i64)]) {
    let mut made = populate_flat(app, root, "Photos\\Favorites", favorites);
    let extras = match crate::sidecar_rpc(app, "listExtrasForMount", serde_json::json!({})) {
        Ok(v) => v,
        Err(e) => {
            crate::note(app, &format!("[cloud] trash and shared skipped: {e}"));
            return;
        }
    };
    let photos_of = |list: Option<&serde_json::Value>| -> Vec<(String, String, u64, i64)> {
        list.and_then(|v| v.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|p| {
                        let uid = p.get("uid")?.as_str()?.to_string();
                        let name = p.get("name").and_then(|v| v.as_str()).unwrap_or(&uid).to_string();
                        let size = p.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
                        let ft = unix_ms_to_filetime(p.get("captureTime").and_then(|v| v.as_i64()).unwrap_or(0));
                        Some((uid, sanitize_name(&name), size, ft))
                    })
                    .collect()
            })
            .unwrap_or_default()
    };
    made += populate_flat(app, root, "Trash", &photos_of(extras.get("trash")));
    made += populate_flat(app, root, "Shared", &photos_of(extras.get("shared")));
    let mut album_names: std::collections::HashSet<String> = std::collections::HashSet::new();
    for album in extras.get("sharedAlbums").and_then(|v| v.as_array()).into_iter().flatten() {
        let name = album.get("name").and_then(|v| v.as_str()).unwrap_or("Album");
        let folder = unique_name(&sanitize_name(name), &mut album_names);
        made += populate_flat(app, root, &format!("Shared\\{folder}"), &photos_of(album.get("photos")));
    }
    crate::note(app, &format!("[cloud] populate: created {made} favourite, trash and shared placeholders"));
}

/// Empties the folder of the account that signed out. Every cloud-only placeholder
/// goes: it holds no data, only a promise to download from an account that is no longer
/// here. A downloaded copy stays exactly as it is, a placeholder holding its bytes:
/// turned into an ordinary file it would read, after a sign-in to another account, as a
/// file put there to upload, and the previous account's photos would go up into the new
/// one. As a placeholder the next fill knows it for what it is, the same account's own
/// copy, or another account's to leave alone. Album and shared folders left empty go too.
#[cfg(windows)]
pub(crate) fn clear_after_sign_out(app: &tauri::AppHandle) {
    const RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;
    crate::keep_all::forget();
    // What the folder held is this account's business; the next one takes its own look.
    if let Ok(dir) = crate::secure_store::app_dir(app) {
        let _ = std::fs::remove_file(dir.join(crate::explorer_sync::SEEN_FILE));
        let _ = std::fs::remove_file(dir.join(relocate::RESTORE_FILE));
    }
    let _fill = populate_lock();
    let root = sync_root_path();
    // A folder whose drive is gone is not touched: another disk may hold that letter now.
    let present = sync_root_available();
    let mut folders: Vec<String> = if present {
        vec!["Photos".into(), "Photos\\Favorites".into(), "Trash".into(), "Shared".into()]
    } else {
        Vec::new()
    };
    for parent in ["Albums", "Shared"].into_iter().filter(|_| present) {
        if let Ok(entries) = std::fs::read_dir(root.join(parent)) {
            for entry in entries.flatten() {
                if entry.file_type().is_ok_and(|t| t.is_dir()) {
                    folders.push(format!("{parent}\\{}", entry.file_name().to_string_lossy()));
                }
            }
        }
    }
    let mut removed = 0usize;
    for folder in &folders {
        let Ok(entries) = std::fs::read_dir(root.join(folder)) else { continue };
        for entry in entries.flatten() {
            if !entry.file_type().is_ok_and(|t| t.is_file()) {
                continue;
            }
            if !file_attributes(&entry.path()).is_some_and(|a| a & RECALL_ON_DATA_ACCESS != 0) {
                continue;
            }
            crate::explorer_sync::expect_own(&format!("{folder}\\{}", entry.file_name().to_string_lossy()));
            if std::fs::remove_file(entry.path()).is_ok() {
                removed += 1;
            }
        }
    }
    // Deepest first, so a shared album's folder goes before `Shared` itself is looked at.
    for folder in folders.iter().rev() {
        if folder == "Photos" {
            continue;
        }
        let path = root.join(folder);
        if std::fs::read_dir(&path).is_ok_and(|mut d| d.next().is_none()) {
            crate::explorer_sync::expect_own(folder);
            let _ = std::fs::remove_dir(&path);
        }
    }
    forget_mount_state();
    // Whether the next account's photos show in File Explorer is that account's choice: the
    // folder stops filling now, and the window says so once the next account is in.
    if show_in_explorer_enabled() {
        set_show_in_explorer(false);
        let left = files_under(&root);
        let _ = crate::secure_store::write_sealed(app, EXPLORER_OFF_NOTICE, &left.to_string());
    }
    crate::note(app, &format!("[cloud] signed out: removed {removed} placeholders, kept downloaded copies"));
}

/// Forgets what the folder's last fill knew: the copies it indexed, the albums' folders, the
/// fills' timing and which photos were on this PC.
#[cfg(windows)]
fn forget_mount_state() {
    // A fill still running for the account that left publishes nothing.
    *NEXT_INDEX.lock().unwrap_or_else(|p| p.into_inner()) = None;
    verify::forget();
    mount_index().lock().unwrap().clear();
    album_index().lock().unwrap().clear();
    album_dirs().lock().unwrap().clear();
    forget_fills();
    let (state, _) = hydrated_state();
    let mut st = state.lock().unwrap();
    st.uids.clear();
    st.version += 1;
}

/// Whether a path lies in a drive's Recycle Bin, where Explorer's Delete moves a file.
#[cfg(windows)]
fn in_recycle_bin(path: &std::path::Path) -> bool {
    path.components().any(|c| c.as_os_str().eq_ignore_ascii_case("$Recycle.Bin"))
}

/// Held for a whole fill of the folder: the fill rebuilds the index the watcher reads
/// the folder against, and two fills at once would race each other's placeholders.
#[cfg(windows)]
static POPULATE: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(windows)]
pub(crate) fn populate_lock() -> std::sync::MutexGuard<'static, ()> {
    POPULATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Fills the folder again from the library, for the watcher after a change it carried
/// over: what the library took shows as it now is, and what it did not comes back.
#[cfg(windows)]
pub(crate) fn refresh_mount(app: &tauri::AppHandle) {
    if !show_in_explorer_enabled() {
        return;
    }
    {
        let _busy = BusyGuard::new(app);
        match try_populate(app) {
            Ok(()) => filled(),
            Err(e) => crate::note(app, &format!("[cloud] refresh failed: {e}")),
        }
    }
    use tauri::Emitter;
    let _ = app.emit("refresh-view", ());
}

/// Every placeholder path the folder's index knows, lowercased, with its photo's uid.
#[cfg(windows)]
pub(crate) fn photos_by_path() -> std::collections::HashMap<String, String> {
    rel_to_uid().into_iter().map(|(rel, uid)| (rel.to_lowercase(), uid)).collect()
}

/// Album folder names as the last fill made them, lowercased, to the album's uid.
#[cfg(windows)]
static ALBUM_DIRS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, String>>> =
    std::sync::OnceLock::new();

#[cfg(windows)]
fn album_dirs() -> &'static std::sync::Mutex<std::collections::HashMap<String, String>> {
    ALBUM_DIRS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// The album an album folder in `Albums\` stands for, by the folder's name.
#[cfg(windows)]
pub(crate) fn album_for_folder(name: &str) -> Option<String> {
    album_dirs().lock().unwrap().get(&name.to_lowercase()).cloned()
}

#[cfg(windows)]
fn try_populate(app: &tauri::AppHandle) -> Result<(), String> {
    let _fill = populate_lock();
    populate_locked(app)?;
    relocate::resume_restore(app);
    Ok(())
}

/// The fill itself, for a caller that already holds `populate_lock`.
#[cfg(windows)]
fn populate_locked(app: &tauri::AppHandle) -> Result<(), String> {
    use cloud_filter::metadata::{Metadata, MetadataExt};
    use cloud_filter::placeholder_file::PlaceholderFile;
    use std::collections::{HashMap, HashSet};

    if !sync_root_available() {
        return Err("the drive of the folder is not connected".into());
    }
    let folder = sync_root_path();
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    mark_not_indexed(&folder);
    // What the previous fill knew, for `prune_stale` to recognise a downloaded copy that
    // is still a photo of the library under the name it had before a rename. The new index
    // is built aside and replaces it whole once everything is placed.
    let previous = rel_to_uid();
    begin_index();
    cleanup_stale_root(&folder);

    let photos_dir = folder.join("Photos");
    // Marked as the app's own only when the app makes it: a mark on a folder that is
    // already there would hide the user's own rename of it from the watcher.
    if !photos_dir.exists() {
        crate::explorer_sync::expect_own("Photos");
    }
    std::fs::create_dir_all(&photos_dir).map_err(|e| e.to_string())?;
    mark_not_indexed(&photos_dir);

    // Page through the photos so the sidecar RPC lock is released between pages,
    // keeping the app responsive (thumbnails keep loading) during populate. A page is
    // held uninterruptibly while the sidecar answers it, so it is kept small: on a cold
    // first run its uncached photos are resolved in one batched lookup — a single links
    // request plus a per-photo name decrypt — and a short page bounds that hold to about
    // two seconds, so waiting thumbnails are admitted between pages. On later runs the
    // sidecar answers a page from cache in milliseconds.
    let mut page = POPULATE_PAGE_MIN;
    let mut offset = 0u64;
    let mut made = 0usize;
    let mut reconciled = 0usize;
    let mut photos_seen: HashSet<String> = HashSet::new();
    // uid -> (sanitized base name, size, filetime), reused to place the same photo
    // inside its albums without a second round of getNode lookups.
    let mut meta: HashMap<String, (String, u64, i64)> = HashMap::new();
    // Every photo uid seen this pass, in order — the baseline for auto-download.
    let mut all_uids: Vec<String> = Vec::new();
    // The favourites, for `Photos\Favorites\`.
    let mut favorites: Vec<(String, String, u64, i64)> = Vec::new();

    loop {
        let asked = std::time::Instant::now();
        let mut result = crate::sidecar_rpc(
            app,
            "listForMount",
            serde_json::json!({ "offset": offset, "limit": page }),
        )?;
        let took = asked.elapsed();
        let items = result.get_mut("items").and_then(|v| v.as_array_mut()).map(std::mem::take).unwrap_or_default();
        let total = result.get("total").and_then(|v| v.as_u64()).unwrap_or(0);
        fill_progress(app, (offset + items.len() as u64).min(total), total);

        for item in &items {
            let uid = item.get("uid").and_then(|v| v.as_str()).unwrap_or_default();
            let size = item.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
            if uid.is_empty() || size == 0 {
                continue;
            }
            let name = item.get("name").and_then(|v| v.as_str()).unwrap_or(uid);
            if item.get("favorite").and_then(|v| v.as_bool()) == Some(true) {
                let ft = unix_ms_to_filetime(item.get("captureTime").and_then(|v| v.as_i64()).unwrap_or(0));
                favorites.push((uid.to_string(), sanitize_name(name), size, ft));
            }
            let ft = unix_ms_to_filetime(item.get("captureTime").and_then(|v| v.as_i64()).unwrap_or(0));
            let base = sanitize_name(name);
            let unique = unique_name(&base, &mut photos_seen);
            meta.insert(uid.to_string(), (base, size, ft));
            size_push(uid, size);
            all_uids.push(uid.to_string());

            let placeholder = PlaceholderFile::new(&unique)
                .mark_in_sync() // it faithfully mirrors the cloud file: in sync, not "pending"
                .metadata(Metadata::file().size(size).creation_time(ft).last_write_time(ft))
                .blob(uid.as_bytes().to_vec());
            let owned = if placeholder.create::<&std::path::Path>(&photos_dir).is_ok() {
                made += 1;
                true
            } else {
                // A copy already sits here; create only fails on a name collision.
                // One of ours from an earlier run is reconciled so it is not stranded
                // on "waiting to sync" and the app still sees it as kept offline. It
                // predates the folder's no-index bit, so it does not inherit it.
                match reconcile_existing(app, &photos_dir.join(&unique), uid, size, ft) {
                    Existing::Adopted => {
                        reconciled += 1;
                        true
                    }
                    Existing::Ours => true,
                    Existing::Foreign => false,
                }
            };
            // Indexed only once this pass established that the path belongs to the
            // mount: either `create` made it, or `reconcile_existing` matched the
            // cloud file byte for byte and adopted it. A collision with a file the
            // user dropped in the folder fails both, and camera names repeat
            // constantly, so this is not a corner case. Indexing it regardless is
            // what let free-up reach it later and convert it into a dehydrated
            // placeholder carrying another photo's uid, throwing away bytes that
            // were never in Proton. The check that refuses to adopt such a file is a
            // few lines up, in `reconcile_existing`; the index must not be a way
            // around it.
            if owned {
                index_push(uid, &format!("Photos\\{unique}"));
            }
            // After the copy exists, either way: a fresh placeholder inherits the
            // folder's bit, but that inheritance is undocumented, and an already
            // downloaded copy predates the folder entirely and would otherwise keep
            // handing its EXIF to the indexer.
            mark_not_indexed(&photos_dir.join(&unique));
        }

        offset += page;
        // Stop once the whole listing has been paged. The end is the slice running out
        // (offset past the total), not an empty page: a page whose photos were all
        // skipped — vanished server-side, or carrying no positive-size revision — is not
        // the end, and keying off `items` being empty would truncate the mount before it.
        if total == 0 || offset >= total {
            break;
        }
        // A page answered from cache is cheap, so the next one is bigger; a cold one
        // is smaller, and is followed by a pause that lets the app's own calls through.
        let (next, pause) = next_populate_page(page, took);
        page = next;
        if !pause.is_zero() {
            std::thread::sleep(pause);
        }
    }
    crate::note(
        app,
        &format!("[cloud] populate: created {made} photo placeholders, reconciled {reconciled} existing"),
    );

    // One subfolder per album, holding placeholders for its photos (the same cloud
    // files, backed by the same uid, hydrated on demand).
    populate_albums(app, &folder.join("Albums"), &meta);
    fill_phase(app, Some("tidy"), 0, 0);
    populate_extras(app, &folder, &favorites);
    publish_index();
    prune_stale(app, &folder, &previous);
    // The index now names copies an earlier run downloaded, which the badge has to show.
    rescan_hydrated();
    // Files put in the folder while the app was closed, or whose upload failed, go up
    // once per session, after the first fill has said what the library already has.
    static WAITING: std::sync::Once = std::sync::Once::new();
    WAITING.call_once(|| {
        let app = app.clone();
        std::thread::spawn(move || crate::explorer_sync::upload_waiting(&app));
    });

    // Photos that arrived since the previous fill, for "New photos only". The snapshot of
    // the fill before is the baseline, and a first fill (no snapshot) only seeds it, so
    // choosing the mode never downloads the library as it already was. Every fill records
    // its arrivals, Sync now and the refresh after an Explorer change included, so none is
    // marked as seen without being kept. The worker downloads them outside this lock, and
    // the snapshot is saved only when this listing returned photos, so an empty one cannot
    // make every photo look new to the next fill.
    if !all_uids.is_empty() {
        if let Some(prev) = load_seen(app) {
            if !prev.is_empty() {
                let arrivals: Vec<String> = all_uids.iter().filter(|uid| !prev.contains(*uid)).cloned().collect();
                crate::keep_all::add_arrivals(app, &arrivals);
            }
        }
        save_seen(app, &all_uids);
        *timeline_order().lock().unwrap() = all_uids.clone();
    }
    crate::keep_all::nudge();
    // Explorer marks set while the app was closed, or lost among too many changes at once.
    sweep_pin_marks(app);

    // Settle the folders' Explorer status (a fresh sync-root folder reads as pending
    // until it is an in-sync placeholder). Done last, after all hydration.
    mark_folders_in_sync(&folder);

    Ok(())
}

/// Create the `Albums\<name>\` subfolders and a placeholder for each album photo,
/// reusing the name/size/time gathered in the main photo pass so no extra network
/// calls are made. Best-effort: a missing album or photo is skipped, not fatal.
#[cfg(windows)]
fn populate_albums(
    app: &tauri::AppHandle,
    albums_dir: &std::path::Path,
    meta: &std::collections::HashMap<String, (String, u64, i64)>,
) {
    use cloud_filter::metadata::{Metadata, MetadataExt};
    use cloud_filter::placeholder_file::PlaceholderFile;
    use std::collections::HashSet;

    // Built aside and put in place only once every page has been read: until then the
    // folder keeps the albums it knew, so a file dropped into an album's folder while the
    // fill runs, or after a page failed, still finds its album instead of making another.
    let mut next_index: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    let mut next_dirs: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut album_dir_seen: HashSet<String> = HashSet::new();
    let mut made = 0usize;
    let mut offset = 0u64;
    // A page of albums at a time, each page a short call, with the count shown as it goes.
    loop {
        let mut page = match crate::sidecar_rpc(
            app,
            "listAlbumsForMount",
            serde_json::json!({ "offset": offset, "limit": ALBUM_PAGE }),
        ) {
            Ok(v) => v,
            Err(e) => {
                crate::note(app, &format!("[cloud] albums skipped: {e}"));
                return;
            }
        };
        let total = page.get("total").and_then(|v| v.as_u64()).unwrap_or(0);
        let albums = page.get_mut("items").and_then(|v| v.as_array_mut()).map(std::mem::take).unwrap_or_default();
        if total == 0 {
            album_index().lock().unwrap().clear();
            album_dirs().lock().unwrap().clear();
            return;
        }
        if offset == 0 {
            fill_phase(app, Some("albums"), 0, total);
            if !albums_dir.exists() {
                crate::explorer_sync::expect_own("Albums");
            }
            let _ = std::fs::create_dir_all(albums_dir);
            mark_not_indexed(albums_dir);
        }
        for album in &albums {
            let album_uid = album.get("uid").and_then(|v| v.as_str()).unwrap_or_default();
            let name = album.get("name").and_then(|v| v.as_str()).unwrap_or("Album");
            let uids: &[serde_json::Value] = album.get("uids").and_then(|v| v.as_array()).map_or(&[], Vec::as_slice);
            if uids.is_empty() {
                continue;
            }
            let dir_name = unique_name(&sanitize_name(name), &mut album_dir_seen);
            let album_folder = albums_dir.join(&dir_name);
            if !album_uid.is_empty() {
                next_dirs.insert(dir_name.to_lowercase(), album_uid.to_string());
            }
            if !album_folder.exists() {
                crate::explorer_sync::expect_own(&format!("Albums\\{dir_name}"));
            }
            if std::fs::create_dir_all(&album_folder).is_err() {
                continue;
            }
            mark_not_indexed(&album_folder);
            let mut file_seen: HashSet<String> = HashSet::new();
            let mut members: Vec<String> = Vec::new();
            for u in uids {
                let Some(uid) = u.as_str() else { continue };
                let Some((base, size, ft)) = meta.get(uid) else { continue };
                let unique = unique_name(base, &mut file_seen);
                let rel = format!("Albums\\{dir_name}\\{unique}");
                let placeholder = PlaceholderFile::new(&unique)
                    .mark_in_sync()
                    .metadata(Metadata::file().size(*size).creation_time(*ft).last_write_time(*ft))
                    .blob(uid.as_bytes().to_vec());
                let owned = if placeholder.create::<&std::path::Path>(&album_folder).is_ok() {
                    made += 1;
                    true
                } else {
                    // A copy already sits here: reconcile it so Explorer shows the green
                    // check instead of "waiting to sync". A cloud-only one needs nothing
                    // doing and is ours all the same, so only a foreign file is excluded.
                    reconcile_existing(app, &album_folder.join(&unique), uid, *size, *ft) != Existing::Foreign
                };
                mark_not_indexed(&album_folder.join(&unique));
                // Indexed only once it belongs to the mount, on the same grounds as the
                // `Photos\` pass: an album copy that was neither created nor adopted is
                // someone else's file with a name that happens to match, and both indexes
                // lead straight to hydrating and dehydrating whatever they list.
                if owned {
                    index_push(uid, &rel);
                    members.push(rel);
                }
            }
            if !album_uid.is_empty() {
                next_index.insert(album_uid.to_string(), members);
            }
        }
        offset += ALBUM_PAGE;
        fill_phase(app, Some("albums"), offset.min(total), total);
        if offset >= total {
            break;
        }
    }
    *album_index().lock().unwrap() = next_index;
    *album_dirs().lock().unwrap() = next_dirs;
    crate::note(app, &format!("[cloud] populate: created {made} album placeholders"));
}

/// Albums asked for in one call while the folder is filled.
#[cfg(windows)]
const ALBUM_PAGE: u64 = 12;

/// Make a file name unique within this populate run (append " (2)", " (3)", ...),
/// so two photos with the same name both land instead of one colliding out.
#[cfg(windows)]
fn unique_name(base: &str, seen: &mut std::collections::HashSet<String>) -> String {
    if seen.insert(base.to_lowercase()) {
        return base.to_string();
    }
    let (stem, ext) = match base.rfind('.') {
        Some(i) if i > 0 => (&base[..i], &base[i..]),
        _ => (base, ""),
    };
    for n in 2..100_000 {
        let candidate = format!("{stem} ({n}){ext}");
        if seen.insert(candidate.to_lowercase()) {
            return candidate;
        }
    }
    base.to_string()
}

/// The outcome of a pin pass: how many copies were kept offline in place, and the
/// selected uids the mount has no placeholder for. Those last cannot be pinned (a
/// photo shared with me, or one that lives only inside an album), so the caller saves
/// them as ordinary files instead rather than reporting them as not downloaded.
#[derive(serde::Serialize)]
pub struct PinResult {
    kept: u32,
    missing: Vec<String>,
}

/// "Download" from the app = keep the selected photos offline: pin their Explorer
/// placeholders, which the OS then hydrates in place (fetch_data downloads them).
/// One entry per photo, ending as a green check — no duplicate file, no "waiting to
/// sync". Runs off the main thread; a uid the mount has no placeholder for is not
/// skipped silently but returned in `missing` for the caller to save another way.
#[tauri::command]
pub async fn pin_selected(app: tauri::AppHandle, uids: Vec<String>) -> PinResult {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            // Keep the mount busy for the whole pin pass so the warmer pauses. Each
            // photo's `ph.hydrate` drives `fetch_data` (which takes the guard again);
            // the counter keeps busy set across the gaps between photos, so it is not
            // cleared early after the first one.
            let _busy = BusyGuard::new(&app);
            let _doing = Doing::new(&app, "offline", None, None);
            let base = sync_root_path();
            // Split the selection into the primary (`Photos\`) copies the mount knows
            // about, each paired with its relative path, and the uids it has no
            // placeholder for. Album copies stay cloud-only until opened, so a download
            // never silently duplicates every album photo on disk. Keeping offline never
            // pins ("always keep"), which is what made "Free up space" fail with
            // 0x8007017B.
            let mut pairs: Vec<(String, String)> = Vec::new();
            let mut missing: Vec<String> = Vec::new();
            {
                let index = mount_index().lock().unwrap();
                for u in &uids {
                    match index.get(u).and_then(|v| v.first()) {
                        Some(rel) => pairs.push((u.clone(), rel.clone())),
                        None => missing.push(u.clone()),
                    }
                }
            }
            crate::note(
                &app,
                &format!("[download] make offline: {} of {} selected found in the mount", pairs.len(), uids.len()),
            );
            crate::keep_all::note_unfreed(&app, &uids);
            let ok = pairs
                .iter()
                .filter(|(uid, rel)| keep_offline_one(&app, &base, rel, Some(uid.as_str())))
                .count() as u32;
            crate::note(
                &app,
                &format!("[download] kept {ok} offline (freeable); {} not in the mount", missing.len()),
            );
            PinResult { kept: ok, missing }
        })
        .await
        .unwrap_or_else(|_| PinResult { kept: 0, missing: Vec::new() })
    }
    #[cfg(not(windows))]
    {
        let _ = &app;
        // No mount on this platform, so nothing pins in place: the whole selection
        // falls through to the save-to-folder path.
        PinResult { kept: 0, missing: uids }
    }
}

/// Free up one copy: back to a cloud-only placeholder, its local bytes dropped. Only a copy
/// that is provably the cloud file's loses its bytes: a placeholder of this photo in sync,
/// which Windows keeps only while nothing but the download wrote to it, or any other copy of
/// this photo once its SHA-1 matches the one its cloud revision records, or, for a revision
/// that records none, once its bytes have been compared with a download of the cloud file. `true` once the local data is gone; a copy that is already cloud-only counts as
/// neither freed nor failed.
#[cfg(windows)]
fn free_up_one(app: &tauri::AppHandle, base: &std::path::Path, uid: &str, rel: &str) -> bool {
    use cloud_filter::ext::FileExt;
    const RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;
    let path = base.join(rel);
    // Skip a copy that is already cloud-only (e.g. an unopened album copy).
    // Attributes only: stat-ing this by opening it would hydrate the very
    // file we are here to free up.
    let Some(entry) = file_attribute_data(&path) else {
        return false;
    };
    if entry.dwFileAttributes & RECALL_ON_DATA_ACCESS != 0 {
        return false;
    }
    let placeholder = identity::read(&path);
    if placeholder.as_ref().is_some_and(|info| !info.is(uid)) {
        // Counts only, no name or uid: enough to see that a copy was passed over.
        crate::note(app, "[freeup] the file at this name is another photo's, left alone");
        return false;
    }
    // Windows refuses to free a copy marked "Always keep on this device"; freeing it here is
    // the user's later word.
    if entry.dwFileAttributes & FILE_ATTRIBUTE_PINNED != 0 {
        clear_pin_mark(&path, false);
    }
    let _own = OwnDehydrate::new(&path);
    if placeholder.as_ref().is_some_and(|info| info.in_sync) {
        // The driver refuses a copy that went out of sync since this was read.
        return std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .is_ok_and(|file| file.dehydrate(..).is_ok());
    }
    // Out of sync, or an ordinary file that lost its placeholder status: what it holds is
    // checked against the cloud file before anything is dropped. A size other than the cloud
    // file's is not that copy, whatever its name says, and needs nothing more to tell. The
    // SHA-1 the cloud revision records is the check; only a revision that records none is
    // downloaded to compare with, and with no answer from Drive the copy stays.
    let on_disk = ((entry.nFileSizeHigh as u64) << 32) | entry.nFileSizeLow as u64;
    if cloud_size(uid) != Some(on_disk) {
        crate::note(app, "[freeup] size does not match the cloud file, left alone");
        return false;
    }
    let digests = crate::sidecar_rpc(app, "mountDigests", serde_json::json!({ "uids": [uid] })).ok();
    let outcome = match verify::free_check(digests.as_ref(), uid) {
        verify::FreeCheck::Digest(sha1) => identity::free_if_digest(&path, uid, &sha1),
        verify::FreeCheck::Download => match free_by_download(app, &path, uid, on_disk) {
            Some(outcome) => outcome,
            None => return false,
        },
        verify::FreeCheck::LeaveAlone => {
            crate::note(app, "[freeup] the cloud file's digest could not be read, left alone");
            return false;
        }
    };
    match outcome {
        identity::Freed::Freed => true,
        identity::Freed::Differs => {
            crate::note(app, "[freeup] changed on this PC, left alone");
            false
        }
        identity::Freed::NotFreed => {
            crate::note(app, "[freeup] could not free a copy that matches the cloud file");
            false
        }
    }
}

/// Frees a copy whose cloud revision records no digest by comparing it with a download of the
/// cloud file. None when the download failed.
#[cfg(windows)]
fn free_by_download(app: &tauri::AppHandle, path: &std::path::Path, uid: &str, on_disk: u64) -> Option<identity::Freed> {
    let (cloud, got) = match crate::hydrate_to_temp(app, uid) {
        Ok(download) => download,
        Err(e) => {
            crate::note(app, &format!("[freeup] could not download the cloud file to compare: {e}"));
            return None;
        }
    };
    let outcome = if got == on_disk { identity::free_if_same(path, uid, &cloud) } else { identity::Freed::Differs };
    let _ = std::fs::remove_file(&cloud);
    Some(outcome)
}

/// App-side "remove download / free up space" for a selection. Returns how many
/// photos are no longer on this device, which is what the caller reports.
/// Off the main thread: a large selection is a long pass.
#[tauri::command]
pub async fn free_up_selected(app: tauri::AppHandle, uids: Vec<String>) -> u32 {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            let base = sync_root_path();
            // Free every copy (the `Photos\` one and each album), paired with its uid so a
            // copy that lost its placeholder status can be converted back with its blob.
            let pairs: Vec<(String, Vec<String>)> = {
                let index = mount_index().lock().unwrap();
                uids.iter().filter_map(|u| index.get(u).map(|r| (u.clone(), r.clone()))).collect()
            };
            let mut ok = 0u32;
            for (uid, rels) in &pairs {
                // Every copy is freed, so no short-circuit; the photo counts once, because
                // the caller counts photos and a photo can hold an album copy per album.
                let mut any = false;
                for rel in rels {
                    if free_up_one(&app, &base, uid, rel) {
                        any = true;
                    }
                }
                if any {
                    ok += 1;
                }
            }
            crate::note(&app, &format!("[freeup] freed {ok}"));
            crate::keep_all::note_freed(&app, &uids);
            rescan_hydrated();
            ok
        })
        .await
        .unwrap_or(0)
    }
    #[cfg(not(windows))]
    {
        let _ = (app, uids);
        0
    }
}

/// The Settings "free up all" action: every local copy in the library, in one pass,
/// so the space can be reclaimed without selecting photos one by one. Nothing is
/// deleted — the photos stay in the cloud and hydrate again on demand. Emits
/// "freeup-progress" (done/total copies) as it goes and returns how many were freed.
/// Off the main thread: a whole-library pass is long.
#[tauri::command]
pub async fn free_up_all(app: tauri::AppHandle) -> u32 {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            use tauri::Emitter;
            let base = sync_root_path();
            // Snapshot the index and drop the lock: the pass is long, and populate needs
            // the lock to refresh placeholders while it runs.
            let pairs: Vec<(String, Vec<String>)> = {
                let index = mount_index().lock().unwrap();
                index.iter().map(|(uid, rels)| (uid.clone(), rels.clone())).collect()
            };
            let total: usize = pairs.iter().map(|(_, rels)| rels.len()).sum();
            let mut done = 0usize;
            let mut freed = 0u32;
            for (uid, rels) in &pairs {
                for rel in rels {
                    if free_up_one(&app, &base, uid, rel) {
                        freed += 1;
                    }
                    done += 1;
                    // Throttled: an event per copy would flood the channel on a big library.
                    if done % 25 == 0 || done == total {
                        let _ = app.emit(
                            "freeup-progress",
                            serde_json::json!({ "done": done, "total": total }),
                        );
                    }
                }
            }
            crate::note(&app, &format!("[freeup] freed {freed} of {total} copies"));
            let uids: Vec<String> = pairs.into_iter().map(|(uid, _)| uid).collect();
            crate::keep_all::freed_everything(&app, &uids);
            rescan_hydrated();
            freed
        })
        .await
        .unwrap_or(0)
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        0
    }
}

// ---- Explorer's "Always keep on this device" and "Free up space" ----

/// The marks Explorer's two menu items leave on a file: "Always keep on this device" pins it,
/// "Free up space" unpins it. Windows acts on neither; the provider does.
const FILE_ATTRIBUTE_PINNED: u32 = 0x0008_0000;
const FILE_ATTRIBUTE_UNPINNED: u32 = 0x0010_0000;

/// What a mark Explorer left on a copy asks of the app.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum PinMark {
    /// Download it and keep it, like the app's Download.
    Keep,
    /// Free it, like the app's Free up.
    Free,
}

/// The mark in a file's attributes, if any. A copy marked both ways is kept, the direction
/// that loses nothing.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn pin_mark(attrs: u32) -> Option<PinMark> {
    if attrs & FILE_ATTRIBUTE_PINNED != 0 {
        Some(PinMark::Keep)
    } else if attrs & FILE_ATTRIBUTE_UNPINNED != 0 {
        Some(PinMark::Free)
    } else {
        None
    }
}

/// Whether a copy Explorer was asked to free may lose its bytes: a placeholder the folder's
/// index knows, carrying this photo's identity, in sync with the cloud file, and the size the
/// cloud file has. A file still waiting to upload is an ordinary file and fails the first
/// test; one changed on this PC since its download is not in sync and fails the third.
#[cfg_attr(not(windows), allow(dead_code))]
fn may_free(placeholder: bool, same_photo: bool, in_sync: bool, on_disk: u64, cloud: Option<u64>) -> bool {
    placeholder && same_photo && in_sync && cloud == Some(on_disk)
}

/// Sets a file's pin mark back to none through a handle that never recalls its data, so a
/// cloud-only copy is not downloaded by being opened. A downloaded file, which no open can
/// recall, may also go through the provider's own handle. True once the mark is gone.
#[cfg(windows)]
fn clear_pin_mark(path: &std::path::Path, dir: bool) -> bool {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::CloudFilters::{CfSetPinState, CF_PIN_STATE_UNSPECIFIED, CF_SET_PIN_FLAG_NONE};
    const FILE_FLAG_OPEN_NO_RECALL: u32 = 0x0010_0000;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;
    let flags = if dir { FILE_FLAG_OPEN_NO_RECALL | FILE_FLAG_BACKUP_SEMANTICS } else { FILE_FLAG_OPEN_NO_RECALL };
    let cleared = std::fs::OpenOptions::new().read(true).custom_flags(flags).open(path).is_ok_and(|file| {
        unsafe { CfSetPinState(HANDLE(file.as_raw_handle() as _), CF_PIN_STATE_UNSPECIFIED, CF_SET_PIN_FLAG_NONE, None) }
            .is_ok()
    });
    if cleared || dir || file_attributes(path).is_none_or(|a| a & RECALL_ON_DATA_ACCESS != 0) {
        return cleared;
    }
    use cloud_filter::placeholder::{OpenOptions, PinOptions, PinState};
    OpenOptions::new()
        .write_access()
        .open(path)
        .is_ok_and(|mut ph| ph.mark_pin(PinState::Unspecified, PinOptions::default()).is_ok())
}

/// Copies whose pin mark changed, waiting for the worker, and whether every copy is to be
/// looked over.
#[cfg(windows)]
#[derive(Default)]
struct PinMarks {
    rels: std::collections::BTreeSet<String>,
    sweep: bool,
}

#[cfg(windows)]
fn pin_marks() -> &'static (std::sync::Mutex<PinMarks>, std::sync::Condvar) {
    static MARKS: std::sync::OnceLock<(std::sync::Mutex<PinMarks>, std::sync::Condvar)> = std::sync::OnceLock::new();
    MARKS.get_or_init(Default::default)
}

/// A path in the folder whose pin mark changed, from the folder's watcher.
#[cfg(windows)]
pub(crate) fn pin_mark_changed(app: &tauri::AppHandle, rel: String) {
    let (marks, wake) = pin_marks();
    marks.lock().unwrap().rels.insert(rel);
    wake.notify_one();
    start_pin_worker(app);
}

/// Looks over every copy the folder's index knows for a mark not acted on yet: one set while
/// the app was closed, or one the watcher missed among too many changes at once.
#[cfg(windows)]
fn sweep_pin_marks(app: &tauri::AppHandle) {
    let (marks, wake) = pin_marks();
    marks.lock().unwrap().sweep = true;
    wake.notify_one();
    start_pin_worker(app);
}

/// One thread, started once, so a download or a free up never holds up the watcher.
#[cfg(windows)]
fn start_pin_worker(app: &tauri::AppHandle) {
    static STARTED: std::sync::Once = std::sync::Once::new();
    STARTED.call_once(|| {
        let app = app.clone();
        std::thread::spawn(move || loop {
            let (rels, sweep) = {
                let (marks, wake) = pin_marks();
                let mut m = wake.wait_while(marks.lock().unwrap(), |m| m.rels.is_empty() && !m.sweep).unwrap();
                (std::mem::take(&mut m.rels), std::mem::replace(&mut m.sweep, false))
            };
            // A fill rebuilds the index the copies are found in; act once it is done.
            drop(populate_lock());
            apply_pin_marks(&app, rels, sweep);
        });
    });
}

/// Downloads the copies marked to keep and frees the ones marked to free, through the same
/// steps as the app's Download and Free up. Only the copies of the library's photos the
/// folder's index knows are touched; any other file keeps its mark and its bytes.
#[cfg(windows)]
fn apply_pin_marks(app: &tauri::AppHandle, mut rels: std::collections::BTreeSet<String>, sweep: bool) {
    const RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;
    const DIRECTORY: u32 = 0x10;
    if detaching() || !show_in_explorer_enabled() || !sync_root_available() {
        return;
    }
    let base = sync_root_path();
    let index = photos_by_path();
    if sweep {
        for rel in index.keys() {
            let waiting = match file_attributes(&base.join(rel)).and_then(|a| pin_mark(a).map(|m| (a, m))) {
                Some((a, PinMark::Keep)) => a & RECALL_ON_DATA_ACCESS != 0,
                Some((_, PinMark::Free)) => true,
                None => false,
            };
            if waiting {
                rels.insert(rel.clone());
            }
        }
    }
    let mut acted = false;
    for rel in rels {
        let path = base.join(&rel);
        let Some(entry) = file_attribute_data(&path) else { continue };
        let attrs = entry.dwFileAttributes;
        let Some(mark) = pin_mark(attrs) else { continue };
        if attrs & DIRECTORY != 0 {
            // Explorer marks every file beneath a folder itself. A folder freed keeps no mark
            // of its own, so the photos a later fill puts in it are not taken as freed too.
            if mark == PinMark::Free {
                clear_pin_mark(&path, true);
            }
            continue;
        }
        let Some(uid) = index.get(&rel.to_lowercase()) else { continue };
        acted = true;
        match mark {
            PinMark::Keep => keep_marked(app, &base, &rel, uid, attrs),
            PinMark::Free => free_marked(app, &base, &rel, uid, &entry),
        }
    }
    if acted {
        rescan_hydrated();
    }
}

/// "Always keep on this device": the user asked to keep the photo, as the app's Download does.
/// The mark stays, so Windows never frees the copy by itself.
#[cfg(windows)]
fn keep_marked(app: &tauri::AppHandle, base: &std::path::Path, rel: &str, uid: &str, attrs: u32) {
    const RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;
    const REPARSE_POINT: u32 = 0x400;
    if crate::keep_all::freed_copy(rel, timeline_rel(uid).as_deref()) == crate::keep_all::FreedCopy::Timeline {
        crate::keep_all::note_unfreed(app, &[uid.to_string()]);
    }
    if attrs & RECALL_ON_DATA_ACCESS == 0 || attrs & REPARSE_POINT == 0 {
        return;
    }
    if keep_offline_one(app, base, rel, Some(uid)) {
        mark_hydrated(uid, true);
        crate::note(app, "[explorer] always keep: downloaded");
    } else {
        crate::note(app, "[explorer] always keep: download failed");
    }
}

/// "Free up space": frees the copy as the app's Free up does and records it the same way, an
/// album's copy as an album's. A copy that is not exactly the cloud file's keeps its bytes.
#[cfg(windows)]
fn free_marked(
    app: &tauri::AppHandle,
    base: &std::path::Path,
    rel: &str,
    uid: &str,
    entry: &windows::Win32::Storage::FileSystem::WIN32_FILE_ATTRIBUTE_DATA,
) {
    const RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;
    const REPARSE_POINT: u32 = 0x400;
    let path = base.join(rel);
    let attrs = entry.dwFileAttributes;
    let local = attrs & RECALL_ON_DATA_ACCESS == 0;
    if local {
        let on_disk = ((entry.nFileSizeHigh as u64) << 32) | entry.nFileSizeLow as u64;
        let (in_sync, same_photo) = placeholder_state(&path, uid);
        if !may_free(attrs & REPARSE_POINT != 0, same_photo, in_sync, on_disk, cloud_size(uid)) {
            crate::note(app, "[explorer] free up space: the copy is not the cloud file as it is, left alone");
            clear_pin_mark(&path, false);
            return;
        }
    }
    // The mark goes first: a copy left marked would be freed again each time it is opened.
    clear_pin_mark(&path, false);
    if local {
        if !free_up_one(app, base, uid, rel) {
            crate::note(app, "[explorer] free up space: could not free the copy");
            return;
        }
        mark_hydrated(uid, false);
        crate::note(app, "[explorer] free up space: freed");
    }
    let copy = crate::keep_all::freed_copy(rel, timeline_rel(uid).as_deref());
    crate::keep_all::note_copy_freed(app, &[uid.to_string()], copy);
}

/// Whether a downloaded copy is in sync with the cloud file, and whether it carries this
/// photo's identity, read through a handle that downloads nothing.
#[cfg(windows)]
fn placeholder_state(path: &std::path::Path, uid: &str) -> (bool, bool) {
    identity::read(path).map_or((false, false), |info| (info.in_sync, info.is(uid)))
}

/// The uids whose placeholder is hydrated (kept offline, "available on this
/// device"), so the app can badge them. A dehydrated cloud-only placeholder carries
/// RECALL_ON_DATA_ACCESS; that flag is cleared once it is hydrated.
/// What `hydrated_uids` hands the grid: the version of the answer, and the photos with a
/// copy on this device only when that version is not the one the caller already has.
#[derive(serde::Serialize)]
pub struct HydratedAnswer {
    version: u64,
    uids: Option<Vec<String>>,
}

/// Which photos have a copy on this device, for the grid's badge.
///
/// Answered from the background scanner's last result, never by scanning here: a scan
/// reads the directory entry of every placeholder, which on a large library takes
/// seconds, and this is asked every few seconds. `since` is the version the caller
/// already holds; the list itself is sent only when it has changed.
#[tauri::command]
pub async fn hydrated_uids(since: Option<u64>) -> HydratedAnswer {
    #[cfg(windows)]
    {
        let (state, _) = hydrated_state();
        let st = state.lock().unwrap();
        HydratedAnswer {
            version: st.version,
            uids: (since != Some(st.version)).then(|| st.uids.iter().cloned().collect()),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = since;
        HydratedAnswer { version: 0, uids: None }
    }
}

/// The scanner's last answer. `version` moves whenever the set changes, and
/// `requested` asks for a scan sooner than the next scheduled one.
#[cfg(windows)]
struct HydratedState {
    version: u64,
    uids: std::collections::BTreeSet<String>,
    requested: bool,
}

#[cfg(windows)]
static HYDRATED: std::sync::OnceLock<(std::sync::Mutex<HydratedState>, std::sync::Condvar)> =
    std::sync::OnceLock::new();

#[cfg(windows)]
fn hydrated_state() -> &'static (std::sync::Mutex<HydratedState>, std::sync::Condvar) {
    HYDRATED.get_or_init(|| {
        (
            std::sync::Mutex::new(HydratedState {
                version: 0,
                uids: std::collections::BTreeSet::new(),
                requested: false,
            }),
            std::sync::Condvar::new(),
        )
    })
}

/// Record what this process just did to one photo's copy, so the badge follows a
/// download or a free-up at once instead of at the next scan.
#[cfg(windows)]
fn mark_hydrated(uid: &str, local: bool) {
    let (state, _) = hydrated_state();
    let mut st = state.lock().unwrap();
    let changed = if local { st.uids.insert(uid.to_string()) } else { st.uids.remove(uid) };
    // The grid fetches the whole set again whenever the version moves, so a download of the
    // pass that keeps every photo moves it every few dozen photos (`bump_hydrated_version`),
    // not with each one. A photo the user opened meanwhile still shows at once.
    if changed && !crate::keep_all::in_pass(uid) {
        st.version += 1;
    }
}

/// Tells the grid that more photos are on this PC, after a batch the pass downloaded.
#[cfg(windows)]
pub(crate) fn bump_hydrated_version() {
    let (state, _) = hydrated_state();
    state.lock().unwrap().version += 1;
}

/// Ask for a full scan soon: after a pass that may have changed many copies at once.
#[cfg(windows)]
pub(crate) fn rescan_hydrated() {
    let (state, wake) = hydrated_state();
    state.lock().unwrap().requested = true;
    wake.notify_one();
}

/// Every photo with at least one hydrated copy, read from the directory entries. The
/// index is copied out first, so its lock is held for a copy and not for the scan.
#[cfg(windows)]
fn scan_hydrated() -> std::collections::BTreeSet<String> {
    let base = sync_root_path();
    let snapshot: Vec<(String, Vec<String>)> = mount_index()
        .lock()
        .unwrap()
        .iter()
        .map(|(uid, rels)| (uid.clone(), rels.clone()))
        .collect();
    snapshot
        .into_iter()
        .filter(|(_, rels)| rels.iter().any(|rel| is_hydrated(&base, rel)))
        .map(|(uid, _)| uid)
        .collect()
}

/// How long to rest after a scan that took `took`: a scan never takes more than a
/// fifth of the time, and runs at most every 15 s and at least every 2 minutes.
#[cfg(windows)]
fn scan_pause(took: std::time::Duration) -> std::time::Duration {
    (took * 5).clamp(std::time::Duration::from_secs(15), std::time::Duration::from_secs(120))
}

/// Keeps `HYDRATED` true to the disk, for what Explorer does without telling the app
/// (a file opened there, or freed through the shell). One thread, started once.
#[cfg(windows)]
fn start_hydrated_scanner() {
    static STARTED: std::sync::Once = std::sync::Once::new();
    STARTED.call_once(|| {
        std::thread::spawn(|| loop {
            let started = std::time::Instant::now();
            let found = scan_hydrated();
            let took = started.elapsed();
            let (state, wake) = hydrated_state();
            let mut st = state.lock().unwrap();
            if st.uids != found {
                st.uids = found;
                st.version += 1;
            }
            st.requested = false;
            // A request cuts the rest short, but never below two seconds, so a burst
            // of downloads asks for one scan rather than one each.
            let rest = scan_pause(took);
            let deadline = std::time::Instant::now() + rest;
            let floor = std::time::Instant::now() + std::time::Duration::from_secs(2);
            loop {
                let now = std::time::Instant::now();
                if now >= deadline || (st.requested && now >= floor) {
                    break;
                }
                let wait = if st.requested { floor - now } else { deadline - now };
                st = wake.wait_timeout(st, wait).unwrap().0;
            }
        });
    });
}

/// Opens File Explorer on a photo's copy in the Proton Photos folder, with it selected.
///
/// The path comes from the mount's own index, never from the caller: the renderer
/// names a photo by its uid and can make this open nothing outside the sync root. A
/// hydrated copy is preferred, since that is the one the user has on this device.
/// Selecting a placeholder in Explorer reads its directory entry and never its data.
#[tauri::command]
pub fn reveal_photo(uid: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        let base = sync_root_path();
        let rel = {
            let index = mount_index().lock().unwrap();
            let rels = index.get(&uid).ok_or("This photo is not in the Proton Photos folder.")?;
            rels.iter()
                .find(|rel| is_hydrated(&base, rel))
                .or_else(|| rels.first())
                .cloned()
                .ok_or("This photo is not in the Proton Photos folder.")?
        };
        let path = base.join(rel);
        // `/select,` takes the path quoted as one piece, which the default argument
        // quoting does not produce. A Windows file name can never hold a quote itself.
        std::process::Command::new("explorer.exe")
            .raw_arg(format!("/select,\"{}\"", path.display()))
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = uid;
        Err("Not available on this system.".into())
    }
}

#[cfg(windows)]
#[cfg(test)]
mod identity_on_disk_tests {
    use super::identity::{self, Freed};
    use cloud_filter::error::{CResult, CloudErrorKind};
    use cloud_filter::filter::{info, ticket, Request, SyncFilter};
    use cloud_filter::metadata::Metadata;
    use cloud_filter::placeholder::{ConvertOptions, Placeholder};
    use cloud_filter::placeholder_file::PlaceholderFile;
    use cloud_filter::root::{SecurityId, Session, SyncRootIdBuilder};
    use std::io::Write;

    /// A provider that downloads nothing and lets every free-up through.
    struct Provider;

    impl SyncFilter for Provider {
        fn fetch_data(&self, _: Request, _: ticket::FetchData, _: info::FetchData) -> CResult<()> {
            Err(CloudErrorKind::NotSupported)
        }

        fn dehydrate(&self, _: Request, ticket: ticket::Dehydrate, _: info::Dehydrate) -> CResult<()> {
            ticket.pass().map_err(|_| CloudErrorKind::Unsuccessful)
        }
    }

    const UID: &str = "volume-of-the-photos~the-photo-link-id==";
    const CLOUD: &[u8] = b"cloud bytes";

    fn cloud_only(path: &std::path::Path) -> bool {
        super::file_attributes(path).is_some_and(|a| a & 0x0040_0000 != 0)
    }

    fn in_sync_copy(path: &std::path::Path, bytes: &[u8]) {
        std::fs::write(path, bytes).unwrap();
        let mut placeholder: Placeholder = std::fs::OpenOptions::new().write(true).open(path).unwrap().into();
        placeholder.convert_to_placeholder(ConvertOptions::default().mark_in_sync().blob(UID.as_bytes().to_vec()), None).unwrap();
    }

    /// Registers a throwaway sync root under another name, so it is run by hand only:
    /// `cargo test --lib identity_on_disk_tests -- --ignored`.
    #[test]
    #[ignore]
    fn identities_and_frees_follow_what_the_files_hold() {
        let root = std::env::temp_dir().join(format!("pfp-identity-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let id = SyncRootIdBuilder::new("PfpIdentityTest").user_security_id(SecurityId::current_user().unwrap()).build();
        super::register_with_insync_policy(&id, &root, r"%SystemRoot%\system32\shell32.dll,0").unwrap();
        let connection = Session::new().connect(&root, Provider).unwrap();
        let cloud_file = std::env::temp_dir().join(format!("pfp-identity-cloud-{}.bin", std::process::id()));
        std::fs::write(&cloud_file, CLOUD).unwrap();

        // A cloud-only placeholder: its whole identity reads back, nothing is downloaded, and
        // it takes another photo's identity, size and times in place.
        PlaceholderFile::new("cloud.jpg")
            .mark_in_sync()
            .metadata(Metadata::file().size(5))
            .blob(b"volume~photo-a".to_vec())
            .create::<&std::path::Path>(&root)
            .unwrap();
        let cloud = root.join("cloud.jpg");
        let before = identity::read(&cloud).unwrap();
        let retargeted = identity::retarget_cloud_only(&cloud, UID, 11, 133_000_000_000_000_000);
        let after = identity::read(&cloud).unwrap();
        let cloud_size = super::file_attribute_data(&cloud).map(|d| d.nFileSizeLow);
        let still_cloud_only = cloud_only(&cloud);

        // Copies holding data: one edited here, one out of sync without a change, another
        // photo's, and plain files with the cloud file's bytes and with a same-size edit.
        let (edited, stuck, other, plain, plain_edited, fresh, fresh_changed) = (
            root.join("edited.jpg"),
            root.join("stuck.jpg"),
            root.join("other.jpg"),
            root.join("plain.jpg"),
            root.join("plain-edited.jpg"),
            root.join("fresh.jpg"),
            root.join("fresh-changed.jpg"),
        );
        in_sync_copy(&edited, CLOUD);
        in_sync_copy(&stuck, CLOUD);
        std::fs::OpenOptions::new().write(true).open(&edited).unwrap().write_all(b"CHANGED").unwrap();
        let edited_in_sync = identity::read(&edited).unwrap().in_sync;
        cloud_filter::placeholder::OpenOptions::new().write_access().open(&stuck).unwrap().mark_in_sync(false, None).unwrap();
        std::fs::write(&other, CLOUD).unwrap();
        let mut placeholder: Placeholder = std::fs::OpenOptions::new().write(true).open(&other).unwrap().into();
        placeholder.convert_to_placeholder(ConvertOptions::default().blob(b"volume~photo-b".to_vec()), None).unwrap();
        drop(placeholder);
        std::fs::write(&plain, CLOUD).unwrap();
        std::fs::write(&plain_edited, b"cloud bytEs").unwrap();

        let retarget_with_data = identity::retarget_cloud_only(&stuck, UID, 11, 0);
        let freed_edited = identity::free_if_same(&edited, UID, &cloud_file);
        let freed_stuck = identity::free_if_same(&stuck, UID, &cloud_file);
        let freed_other = identity::free_if_same(&other, UID, &cloud_file);
        let freed_plain = identity::free_if_same(&plain, UID, &cloud_file);
        let freed_plain_edited = identity::free_if_same(&plain_edited, UID, &cloud_file);
        let plain_now = identity::read(&plain);

        // A copy a download just wrote, out of sync: marked only while it holds those bytes.
        for path in [&fresh, &fresh_changed] {
            std::fs::write(path, CLOUD).unwrap();
            super::convert_file_to_placeholder(path, UID).unwrap();
        }
        let converted_in_sync = identity::read(&fresh).unwrap().in_sync;
        let mut written = identity::Digest::default();
        written.add(CLOUD);
        std::fs::OpenOptions::new().write(true).open(&fresh_changed).unwrap().write_all(b"C").unwrap();
        let marked_fresh = identity::mark_in_sync_if_same(&fresh, written.finish());
        let marked_changed = identity::mark_in_sync_if_same(&fresh_changed, written.finish());
        let fresh_in_sync = identity::read(&fresh).unwrap().in_sync;
        let changed_in_sync = identity::read(&fresh_changed).unwrap().in_sync;

        // Copies checked against the SHA-1 the cloud revision records: an out-of-sync copy that
        // holds it, a same-size edit, another photo's, one checked against no whole digest,
        // and frees by the digest of a placeholder, a plain file and a same-size edit.
        let sha1: String = identity::sha1_of(CLOUD).unwrap().iter().map(|b| format!("{b:02x}")).collect();
        let (by_digest, by_digest_edited, by_digest_other, no_digest) = (
            root.join("by-digest.jpg"),
            root.join("by-digest-edited.jpg"),
            root.join("by-digest-other.jpg"),
            root.join("no-digest.jpg"),
        );
        let (free_digest, free_digest_plain, free_digest_edited) =
            (root.join("free-digest.jpg"), root.join("free-digest-plain.jpg"), root.join("free-digest-edited.jpg"));
        for (path, bytes) in [
            (&by_digest, CLOUD),
            (&by_digest_edited, b"cloud bytEs".as_slice()),
            (&no_digest, CLOUD),
            (&free_digest, CLOUD),
        ] {
            std::fs::write(path, bytes).unwrap();
            super::convert_file_to_placeholder(path, UID).unwrap();
        }
        std::fs::write(&by_digest_other, CLOUD).unwrap();
        let mut placeholder: Placeholder = std::fs::OpenOptions::new().write(true).open(&by_digest_other).unwrap().into();
        placeholder.convert_to_placeholder(ConvertOptions::default().blob(b"volume~photo-b".to_vec()), None).unwrap();
        drop(placeholder);
        std::fs::write(&free_digest_plain, CLOUD).unwrap();
        std::fs::write(&free_digest_edited, b"cloud bytEs").unwrap();

        let checked = identity::mark_in_sync_if_digest(&by_digest, UID, &sha1.to_uppercase());
        let checked_edited = identity::mark_in_sync_if_digest(&by_digest_edited, UID, &sha1);
        let checked_other = identity::mark_in_sync_if_digest(&by_digest_other, UID, &sha1);
        let checked_no_digest = identity::mark_in_sync_if_digest(&no_digest, UID, "");
        let digest_in_sync: Vec<bool> = [&by_digest, &by_digest_edited, &by_digest_other, &no_digest]
            .iter()
            .map(|p| identity::read(p).is_some_and(|info| info.in_sync))
            .collect();
        let freed_by_digest = identity::free_if_digest(&free_digest, UID, &sha1);
        let freed_by_digest_plain = identity::free_if_digest(&free_digest_plain, UID, &sha1);
        let freed_by_digest_edited = identity::free_if_digest(&free_digest_edited, UID, &sha1);
        let digest_cloud_only = [cloud_only(&free_digest), cloud_only(&free_digest_plain), cloud_only(&free_digest_edited)];
        let digest_plain_now = identity::read(&free_digest_plain);

        let contents: Vec<Vec<u8>> = [&edited, &other, &plain_edited, &fresh_changed, &by_digest_edited, &free_digest_edited]
            .iter()
            .map(|p| std::fs::read(p).unwrap_or_default())
            .collect();
        let (stuck_cloud_only, plain_cloud_only) = (cloud_only(&stuck), cloud_only(&plain));
        drop(connection);
        let _ = id.unregister();
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_file(&cloud_file);

        assert_eq!(before.identity, b"volume~photo-a");
        assert_eq!(before.on_disk, 0);
        assert!(retargeted.is_ok(), "{retargeted:?}");
        assert!(after.is(UID));
        assert!(after.in_sync);
        assert_eq!(cloud_size, Some(11));
        assert!(still_cloud_only, "looking at or retargeting a cloud-only copy downloaded it");

        assert!(!edited_in_sync, "an edit here left the copy in sync");
        assert!(retarget_with_data.is_err());
        assert_eq!(freed_edited, Freed::Differs, "a copy changed here was freed");
        assert_eq!(freed_stuck, Freed::Freed);
        assert!(stuck_cloud_only);
        assert_eq!(freed_other, Freed::Differs, "another photo's copy was freed");
        assert_eq!(freed_plain, Freed::Freed);
        assert!(plain_cloud_only);
        assert!(plain_now.is_some_and(|info| info.is(UID)));
        assert_eq!(freed_plain_edited, Freed::Differs, "a same-size edit was freed");

        assert!(!converted_in_sync);
        assert_eq!(marked_fresh, Ok(true));
        assert!(fresh_in_sync);
        assert_eq!(marked_changed, Ok(false));
        assert!(!changed_in_sync);
        assert_eq!(contents[0], b"CHANGEDytes");
        assert_eq!(contents[1], CLOUD);
        assert_eq!(contents[2], b"cloud bytEs");
        assert_eq!(contents[3], b"Cloud bytes");

        assert_eq!(checked, identity::Checked::InSync);
        assert_eq!(checked_edited, identity::Checked::Differs, "a same-size edit matched the digest");
        assert_eq!(checked_other, identity::Checked::NotChecked);
        assert_eq!(checked_no_digest, identity::Checked::Differs);
        assert_eq!(digest_in_sync, [true, false, false, false], "only the copy that holds the digest is in sync");
        assert_eq!(freed_by_digest, Freed::Freed);
        assert_eq!(freed_by_digest_plain, Freed::Freed);
        assert!(digest_plain_now.is_some_and(|info| info.is(UID)));
        assert_eq!(freed_by_digest_edited, Freed::Differs, "a same-size edit was freed by the digest");
        assert_eq!(digest_cloud_only, [true, true, false]);
        assert_eq!(contents[4], b"cloud bytEs");
        assert_eq!(contents[5], b"cloud bytEs");
    }
}

#[cfg(test)]
mod pin_mark_tests {
    use super::{may_free, pin_mark, PinMark, FILE_ATTRIBUTE_PINNED, FILE_ATTRIBUTE_UNPINNED};

    #[test]
    fn explorers_two_menu_items_read_as_keep_and_free() {
        const ARCHIVE: u32 = 0x20;
        assert_eq!(pin_mark(ARCHIVE | FILE_ATTRIBUTE_PINNED), Some(PinMark::Keep));
        assert_eq!(pin_mark(ARCHIVE | FILE_ATTRIBUTE_UNPINNED), Some(PinMark::Free));
        assert_eq!(pin_mark(ARCHIVE), None);
        // Marked both ways, the copy is kept.
        assert_eq!(pin_mark(FILE_ATTRIBUTE_PINNED | FILE_ATTRIBUTE_UNPINNED), Some(PinMark::Keep));
    }

    #[test]
    fn only_a_confirmed_copy_of_the_cloud_file_is_freed() {
        assert!(may_free(true, true, true, 100, Some(100)));
        // An ordinary file, such as one still waiting to upload.
        assert!(!may_free(false, true, true, 100, Some(100)));
        // Another photo's identity.
        assert!(!may_free(true, false, true, 100, Some(100)));
        // Changed on this PC since it was downloaded.
        assert!(!may_free(true, true, false, 100, Some(100)));
        // Not the size the cloud file has, or no size known for it.
        assert!(!may_free(true, true, true, 99, Some(100)));
        assert!(!may_free(true, true, true, 100, None));
    }
}

#[cfg(test)]
mod populate_page_tests {
    use super::{next_populate_page, POPULATE_PAGE_MAX, POPULATE_PAGE_MIN};
    use std::time::Duration;

    #[test]
    fn cached_pages_grow_to_the_cap_without_a_pause() {
        let mut page = POPULATE_PAGE_MIN;
        for _ in 0..10 {
            let (next, pause) = next_populate_page(page, Duration::from_millis(5));
            assert!(pause.is_zero());
            page = next;
        }
        assert_eq!(page, POPULATE_PAGE_MAX);
    }

    #[test]
    fn slow_pages_shrink_to_the_floor_and_rest() {
        let (next, pause) = next_populate_page(POPULATE_PAGE_MAX, Duration::from_secs(3));
        assert_eq!(next, POPULATE_PAGE_MAX / 2);
        assert!(!pause.is_zero());
        let (next, _) = next_populate_page(POPULATE_PAGE_MIN, Duration::from_secs(3));
        assert_eq!(next, POPULATE_PAGE_MIN);
    }

    /// 200 000 photos from cache: the page count is what decides how long it takes.
    #[test]
    fn a_large_cached_library_takes_a_thousand_pages_not_fifty_thousand() {
        let (mut page, mut offset, mut pages) = (POPULATE_PAGE_MIN, 0u64, 0u32);
        while offset < 200_000 {
            offset += page;
            pages += 1;
            page = next_populate_page(page, Duration::from_millis(20)).0;
        }
        assert!(pages < 1_010, "{pages} pages");
    }
}

#[cfg(all(test, windows))]
mod fill_gate_tests {
    use super::{claim_page_fill, filled, forget_fills};

    /// After a sign-out the next account's first page load fills the emptied folder at
    /// once; without it the folder stayed empty until the previous fill was 15 minutes old.
    #[test]
    fn a_sign_out_lets_the_next_page_load_fill_at_once() {
        forget_fills();
        assert_eq!(claim_page_fill(), Some(true), "the run's first fill goes ahead and shows");
        filled();
        assert_eq!(claim_page_fill(), None, "a fresh fill stands");
        forget_fills();
        assert_eq!(claim_page_fill(), Some(true), "after a sign-out it is a first fill again");
    }
}

#[cfg(all(test, windows))]
mod hydrated_scan_tests {
    use super::scan_pause;
    use std::time::Duration;

    /// A scan never takes more than a fifth of the time, however large the library.
    #[test]
    fn the_rest_after_a_scan_follows_how_long_it_took() {
        assert_eq!(scan_pause(Duration::from_millis(30)), Duration::from_secs(15));
        assert_eq!(scan_pause(Duration::from_secs(10)), Duration::from_secs(50));
        assert_eq!(scan_pause(Duration::from_secs(60)), Duration::from_secs(120));
    }
}

#[cfg(all(test, windows))]
mod uid_list_tests {
    use super::looks_like_uid_list;

    /// One uid as the mount stores it: two base64url halves joined by a tilde.
    const UID: &str = "aGVsbG8gd29ybGQgdGhpcyBpcyBub3QgcmVhbGx5IGE=~dWlkIGJ1dCBpdCBpcyB0aGUgcmlnaHQgc2hhcGU=";

    #[test]
    fn a_plain_list_is_recognised() {
        assert!(looks_like_uid_list(""));
        assert!(looks_like_uid_list(UID));
        assert!(looks_like_uid_list(&format!("{UID}\n{UID}\n")));
        assert!(looks_like_uid_list(&format!("{UID}\r\n{UID}")), "CRLF is still a list");
    }

    #[test]
    fn anything_else_is_not_a_list() {
        // What matters is the direction of the mistake: read as a list, a file of
        // rubbish becomes an auto-download baseline that makes every photo in the
        // account look new.
        assert!(!looks_like_uid_list("\u{1}\u{2}\u{3}"), "control bytes are not a uid");
        assert!(!looks_like_uid_list("{\"seen\":[]}"), "nor is anything punctuated");
        assert!(!looks_like_uid_list("two words"), "nor is prose");
    }
}

#[cfg(all(test, windows))]
mod index_build_tests {
    use super::*;

    #[test]
    fn readers_see_the_whole_previous_index_until_the_new_one_is_complete() {
        *mount_index().lock().unwrap() = [("v~old".to_string(), vec!["Photos\\old.jpg".to_string()])].into();
        *mount_sizes().lock().unwrap() = [("v~old".to_string(), 5)].into();
        begin_index();
        index_push("v~new", "Photos\\new.jpg");
        size_push("v~new", 7);
        // Part way through a fill: Free up and the watcher still see the previous fill whole.
        assert_eq!(rel_to_uid().get("Photos\\old.jpg").map(String::as_str), Some("v~old"));
        assert!(!rel_to_uid().contains_key("Photos\\new.jpg"));
        assert_eq!(cloud_size("v~old"), Some(5));
        assert_eq!(cloud_size("v~new"), None);

        publish_index();
        assert!(mount_index().lock().unwrap().get("v~old").is_none());
        assert_eq!(mount_index().lock().unwrap().get("v~new"), Some(&vec!["Photos\\new.jpg".to_string()]));
        assert_eq!(cloud_size("v~new"), Some(7));
        assert_eq!(cloud_size("v~old"), None);

        // Outside a fill nothing is recorded, and a fill the sign-out let go of publishes nothing.
        index_push("v~stray", "Photos\\stray.jpg");
        begin_index();
        index_push("v~gone", "Photos\\gone.jpg");
        *NEXT_INDEX.lock().unwrap() = None;
        publish_index();
        let index = mount_index().lock().unwrap().clone();
        assert_eq!(index.keys().cloned().collect::<Vec<_>>(), vec!["v~new".to_string()]);
        mount_index().lock().unwrap().clear();
        mount_sizes().lock().unwrap().clear();
    }
}

#[cfg(all(test, windows))]
mod name_tests {
    use super::sanitize_name;

    #[test]
    fn a_device_name_never_becomes_a_placeholder() {
        assert_eq!(sanitize_name("NUL.jpg"), "_NUL.jpg");
        assert_eq!(sanitize_name("com1"), "_com1");
        assert_eq!(sanitize_name("Lpt9.mp4"), "_Lpt9.mp4");
        // Only the exact device stems: these are ordinary names.
        assert_eq!(sanitize_name("CONCERT.jpg"), "CONCERT.jpg");
        assert_eq!(sanitize_name("COM10.jpg"), "COM10.jpg");
        assert_eq!(sanitize_name("COM0.jpg"), "COM0.jpg");
    }
}

/// What the local copies cost, for the Settings storage panel.
#[derive(Default, serde::Serialize)]
pub struct LocalUsage {
    bytes: u64,
    photos: usize,
}

/// Measure the library's footprint on this device. Every hydrated copy counts — the
/// `Photos\` one and each album's — because each holds its own bytes and a free-up
/// drops all of them; a photo with any copy here counts once. Off the main thread:
/// it is one directory-entry read per placeholder, and a large library has many.
#[tauri::command]
pub async fn local_usage() -> LocalUsage {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(|| {
            let base = sync_root_path();
            // Snapshot the index and drop the lock; populate must not wait behind this.
            let all: Vec<Vec<String>> = mount_index().lock().unwrap().values().cloned().collect();
            let mut usage = LocalUsage::default();
            for rels in &all {
                let mut bytes = 0u64;
                let mut local = false;
                for rel in rels {
                    if let Some(n) = hydrated_size(&base, rel) {
                        bytes += n;
                        local = true;
                    }
                }
                if local {
                    usage.bytes += bytes;
                    usage.photos += 1;
                }
            }
            usage
        })
        .await
        .unwrap_or_default()
    }
    #[cfg(not(windows))]
    LocalUsage::default()
}
