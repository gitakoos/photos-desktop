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

const FOLDER_NAME: &str = "Proton Photos";

/// `%USERPROFILE%\Proton Photos` — a stable, top-level per-user location, the same
/// pattern OneDrive uses for its own folder.
pub fn sync_root_path() -> PathBuf {
    PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default()).join(FOLDER_NAME)
}

/// Create the folder if it is missing. Cheap and idempotent; safe on every launch.
pub fn ensure_folder() {
    let _ = std::fs::create_dir_all(sync_root_path());
}

#[cfg(windows)]
const PREF_KEY: &str = "Software\\PhotosForProton";
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

#[cfg(windows)]
const AUTO_DL_VALUE: &str = "AutoDownload";

/// Whether photos newly added to the library are automatically kept on this
/// device. Default OFF. Read during populate to hydrate the fresh arrivals.
#[cfg(windows)]
pub fn auto_download_enabled() -> bool {
    winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
        .open_subkey(PREF_KEY)
        .and_then(|k| k.get_value::<u32, _>(AUTO_DL_VALUE))
        .map(|v| v != 0)
        .unwrap_or(false)
}

/// The current preference, for the Settings toggle.
#[tauri::command]
pub fn auto_download() -> bool {
    #[cfg(windows)]
    {
        auto_download_enabled()
    }
    #[cfg(not(windows))]
    false
}

/// Set the preference. Takes effect on the next populate pass (as new photos sync).
#[tauri::command]
pub fn set_auto_download(enabled: bool) {
    #[cfg(windows)]
    if let Ok((key, _)) =
        winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER).create_subkey(PREF_KEY)
    {
        let _ = key.set_value(AUTO_DL_VALUE, &u32::from(enabled));
    }
    #[cfg(not(windows))]
    let _ = enabled;
}

#[cfg(windows)]
const EDITS_VALUE: &str = "ExplorerEdits";

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
        use cloud_filter::root::Session;
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
        // The Storage Provider (register) APIs need an initialized COM apartment.
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        }
        let log = app.clone();
        match try_register_sync_root() {
            Ok(()) => crate::note(&log, "[cloud] sync root registered"),
            Err(e) => crate::note(&log, &format!("[cloud] register skipped: {e}")),
        }
        let folder = sync_root_path();
        let app_for_sync = app.clone();
        match Session::new().connect(&folder, ProtonSyncFilter { app }) {
            // Leak the connection so it stays connected for the process lifetime
            // (dropping it would disconnect the sync engine).
            Ok(connection) => {
                crate::note(&log, "[cloud] sync engine connected");
                std::mem::forget(connection);
                start_hydrated_scanner();
                crate::explorer_sync::start(app_for_sync, folder.clone());
            }
            Err(e) => crate::note(&log, &format!("[cloud] connect failed: {e:?}")),
        }
    });
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

    let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let ours = (name.starts_with("pfp-hyd-") && name.ends_with(".bin"))
            || (name.starts_with("pfp-uninstall-old-") && name.ends_with(".exe"))
            || (name.starts_with("pfp-cleanup-") && name.ends_with(".ps1"));
        if ours {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(not(windows))]
pub fn reap_temp_leftovers() {}

#[cfg(windows)]
fn try_register_sync_root() -> Result<(), String> {
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
    const POLICY_VERSION: u32 = 4;
    let registered = id.is_registered().map_err(|e| format!("{e:?}"))?;
    if registered && policy_version() == POLICY_VERSION {
        return Ok(());
    }
    if registered {
        let _ = id.unregister(); // stale policy -> refresh with the current one
    }

    // Point the nav-pane icon at the app executable's embedded icon (index 0).
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe = exe.to_string_lossy();
    let icon = exe.strip_prefix(r"\\?\").unwrap_or(&exe);

    register_with_insync_policy(&id, &folder, &format!("{icon},0")).map_err(|e| format!("{e:?}"))?;
    set_policy_version(POLICY_VERSION);
    Ok(())
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
    // Manage hydration ONLY from the app: disallowing pinning makes Explorer hide its
    // "Always keep on this device" / "Free up space" menu, so the user cannot get a
    // file stuck via the shell's (broken-for-us) free-up path. The app's Download /
    // Free up buttons drive hydration directly (CfHydratePlaceholder / CfDehydratePlaceholder).
    info.SetAllowPinning(false)?;
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
            match id.unregister() {
                Ok(()) => crate::note(&app, "[cloud] unmounted (opt-out)"),
                Err(e) => crate::note(&app, &format!("[cloud] unmount failed: {e:?}")),
            }
        }
    });
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

/// Record one placeholder path (relative to the sync root) for a photo. The first
/// path recorded is its primary (`Photos\`) copy — the one Download hydrates.
///
/// Only ever called for a path this process created or adopted, never for one that
/// merely bears the right name. Everything that acts on a photo acts through this
/// index, including free-up, which discards local data. A photo whose `Photos\` copy
/// could not be created or adopted therefore has an album copy first, or no entry at
/// all, which is what leaves the colliding file untouched.
#[cfg(windows)]
fn index_push(uid: &str, rel: &str) {
    mount_index()
        .lock()
        .unwrap()
        .entry(uid.to_string())
        .or_default()
        .push(rel.to_string());
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

/// Keep one file on the device as a proper in-sync placeholder, whatever state it is
/// in. A cloud placeholder is hydrated in place (its data downloaded) and re-marked
/// in-sync; a plain file that has lost its placeholder status (e.g. after a provider
/// disconnect across app restarts, which strands it "waiting to sync" and un-freeable)
/// is converted to an in-sync placeholder with its data preserved and its uid blob
/// restored, so Explorer shows the green check and a later Free up still works.
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
    // If it is a cloud placeholder, hydrate it in place. `info()` is None for a plain
    // (non-placeholder) file. The oplock handle is dropped at the end of this match,
    // before any conversion, because CfConvertToPlaceholder needs a plain Win32 handle.
    match OpenOptions::new().write_access().open(&path) {
        Ok(mut ph) => {
            if ph.info().ok().flatten().is_some() {
                if ph.hydrate(..).is_ok() {
                    let _ = ph.mark_in_sync(true, None);
                    return true;
                }
                return false;
            }
        }
        Err(_) => return false,
    }
    // A regular file that lost its placeholder status: convert it back (data kept, no
    // dehydrate), re-attaching the uid so a future free-up / re-hydrate can find it.
    match convert_file_to_placeholder(&path, uid.unwrap_or(""), false) {
        Ok(()) => true,
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
    /// Ours, and this pass fixed it up (marked in sync, or converted back).
    Adopted,
    /// Ours, and there was nothing to do.
    Ours,
    /// Someone else's file that merely shares the name. Never indexed.
    Foreign,
}

/// Bring a file left on disk by a previous install back into the sync engine.
///
/// `PlaceholderFile::create` fails on a name collision, so after a reinstall the
/// kept-offline photos already sitting in `Photos\` / `Albums\` are skipped and
/// left as plain files — Explorer shows them "waiting to sync" and the app never
/// badges them as offline. Converting the on-disk file to an in-sync placeholder
/// (data preserved, NOT dehydrated) carrying its uid blob fixes both: the green
/// check returns and a later free-up / re-hydrate can still find the photo. If the
/// file is already a placeholder, convert fails and re-asserting in-sync is enough.
#[cfg(windows)]
fn reconcile_existing(
    app: &tauri::AppHandle,
    path: &std::path::Path,
    uid: &str,
    size: u64,
) -> Existing {
    use cloud_filter::placeholder::OpenOptions;
    const RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;
    // Decide from the directory entry, BEFORE opening anything.
    //
    // A cloud-only placeholder is already exactly what populate would have created,
    // so there is nothing here to reconcile. That matters far more than the wasted
    // work: every open below goes through `CfOpenFileWithOplock`, the crate offers
    // no no-recall flag, and to the Cloud Filter driver an open with write access is
    // a data access. So opening one to ask "are you alright?" downloads it.
    //
    // Every populate after the first hits this path for the WHOLE library, because
    // by then every placeholder exists and `create` fails on all of them. That is
    // what made "Sync now" pull the entire library: not a download the button asked
    // for, just the inspection itself.
    let Some(entry) = file_attribute_data(path) else {
        return Existing::Foreign; // unreadable: nothing may act on it
    };
    if entry.dwFileAttributes & RECALL_ON_DATA_ACCESS != 0 {
        // Cloud-only: already exactly what populate would have created, so there is
        // no work to do. It is still ours, and saying otherwise is what stopped
        // Download and Free up finding anything on the second and every later run.
        return Existing::Ours;
    }
    // It holds data, so an open cannot recall anything. Probe with the crate's oplock
    // handle: an existing hydrated placeholder just needs to read in-sync so it is not
    // stranded on "waiting to sync". The handle is dropped before any conversion —
    // CfConvertToPlaceholder needs a plain Win32 handle instead of the oplock one.
    match OpenOptions::new().write_access().open(path) {
        Ok(mut ph) => {
            if let Some(info) = ph.info().ok().flatten() {
                // It carries placeholder state, so it is one of ours holding data, and it
                // is this photo's only if it carries this photo's uid: another photo's
                // copy under a name this one now takes is left alone rather than handed
                // this photo's identity. The uid reads back cut short at the front (see
                // `downloaded_uid`), so it is matched by its end.
                let tail = String::from_utf8_lossy(info.blob()).into_owned();
                if !uid.ends_with(tail.as_str()) || uid.len() - tail.len() > 16 {
                    return Existing::Foreign;
                }
                // The in-sync mark is cosmetic (it settles Explorer's status column),
                // and failing to set it does not make the photo someone else's.
                let _ = ph.mark_in_sync(true, None);
                return Existing::Ours;
            }
        }
        Err(_) => return Existing::Foreign,
    }
    // A plain file holding data, sharing a name with one of the cloud photos. It is
    // either our own copy left behind by an earlier install, or a file the user put
    // here that merely collides: camera names repeat constantly, which is the whole
    // reason `unique_name` exists.
    //
    // Adopting the wrong one is unrecoverable. The uid goes on, the file joins the
    // mount index, and the next free-up dehydrates it, discarding bytes that were
    // never in Proton, under a button that promises the photos stay there. So a shared
    // name is not proof of ownership; the exact byte size matching the cloud file as
    // well is close enough. Anything else is left completely alone: a stray "waiting
    // to sync" badge is cosmetic, destroying someone's only copy is not.
    let on_disk = ((entry.nFileSizeHigh as u64) << 32) | entry.nFileSizeLow as u64;
    if on_disk != size {
        return Existing::Foreign;
    }
    match convert_file_to_placeholder(path, uid, false) {
        Ok(()) => Existing::Adopted,
        Err(e) => {
            // No file name / uid in the log — just the outcome and the OS error.
            // Without the uid blob attached nothing could act on it correctly anyway,
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
/// photos kept on this device. `done` of `total` while there is a count to give.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MountActivity {
    what: &'static str,
    name: Option<String>,
    by: Option<String>,
    done: u64,
    total: u64,
}

#[cfg(windows)]
static ACTIVITY: std::sync::Mutex<Option<MountActivity>> = std::sync::Mutex::new(None);

#[cfg(windows)]
fn show_activity(app: &tauri::AppHandle, now: Option<MountActivity>) {
    use tauri::Emitter;
    let mut cur = ACTIVITY.lock().unwrap();
    *cur = now;
    let _ = app.emit("mount-activity", cur.clone());
}

/// Names the outermost piece of work while it runs: one nested inside it (a download
/// a fill set off) leaves the outer name standing, and only its owner clears it.
#[cfg(windows)]
struct Doing {
    app: tauri::AppHandle,
    owns: bool,
}

#[cfg(windows)]
impl Doing {
    fn new(app: &tauri::AppHandle, what: &'static str, name: Option<String>, by: Option<String>) -> Self {
        let owns = ACTIVITY.lock().unwrap().is_none();
        if owns {
            show_activity(app, Some(MountActivity { what, name, by, done: 0, total: 0 }));
        }
        Doing { app: app.clone(), owns }
    }
}

#[cfg(windows)]
impl Drop for Doing {
    fn drop(&mut self) {
        if self.owns {
            show_activity(&self.app, None);
        }
    }
}

/// The fill's count of photos placed, shown only while a fill is what the folder is doing.
#[cfg(windows)]
fn fill_progress(app: &tauri::AppHandle, done: u64, total: u64) {
    let next = match ACTIVITY.lock().unwrap().clone() {
        Some(a) if a.what == "fill" => Some(MountActivity { done, total, ..a }),
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

/// What the folder is busy with right now, for a window that opens while it already is.
#[tauri::command]
pub fn mount_activity() -> Option<MountActivity> {
    #[cfg(windows)]
    {
        ACTIVITY.lock().unwrap().clone()
    }
    #[cfg(not(windows))]
    None
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
/// directly on a `CreateFile`/std handle. With `dehydrate` the local data is dropped
/// (free up); without it the data is kept (green check). The uid is stored as the file
/// identity blob so a later hydrate / free-up can find the cloud file.
#[cfg(windows)]
fn convert_file_to_placeholder(path: &std::path::Path, uid: &str, dehydrate: bool) -> Result<(), String> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::CloudFilters::{
        CfConvertToPlaceholder, CF_CONVERT_FLAG_DEHYDRATE, CF_CONVERT_FLAG_MARK_IN_SYNC,
    };
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
    let flags = if dehydrate {
        CF_CONVERT_FLAG_MARK_IN_SYNC | CF_CONVERT_FLAG_DEHYDRATE
    } else {
        CF_CONVERT_FLAG_MARK_IN_SYNC
    };
    unsafe {
        CfConvertToPlaceholder(HANDLE(file.as_raw_handle() as _), id_ptr, id_len, flags, None, None)
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

/// Hydrate every not-yet-local photo of one album (its `Albums\<name>\` copies, so
/// that Explorer folder ends up filled).
#[cfg(windows)]
fn hydrate_album(app: &tauri::AppHandle, album_uid: &str) {
    let base = sync_root_path();
    let rels = album_copies(album_uid);
    let rev = rel_to_uid();
    let mut n = 0usize;
    for rel in &rels {
        if !is_hydrated(&base, rel) && keep_offline_one(app, &base, rel, rev.get(rel).map(String::as_str)) {
            n += 1;
        }
    }
    if n > 0 {
        crate::note(app, &format!("[album-sync] kept {n} offline"));
    }
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
            for rel in album_copies(&uid) {
                // No uid means the copy is not in the mount's index, so there is no
                // blob to restore it with and it is not ours to touch.
                let Some(photo) = rev.get(&rel) else { continue };
                if free_up_one(&app, &base, photo, &rel) {
                    freed += 1;
                }
            }
            crate::note(&app, &format!("[album-sync] freed {freed} album copies"));
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

/// Toggle "keep this album on this device". Enabling hydrates its photos now and
/// (via populate) keeps future additions to the album downloaded too. Disabling
/// stops the auto-sync; what it already downloaded is the caller's to ask about,
/// through `album_local_count` and `free_up_album`.
#[tauri::command]
pub fn set_album_synced(app: tauri::AppHandle, uid: String, enabled: bool) {
    #[cfg(windows)]
    {
        let mut set = load_synced_albums(&app);
        if enabled {
            set.insert(uid.clone());
        } else {
            set.remove(&uid);
        }
        save_synced_albums(&app, &set);
        if enabled {
            std::thread::spawn(move || {
                let _busy = BusyGuard::new(&app);
                let _doing = Doing::new(&app, "offline", None, None);
                hydrate_album(&app, &uid);
            });
        }
    }
    #[cfg(not(windows))]
    let _ = (app, uid, enabled);
}

/// Re-mark a hydrated file as in-sync. A read-only provider (we never upload) must
/// do this, or the write-time bump from hydration reads as a local change and the
/// file is stranded on "waiting to sync", which also blocks "Free up space".
#[cfg(windows)]
fn mark_path_in_sync(app: &tauri::AppHandle, path: &std::path::Path) {
    use cloud_filter::placeholder::OpenOptions;
    match OpenOptions::new().write_access().open(path) {
        Ok(mut ph) => match ph.mark_in_sync(true, None) {
            Ok(_) => crate::note(app, "[cloud] re-marked in-sync after hydrate"),
            Err(e) => crate::note(app, &format!("[cloud] mark-in-sync failed: {e:?}")),
        },
        Err(e) => crate::note(app, &format!("[cloud] mark-in-sync open failed: {e:?}")),
    }
}

/// The smallest and largest page populate asks the sidecar for. A cold page resolves
/// every photo in it over the network, so it starts small; one answered from cache
/// costs milliseconds, and paging four at a time would turn a large library into hours.
#[cfg_attr(not(windows), allow(dead_code))]
const POPULATE_PAGE_MIN: u64 = 4;
#[cfg_attr(not(windows), allow(dead_code))]
const POPULATE_PAGE_MAX: u64 = 200;

/// The next page size and the rest before asking for it, from how long the last page
/// took: fast pages double, slow ones halve and leave the channel free for a moment.
#[cfg_attr(not(windows), allow(dead_code))]
fn next_populate_page(page: u64, took: std::time::Duration) -> (u64, std::time::Duration) {
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
        let _busy = BusyGuard::new(&self.app);

        let uid = String::from_utf8_lossy(request.file_blob()).into_owned();
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
        let _doing = Doing::new(&self.app, "open", opened, Some(by.clone()));
        // The sidecar streams the download to a temp file; we transfer that into the
        // placeholder a chunk at a time so a large video never sits in memory.
        let (temp, got) = crate::hydrate_to_temp(&self.app, &uid).map_err(|e| {
            crate::note(&self.app, &format!("[cloud] hydrate download failed: {e}"));
            CloudErrorKind::NetworkUnavailable
        })?;
        // Refuse a wrong-sized transfer instead of writing a broken partial. A short
        // read would leave the placeholder half-hydrated and stranded — undeletable,
        // with the shell reporting "the cloud provider is not running"; a long read
        // means the declared size is wrong. Aborting here writes nothing, so the file
        // stays a clean cloud-only placeholder that can be reopened or deleted.
        if got == 0 || got != want {
            crate::note(&self.app, &format!("[cloud] hydrate aborted (got {got} want {want})"));
            let _ = std::fs::remove_file(&temp);
            return Err(CloudErrorKind::ValidationFailed);
        }

        // Stream the temp file into the placeholder. The OS requires each transfer to
        // be 4KiB or to end exactly on the file size, so send full 4KiB chunks with a
        // smaller final chunk, holding only one chunk in memory at a time.
        const CHUNK: usize = 4096;
        let transfer = (|| -> Result<(), CloudErrorKind> {
            let mut f = std::fs::File::open(&temp).map_err(|e| {
                crate::note(&self.app, &format!("[cloud] hydrate open temp failed: {e:?}"));
                CloudErrorKind::Unsuccessful
            })?;
            let mut buf = vec![0u8; CHUNK];
            let mut offset = 0u64;
            let mut remaining = got;
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
                offset += this as u64;
                remaining -= this as u64;
                let _ = ticket.report_progress(got, offset);
            }
            Ok(())
        })();
        let _ = std::fs::remove_file(&temp);
        transfer?;
        crate::note(&self.app, &format!("[cloud] hydrate done ({got} bytes)"));
        mark_hydrated(&uid, true);
        // Re-mark in-sync once the hydration handle is released, so the file can be
        // freed up later instead of being stranded on "waiting to sync".
        let path = request.path();
        let app = self.app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(700));
            mark_path_in_sync(&app, &path);
        });
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
        if !crate::explorer_sync::is_own(&rel) && (read_only_place(&rel) || !explorer_edits_enabled()) {
            // The trash is never emptied from here, and what others shared is theirs.
            return Err(cloud_filter::error::CloudErrorKind::AccessDenied);
        }
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
            }
        }
        ticket.pass().map_err(|_| cloud_filter::error::CloudErrorKind::InvalidRequest)
    }

    fn dehydrate(
        &self,
        _request: cloud_filter::filter::Request,
        ticket: cloud_filter::filter::ticket::Dehydrate,
        _info: cloud_filter::filter::info::Dehydrate,
    ) -> cloud_filter::error::CResult<()> {
        // Approve "free up space": the local data is dropped and the file goes back
        // to a dehydrated cloud placeholder (green cloud, still in sync). Logged so
        // a "stuck on waiting to sync" report shows whether Windows even reaches the
        // provider (if this line is absent from the log, the file was not in-sync and
        // Windows blocked the free-up before calling us).
        crate::note(&self.app, "[cloud] dehydrate (free up space) requested");
        match ticket.pass() {
            Ok(()) => {
                crate::note(&self.app, "[cloud] dehydrate approved");
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
        let first = !FILL_STARTED.swap(true, std::sync::atomic::Ordering::SeqCst);
        if !first && !LAST_FILL.lock().unwrap().is_some_and(|at| at.elapsed() >= REFILL_AFTER) {
            return;
        }
        let _busy = BusyGuard::new(&app);
        let _doing = first.then(|| Doing::new(&app, "fill", None, None));
        // Startup pass: honours the "auto-download new photos" setting.
        match try_populate(&app, true) {
            Ok(()) => filled(),
            Err(e) => eprintln!("[cloud_mount] populate failed: {e}"),
        }
    });
    #[cfg(not(windows))]
    let _ = app;
}

/// The tray "Sync now" action. Deliberately lighter than a startup populate: it
/// refreshes the placeholders and pulls only what the user has opted into (the albums
/// kept offline), then asks the open window to reload its view. It NEVER runs the
/// whole-library auto-download, so the button can never start downloading the entire
/// library. Safe to press at any time.
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
            // `false` = never auto-download the whole library; only synced albums sync.
            match try_populate(&app, false) {
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

/// Build (or refresh) the cloud placeholders. `auto_download` gates the "keep every
/// new photo on this device" pass: on by the setting during a startup populate, always
/// off for the tray "Sync now" so that button can never bulk-download the library.
/// Clears out what the library no longer has: a cloud-only placeholder this fill did not
/// make or find again stands for a photo deleted elsewhere, trashed, or taken out of
/// that album, and only the app ever makes placeholders. A downloaded copy is the
/// user's and stays. An album folder that held nothing else is removed with them,
/// unless it is still an album.
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
    let Ok(file) = std::fs::OpenOptions::new().read(true).write(true).open(path) else {
        return false;
    };
    if file.dehydrate(..).is_err() {
        return false;
    }
    drop(file);
    crate::explorer_sync::expect_own(rel);
    std::fs::remove_file(path).is_ok()
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
            reconcile_existing(app, &dir.join(&unique), uid, *size) != Existing::Foreign
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
    for album in extras.get("sharedAlbums").and_then(|v| v.as_array()).cloned().unwrap_or_default() {
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
    // What the folder held is this account's business; the next one takes its own look.
    if let Ok(dir) = crate::secure_store::app_dir(app) {
        let _ = std::fs::remove_file(dir.join(crate::explorer_sync::SEEN_FILE));
    }
    let _fill = populate_lock();
    let root = sync_root_path();
    let mut folders: Vec<String> =
        vec!["Photos".into(), "Photos\\Favorites".into(), "Trash".into(), "Shared".into()];
    for parent in ["Albums", "Shared"] {
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
    mount_index().lock().unwrap().clear();
    album_index().lock().unwrap().clear();
    album_dirs().lock().unwrap().clear();
    {
        let (state, _) = hydrated_state();
        let mut st = state.lock().unwrap();
        st.uids.clear();
        st.version += 1;
    }
    crate::note(app, &format!("[cloud] signed out: removed {removed} placeholders, kept downloaded copies"));
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
        match try_populate(app, false) {
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
fn try_populate(app: &tauri::AppHandle, auto_download: bool) -> Result<(), String> {
    let _fill = populate_lock();
    use cloud_filter::metadata::{Metadata, MetadataExt};
    use cloud_filter::placeholder_file::PlaceholderFile;
    use std::collections::{HashMap, HashSet};

    let folder = sync_root_path();
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    mark_not_indexed(&folder);
    // Idempotent across an unexpected second run in one process. The sizes go with
    // the index they belong to: a free-up that overlaps a populate then finds no size
    // for a moment and declines to convert, which is the harmless direction.
    // What the previous fill knew, for `prune_stale` to recognise a downloaded copy that
    // is still a photo of the library under the name it had before a rename.
    let previous = rel_to_uid();
    mount_index().lock().unwrap().clear();
    mount_sizes().lock().unwrap().clear();
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
        let result = crate::sidecar_rpc(
            app,
            "listForMount",
            serde_json::json!({ "offset": offset, "limit": page }),
        )?;
        let took = asked.elapsed();
        let items = result.get("items").and_then(|v| v.as_array()).cloned().unwrap_or_default();
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
            mount_sizes().lock().unwrap().insert(uid.to_string(), size);
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
                match reconcile_existing(app, &photos_dir.join(&unique), uid, size) {
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
    populate_extras(app, &folder, &favorites);
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

    // Auto-download: keep photos that appeared since the previous populate on this
    // device. The snapshot from the last run is the baseline; a first run (no snapshot)
    // only seeds it, so enabling the option never bulk-downloads the whole existing
    // library — only genuine new arrivals from then on. Guarded three ways so it can
    // never run away: the caller opts in (`auto_download`), the setting is on, and the
    // baseline is a real, non-empty snapshot (an empty/missing one means "seed", not
    // "everything is new"). And the snapshot is only saved when this listing actually
    // returned photos, so a transient empty listing cannot poison the next run.
    if auto_download && auto_download_enabled() {
        if let Some(prev) = load_seen(app) {
            if !prev.is_empty() {
                let index = mount_index().lock().unwrap();
                let mut grabbed = 0usize;
                for uid in &all_uids {
                    if prev.contains(uid) {
                        continue;
                    }
                    if let Some(rel) = index.get(uid).and_then(|v| v.first()) {
                        if keep_offline_one(app, &folder, rel, Some(uid.as_str())) {
                            grabbed += 1;
                        }
                    }
                }
                if grabbed > 0 {
                    crate::note(app, &format!("[autodl] downloaded {grabbed} new photo(s)"));
                }
            }
        }
    }
    if !all_uids.is_empty() {
        save_seen(app, &all_uids);
    }

    // Selective per-album sync: keep every photo of a "synced" album on the device,
    // catching photos newly added to those albums since the last populate.
    for album_uid in load_synced_albums(app) {
        hydrate_album(app, &album_uid);
    }

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

    let albums = match crate::sidecar_rpc(app, "listAlbumsForMount", serde_json::json!({})) {
        Ok(v) => v.as_array().cloned().unwrap_or_default(),
        Err(e) => {
            crate::note(app, &format!("[cloud] albums skipped: {e}"));
            return;
        }
    };
    album_index().lock().unwrap().clear();
    album_dirs().lock().unwrap().clear();
    if albums.is_empty() {
        return;
    }
    if !albums_dir.exists() {
        crate::explorer_sync::expect_own("Albums");
    }
    let _ = std::fs::create_dir_all(albums_dir);
    mark_not_indexed(albums_dir);

    let mut album_dir_seen: HashSet<String> = HashSet::new();
    let mut made = 0usize;
    for album in &albums {
        let album_uid = album.get("uid").and_then(|v| v.as_str()).unwrap_or_default();
        let name = album.get("name").and_then(|v| v.as_str()).unwrap_or("Album");
        let uids = album.get("uids").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        if uids.is_empty() {
            continue;
        }
        let dir_name = unique_name(&sanitize_name(name), &mut album_dir_seen);
        let album_folder = albums_dir.join(&dir_name);
        if !album_uid.is_empty() {
            album_dirs().lock().unwrap().insert(dir_name.to_lowercase(), album_uid.to_string());
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
        for u in &uids {
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
                reconcile_existing(app, &album_folder.join(&unique), uid, *size) != Existing::Foreign
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
            album_index().lock().unwrap().insert(album_uid.to_string(), members);
        }
    }
    crate::note(app, &format!("[cloud] populate: created {made} album placeholders"));
}

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

/// Free up one copy: dehydrate it back to a cloud-only placeholder via
/// `CfDehydratePlaceholder` directly. This is the provider's own dehydrate call and
/// does NOT go through Explorer's "Free up space" (which a not-in-sync placeholder
/// blocks before the callback). `true` once the local data is gone; a copy that is
/// already cloud-only counts as neither freed nor failed. Logs the exact error, so a
/// failure pinpoints the cause.
#[cfg(windows)]
fn free_up_one(app: &tauri::AppHandle, base: &std::path::Path, uid: &str, rel: &str) -> bool {
    use cloud_filter::ext::FileExt;
    const RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;
    let path = base.join(rel);
    // Skip a copy that is already cloud-only (e.g. an unopened album copy).
    // Attributes only: stat-ing this by opening it would hydrate the very
    // file we are here to free up. The same directory entry carries the size
    // the last fallback below has to check, so one read serves both.
    let Some(entry) = file_attribute_data(&path) else {
        return false;
    };
    if entry.dwFileAttributes & RECALL_ON_DATA_ACCESS != 0 {
        return false;
    }
    // Normal path: dehydrate the placeholder in place.
    if let Ok(file) = std::fs::OpenOptions::new().read(true).write(true).open(&path) {
        if file.dehydrate(..).is_ok() {
            return true;
        }
    }
    // A placeholder left not-in-sync by a failed/interrupted hydrate blocks
    // the dehydrate above (and the shell's own delete, which reports "the
    // cloud provider is not running"). Force it back in-sync, then dehydrate,
    // to reset it to a clean cloud-only placeholder that deletes normally.
    {
        use cloud_filter::placeholder::OpenOptions;
        if let Ok(mut ph) = OpenOptions::new().write_access().open(&path) {
            if ph.info().ok().flatten().is_some() {
                let _ = ph.mark_in_sync(true, None);
            }
        } // release the oplock handle before the std dehydrate
        if let Ok(file) = std::fs::OpenOptions::new().read(true).write(true).open(&path) {
            if file.dehydrate(..).is_ok() {
                return true;
            }
        }
    }
    // The copy lost its placeholder status (a plain "waiting to sync" file, so
    // CfDehydratePlaceholder fails with "not a cloud file"): convert it straight
    // to a DEHYDRATED placeholder, which reclaims the space and restores the
    // cloud status in one step.
    //
    // This branch is the one that ASSERTS the file is the cloud file's copy, rather
    // than being told so: the two attempts above act on a placeholder, where the
    // driver already knows what the local data stands for, while this one attaches a
    // uid to a plain file and drops its bytes in the same call. So the same test the
    // rest of this file turns on applies here too, and for the same reason: a size
    // that no longer matches means the file is not that copy, whatever its name says.
    // `reconcile_existing` refuses to adopt on it, and free-up must refuse to destroy
    // on it.
    let on_disk = ((entry.nFileSizeHigh as u64) << 32) | entry.nFileSizeLow as u64;
    if cloud_size(uid) != Some(on_disk) {
        // Counts only, no name or uid: enough to see that a copy was passed over.
        crate::note(app, "[freeup] size does not match the cloud file, left alone");
        return false;
    }
    match convert_file_to_placeholder(&path, uid, true) {
        Ok(()) => true,
        // No file name / uid in the log — just the outcome and the OS error.
        Err(e) => {
            crate::note(app, &format!("[freeup] convert-dehydrate failed: {e}"));
            false
        }
    }
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
    if changed {
        st.version += 1;
    }
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
