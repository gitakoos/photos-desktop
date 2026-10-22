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

//! Carries what is done in the Proton Photos folder over to the library.
//!
//! File Explorer changes the folder first and tells the provider afterwards, so the
//! folder is watched (`ReadDirectoryChangesExW`, which names every entry by its file
//! id), the events are gathered until the folder has been quiet for a moment, and the
//! batch is read with `explorer_rules`. What it asks of the library goes to the sidecar;
//! the folder is then filled again from the library, which puts back whatever the
//! library did not take and brings the copies a move left behind.
//!
//! What the app itself does in the folder (making its folders, clearing placeholders
//! the library no longer has) is registered as its own beforehand and is not read back.

#![cfg(windows)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::explorer_rules::{self as rules, Action, Change, Library, RawEvent, RawKind};
use crate::notices::Notice;

/// How long the folder has to stay quiet before a batch is read, and the longest a
/// batch keeps gathering while it does not.
const QUIET: Duration = Duration::from_millis(1500);
const LONGEST_BATCH: Duration = Duration::from_secs(10);
/// How long a path stays marked as the app's own doing. The watcher reads an event as it
/// happens, so a few seconds is plenty; longer, and the user's own delete or rename of the
/// same file right after a fill would be taken for the app's and never reach the library.
const OWN_FOR: Duration = Duration::from_secs(5);
/// How long a path stays marked as moved out of the folder: Explorer downloads the file
/// before it asks, and moves it straight after.
const MOVED_OUT_FOR: Duration = Duration::from_secs(60);

fn marks(which: &'static OnceLock<Mutex<HashMap<String, Instant>>>) -> &'static Mutex<HashMap<String, Instant>> {
    which.get_or_init(|| Mutex::new(HashMap::new()))
}

static OWN: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
static MOVED_OUT: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();

fn mark(which: &'static OnceLock<Mutex<HashMap<String, Instant>>>, rel: &str, lasting: Duration) {
    let mut m = marks(which).lock().unwrap();
    let now = Instant::now();
    m.retain(|_, until| *until > now);
    m.insert(rel.to_lowercase(), now + lasting);
}

fn marked(which: &'static OnceLock<Mutex<HashMap<String, Instant>>>, rel: &str) -> bool {
    let m = marks(which).lock().unwrap();
    m.get(&rel.to_lowercase()).is_some_and(|until| *until > Instant::now())
}

/// Something the app is about to do at `rel` (relative to the folder's root), which the
/// watcher must not read as the user's.
pub fn expect_own(rel: &str) {
    mark(&OWN, rel, OWN_FOR);
}

pub fn is_own(rel: &str) -> bool {
    marked(&OWN, rel)
}

/// A file Explorer is moving out of the folder: it leaves as an ordinary copy, and its
/// disappearing is not a deletion.
pub fn note_moved_out(rel: &str) {
    mark(&MOVED_OUT, rel, MOVED_OUT_FOR);
}

/// A path under the folder's root, relative to it, or None for one outside it.
pub fn relative(root: &Path, path: &Path) -> Option<String> {
    path.strip_prefix(root).ok().map(|r| r.to_string_lossy().into_owned())
}

/// Files that are never photos: Explorer's own and editors' scratch files.
fn ignorable(rel: &str) -> bool {
    let name = rules::name_of(rel).to_lowercase();
    name == "desktop.ini"
        || name == "thumbs.db"
        || name.starts_with("~$")
        || name.starts_with(".~")
        || name.ends_with(".tmp")
        || name.ends_with(".part")
        || name.ends_with(".crdownload")
}

/// Starts watching the folder, once per process.
pub fn start(app: tauri::AppHandle, root: PathBuf) {
    static STARTED: std::sync::Once = std::sync::Once::new();
    STARTED.call_once(|| {
        let (tx, rx) = channel();
        let watch_root = root.clone();
        let watch_app = app.clone();
        std::thread::spawn(move || watch(watch_app, watch_root, tx));
        std::thread::spawn(move || gather(app, rx));
    });
}

/// Reads the folder's change notifications and forwards them, one event at a time.
fn watch(app: tauri::AppHandle, root: PathBuf, tx: Sender<RawEvent>) {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::*;

    // FILE_LIST_DIRECTORY, every sharing mode, and FILE_FLAG_BACKUP_SEMANTICS to open a folder.
    let dir = match std::fs::OpenOptions::new().access_mode(0x1).share_mode(0x7).custom_flags(0x0200_0000).open(&root) {
        Ok(f) => f,
        Err(e) => {
            crate::note(&app, &format!("[explorer] watcher could not open the folder: {:?}", e.kind()));
            return;
        }
    };
    let handle = HANDLE(dir.as_raw_handle());
    let mut buf = vec![0u64; 16_384];
    loop {
        let mut got = 0u32;
        let filter = FILE_NOTIFY_CHANGE_FILE_NAME
            | FILE_NOTIFY_CHANGE_DIR_NAME
            | FILE_NOTIFY_CHANGE_LAST_WRITE
            | FILE_NOTIFY_CHANGE_SIZE;
        let read = unsafe {
            ReadDirectoryChangesExW(
                handle,
                buf.as_mut_ptr() as *mut _,
                (buf.len() * 8) as u32,
                true,
                filter,
                Some(&mut got),
                None,
                None,
                ReadDirectoryNotifyExtendedInformation,
            )
        };
        if let Err(e) = read {
            crate::note(&app, &format!("[explorer] watcher stopped: {e:?}"));
            return;
        }
        if got == 0 {
            // More happened than fit in the buffer: nothing to read back reliably, so the
            // folder is filled again from the library instead.
            crate::note(&app, "[explorer] too many changes at once, refreshing the folder");
            request_refresh(&app);
            continue;
        }
        let base = buf.as_ptr() as *const u8;
        let mut offset = 0usize;
        loop {
            // The entries are only 4-byte aligned, so every read of one is unaligned.
            let at = unsafe { base.add(offset) } as *const FILE_NOTIFY_EXTENDED_INFORMATION;
            let info: FILE_NOTIFY_EXTENDED_INFORMATION = unsafe { std::ptr::read_unaligned(at) };
            let len = info.FileNameLength as usize / 2;
            let name_at = unsafe { std::ptr::addr_of!((*at).FileName) } as *const u8;
            let name: Vec<u16> =
                (0..len).map(|i| unsafe { std::ptr::read_unaligned(name_at.add(i * 2) as *const u16) }).collect();
            let rel = String::from_utf16_lossy(&name);
            let kind = match info.Action {
                FILE_ACTION_ADDED => Some(RawKind::Added),
                FILE_ACTION_REMOVED => Some(RawKind::Removed),
                FILE_ACTION_RENAMED_OLD_NAME => Some(RawKind::RenamedOld),
                FILE_ACTION_RENAMED_NEW_NAME => Some(RawKind::RenamedNew),
                FILE_ACTION_MODIFIED => Some(RawKind::Modified),
                _ => None,
            };
            if let Some(kind) = kind {
                if !ignorable(&rel) && !is_own(&rel) {
                    let event = RawEvent {
                        kind,
                        rel,
                        file_id: info.FileId,
                        dir: info.FileAttributes & 0x10 != 0,
                        placeholder: info.FileAttributes & 0x400 != 0,
                    };
                    if tx.send(event).is_err() {
                        return;
                    }
                }
            }
            if info.NextEntryOffset == 0 {
                break;
            }
            offset += info.NextEntryOffset as usize;
        }
    }
}

/// Gathers events into batches, each read once the folder has been quiet for a moment.
fn gather(app: tauri::AppHandle, rx: Receiver<RawEvent>) {
    // Departures a batch cut short could not place yet, read again with the next one.
    let mut held: Vec<RawEvent> = Vec::new();
    loop {
        let mut batch = std::mem::take(&mut held);
        if batch.is_empty() {
            let Ok(first) = rx.recv() else { return };
            batch.push(first);
        }
        let started = Instant::now();
        let mut cut_short = false;
        loop {
            match rx.recv_timeout(QUIET) {
                Ok(e) => {
                    batch.push(e);
                    if started.elapsed() > LONGEST_BATCH {
                        cut_short = true;
                        break;
                    }
                }
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
        // A batch is read against the folder's index, which a fill in progress is
        // rebuilding; it waits for the fill to finish.
        let _filling = crate::cloud_mount::populate_lock();
        drop(_filling);
        if cut_short {
            // Nothing is taken away while events are still coming: a removal waits
            // until the folder is quiet, when its move or its folder has shown up.
            let (now, later) = rules::hold_departures(batch);
            held = later;
            if !now.is_empty() {
                apply(&app, &now);
            }
        } else {
            apply(&app, &batch);
        }
    }
}

/// The library as the folder shows it: which photo a path holds, which album a folder is.
struct Index {
    photos: HashMap<String, String>,
}

impl Library for Index {
    fn photo_at(&self, rel: &str) -> Option<String> {
        self.photos.get(&rel.to_lowercase()).cloned()
    }
    fn album_named(&self, folder: &str) -> Option<String> {
        crate::cloud_mount::album_for_folder(folder)
    }
}

fn apply(app: &tauri::AppHandle, batch: &[RawEvent]) {
    let changes = rules::read_batch(batch);
    if changes.is_empty() {
        return;
    }
    let index = Index { photos: crate::cloud_mount::photos_by_path() };
    let mut refresh = false;
    for change in &changes {
        if let Change::Removed { rel, .. } = change {
            if marked(&MOVED_OUT, rel) {
                // Taken out of the folder as an ordinary copy: the library keeps it.
                refresh = true;
                continue;
            }
        }
        let mut action = rules::action_for(change, &index);
        if !crate::cloud_mount::explorer_edits_enabled() {
            action = rules::without_edits(action);
        }
        if action == Action::Nothing {
            continue;
        }
        crate::note(app, &format!("[explorer] {}", describe(&action)));
        refresh |= run(app, &action, &album_folder(change));
    }
    if refresh {
        request_refresh(app);
    }
}

/// The action's kind, for the log: never a name or a uid.
fn describe(action: &Action) -> &'static str {
    match action {
        Action::Trash { .. } => "to trash",
        Action::FromAlbum { .. } => "out of an album",
        Action::IntoAlbum { .. } => "into an album",
        Action::Favorite { .. } => "favourite",
        Action::Unfavorite { .. } => "no longer a favourite",
        Action::Restore { .. } => "restore",
        Action::RenamePhoto { .. } => "rename a photo",
        Action::RenameAlbum { .. } => "rename an album",
        Action::DeleteAlbum { .. } => "delete an album",
        Action::Upload { .. } => "upload",
        Action::NewFolder { .. } => "new folder",
        Action::PutBack { .. } => "put back",
        Action::Nothing => "nothing",
    }
}

/// Whether a library call did what it was asked, for every item it names.
fn changed(app: &tauri::AppHandle, method: &str, params: serde_json::Value) -> bool {
    match crate::sidecar_rpc(app, method, params) {
        Ok(serde_json::Value::Array(results)) => {
            results.iter().all(|r| r.get("ok").and_then(|v| v.as_bool()) == Some(true))
        }
        Ok(serde_json::Value::Object(o)) => o.get("status").and_then(|v| v.as_str()).is_none_or(|s| s == "deleted"),
        Ok(_) => true,
        Err(e) => {
            crate::note(app, &format!("[explorer] {method} failed: {e}"));
            false
        }
    }
}

/// The album folder a change happened in, by name, for the notice that names the album.
fn album_folder(change: &Change) -> String {
    let rel = match change {
        Change::Removed { rel, dir: true } => rel.as_str(),
        Change::Removed { rel, .. } | Change::Added { rel, .. } => rules::parent_of(rel),
        Change::Moved { from, .. } => rules::parent_of(from),
    };
    rules::name_of(rel).to_string()
}

/// What Explorer said "permanently" about, said as it happened: into the Proton trash,
/// out of an album, and the like.
fn notice_for(action: &Action, album: &str) -> Option<Notice> {
    match action {
        Action::Trash { .. } => Some(Notice::Trashed),
        Action::FromAlbum { .. } => Some(Notice::LeftAlbum(album.to_string())),
        Action::Unfavorite { .. } => Some(Notice::Unfavorited),
        Action::DeleteAlbum { .. } => Some(Notice::AlbumDeleted(album.to_string())),
        Action::Restore { .. } => Some(Notice::Restored),
        _ => None,
    }
}

/// Carries one action out; true when the folder should be filled again afterwards.
fn run(app: &tauri::AppHandle, action: &Action, album: &str) -> bool {
    use serde_json::json;
    let ok = match action {
        Action::Trash { photo } => changed(app, "trashPhotos", json!({ "uids": [photo] })),
        Action::FromAlbum { album, photo } => {
            changed(app, "removePhotosFromAlbum", json!({ "albumUid": album, "uids": [photo] }))
        }
        Action::IntoAlbum { album, photo, leaving } => {
            let added = changed(app, "addPhotosToAlbum", json!({ "albumUid": album, "uids": [photo] }));
            match leaving {
                Some(from) if added => changed(app, "removePhotosFromAlbum", json!({ "albumUid": from, "uids": [photo] })),
                _ => added,
            }
        }
        Action::Favorite { photo } => changed(app, "setFavorite", json!({ "uids": [photo], "favorite": true })),
        Action::Unfavorite { photo } => changed(app, "setFavorite", json!({ "uids": [photo], "favorite": false })),
        Action::Restore { photo } => changed(app, "restorePhotos", json!({ "uids": [photo] })),
        Action::RenamePhoto { photo, name } => changed(app, "renamePhoto", json!({ "uid": photo, "name": name })),
        Action::RenameAlbum { album, name } => changed(app, "renameAlbum", json!({ "uid": album, "name": name })),
        Action::DeleteAlbum { album } => {
            changed(app, "deleteAlbum", json!({ "uid": album, "saveToTimeline": true }))
        }
        Action::Upload { rel, album, new_album, favorite } => {
            start_upload(app, rel.clone(), album.clone(), new_album.clone(), *favorite);
            return false;
        }
        // An album to be: made with its first photo, so an empty folder makes nothing.
        Action::NewFolder { .. } => return false,
        Action::PutBack { .. } => true,
        Action::Nothing => return false,
    };
    if !ok {
        crate::note(app, &format!("[explorer] could not {}", describe(action)));
    } else if let Some(notice) = notice_for(action, album) {
        crate::notices::tell(app, notice);
    }
    true
}

/// Fills the folder again from the library, soon and once, however many batches ask.
pub fn request_refresh(app: &tauri::AppHandle) {
    static PENDING: Mutex<bool> = Mutex::new(false);
    {
        let mut pending = PENDING.lock().unwrap();
        if *pending {
            return;
        }
        *pending = true;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(2));
        *PENDING.lock().unwrap() = false;
        crate::cloud_mount::refresh_mount(&app);
    });
}

/// How long a file that arrived may keep changing before it is uploaded anyway, and how
/// long it has to stay still before it counts as complete.
const SETTLE_LIMIT: Duration = Duration::from_secs(10 * 60);
const SETTLE_STILL: Duration = Duration::from_secs(2);

/// Waits for a file that arrived to be complete: the same size and time twice, two
/// seconds apart, and no one holding it open for writing. False if it went away or never
/// settled, or turned out to be a placeholder.
fn settled(path: &Path) -> bool {
    use std::os::windows::fs::OpenOptionsExt;
    const REPARSE_POINT: u32 = 0x400;
    let started = Instant::now();
    let mut last: Option<(u64, std::time::SystemTime)> = None;
    while started.elapsed() < SETTLE_LIMIT {
        let Ok(meta) = std::fs::symlink_metadata(path) else { return false };
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & REPARSE_POINT != 0 || !meta.is_file() {
            return false;
        }
        let now = (meta.len(), meta.modified().unwrap_or(std::time::UNIX_EPOCH));
        // Shared for reading only: this fails while anything still has it open to write.
        let free = std::fs::OpenOptions::new().read(true).share_mode(0x1).open(path).is_ok();
        if free && last == Some(now) && now.0 > 0 {
            return true;
        }
        last = Some(now);
        std::thread::sleep(SETTLE_STILL);
    }
    false
}

/// Albums being made for new folders, by lowercased folder name, so the photos of one
/// folder arriving one after another make one album between them.
static NEW_ALBUMS: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

/// The album a new folder in `Albums\` stands for, made the first time it is needed.
fn album_for_new_folder(app: &tauri::AppHandle, folder: &str) -> Result<String, String> {
    if let Some(uid) = crate::cloud_mount::album_for_folder(folder) {
        return Ok(uid);
    }
    let mut made = NEW_ALBUMS.lock().unwrap();
    let made = made.get_or_insert_with(HashMap::new);
    if let Some(uid) = made.get(&folder.to_lowercase()) {
        return Ok(uid.clone());
    }
    let answer = crate::sidecar_rpc(app, "createAlbum", serde_json::json!({ "name": folder }))?;
    let uid = answer.get("uid").and_then(|v| v.as_str()).ok_or("no album came back")?.to_string();
    made.insert(folder.to_lowercase(), uid.clone());
    Ok(uid)
}

/// A copy of the file to upload from, in a folder of its own under `pfp-drop`, so the
/// upload reads a file nothing else is changing. The original stays where it was put,
/// and becomes the photo's own copy in the folder once the upload is in the library.
fn stage(path: &Path) -> Option<PathBuf> {
    let name = path.file_name()?;
    let mut tag = [0u8; 8];
    getrandom_fill(&mut tag);
    let folder = std::env::temp_dir()
        .join("pfp-drop")
        .join(tag.iter().map(|b| format!("{b:02x}")).collect::<String>());
    std::fs::create_dir_all(&folder).ok()?;
    let staged = folder.join(name);
    std::fs::copy(path, &staged).ok()?;
    Some(staged)
}

/// Random bytes for a staging folder's name: it only has to differ between uploads.
fn getrandom_fill(out: &mut [u8]) {
    use std::hash::{BuildHasher, Hasher};
    for chunk in out.chunks_mut(8) {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u128(Instant::now().elapsed().as_nanos());
        let bytes = h.finish().to_le_bytes();
        chunk.copy_from_slice(&bytes[..chunk.len()]);
    }
}

/// Uploads a file that arrived in the folder, once it is complete, into the album its
/// folder stands for (made first for a new folder) or onto the timeline.
fn start_upload(app: &tauri::AppHandle, rel: String, album: Option<String>, new_album: Option<String>, favorite: bool) {
    let app = app.clone();
    std::thread::spawn(move || {
        let path = crate::cloud_mount::sync_root_path().join(&rel);
        if !settled(&path) {
            return;
        }
        let folder = rules::name_of(rules::parent_of(&rel)).to_string();
        let album = match (album, new_album) {
            (Some(uid), _) => Some((uid, folder)),
            (None, Some(name)) => match album_for_new_folder(&app, &name) {
                Ok(uid) => Some((uid, name)),
                Err(e) => {
                    crate::note(&app, &format!("[explorer] could not make the album: {e}"));
                    return;
                }
            },
            (None, None) => None,
        };
        let Some(staged) = stage(&path) else {
            crate::note(&app, "[explorer] could not stage a file to upload");
            return;
        };
        let paths = vec![staged.to_string_lossy().into_owned()];
        let prep = crate::upload_frame::prepare(&app, &paths);
        let mut params = serde_json::to_value(&prep).unwrap_or_else(|_| serde_json::json!({}));
        params["paths"] = serde_json::json!(paths);
        params["albumUid"] = serde_json::json!(album.as_ref().map(|a| a.0.clone()));
        params["albumName"] = serde_json::json!(album.as_ref().map(|a| a.1.clone()));
        params["favorite"] = serde_json::json!(favorite);
        match crate::sidecar_rpc(&app, "startDropUpload", params) {
            Ok(_) => {
                use tauri::Emitter;
                // The window's upload panel shows these with its own.
                let _ = app.emit("drive-upload", ());
                watch_uploads(&app);
            }
            Err(e) => {
                // The original is still in the folder; the copy made for this upload goes.
                if let Some(folder) = staged.parent() {
                    let _ = std::fs::remove_dir_all(folder);
                }
                crate::note(&app, &format!("[explorer] upload not started: {e}"));
            }
        }
    });
}

/// Fills the folder again once the uploads have finished, which is what turns each
/// uploaded file into the photo's own copy (`reconcile_existing` adopts a local file that
/// matches the library's byte for byte). One watcher at a time.
fn watch_uploads(app: &tauri::AppHandle) {
    use std::sync::atomic::{AtomicBool, Ordering};
    static WATCHING: AtomicBool = AtomicBool::new(false);
    if WATCHING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let running = |app: &tauri::AppHandle| {
            crate::sidecar_rpc(app, "uploadStatus", serde_json::json!({}))
                .ok()
                .and_then(|s| s.get("running").and_then(|v| v.as_bool()))
                .unwrap_or(false)
        };
        loop {
            std::thread::sleep(Duration::from_secs(3));
            while running(&app) {
                std::thread::sleep(Duration::from_secs(3));
            }
            WATCHING.store(false, Ordering::SeqCst);
            request_refresh(&app);
            // An upload that started after the last look found the flag still up.
            if !running(&app) || WATCHING.swap(true, Ordering::SeqCst) {
                return;
            }
        }
    });
}

/// The ordinary files the folder held when it was last looked at, sealed in the app's
/// folder. Removed at sign-out, so the next account starts from a fresh look.
pub const SEEN_FILE: &str = "explorer-seen.enc";

/// Which of the ordinary files now in the folder are new since the last look. With no
/// earlier look there is nothing to compare against, and nothing is new: the files a
/// version before two-way sync left there, or copies another account kept at its
/// sign-out, are never uploaded without being put there again.
fn new_since(now: &[String], seen: Option<&std::collections::HashSet<String>>) -> Vec<String> {
    let Some(seen) = seen else { return Vec::new() };
    now.iter().filter(|rel| !seen.contains(&rel.to_lowercase())).cloned().collect()
}

/// Files put in the folder while the app was closed, uploaded once it is running again.
/// Only files that arrived since the folder was last looked at count; the first look
/// for an account only notes what is there.
pub fn upload_waiting(app: &tauri::AppHandle) {
    const REPARSE_POINT: u32 = 0x400;
    let root = crate::cloud_mount::sync_root_path();
    let mut folders = vec![rules::PHOTOS.to_string(), format!("{}\\{}", rules::PHOTOS, rules::FAVORITES)];
    if let Ok(entries) = std::fs::read_dir(root.join(rules::ALBUMS)) {
        for entry in entries.flatten() {
            if entry.file_type().is_ok_and(|t| t.is_dir()) {
                folders.push(format!("{}\\{}", rules::ALBUMS, entry.file_name().to_string_lossy()));
            }
        }
    }
    let index = Index { photos: crate::cloud_mount::photos_by_path() };
    let mut present: Vec<String> = Vec::new();
    for folder in folders {
        let Ok(entries) = std::fs::read_dir(root.join(&folder)) else { continue };
        for entry in entries.flatten() {
            use std::os::windows::fs::MetadataExt;
            // The directory entry's own attributes: nothing here opens a placeholder.
            let Ok(meta) = entry.metadata() else { continue };
            if !meta.is_file() || meta.file_attributes() & REPARSE_POINT != 0 {
                continue;
            }
            let rel = format!("{folder}\\{}", entry.file_name().to_string_lossy());
            if !ignorable(&rel) {
                present.push(rel);
            }
        }
    }
    let seen: Option<std::collections::HashSet<String>> =
        crate::secure_store::read_sealed(app, SEEN_FILE).ok().flatten().map(|text| {
            text.lines().map(str::to_string).collect()
        });
    for rel in new_since(&present, seen.as_ref()) {
        let change = Change::Added { rel, dir: false, placeholder: false };
        if let action @ Action::Upload { .. } = rules::action_for(&change, &index) {
            run(app, &action, "");
        }
    }
    let noted: Vec<String> = present.iter().map(|rel| rel.to_lowercase()).collect();
    let _ = crate::secure_store::write_sealed(app, SEEN_FILE, &noted.join("\n"));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_files_that_arrived_since_the_last_look_are_uploaded() {
        let now = vec!["Photos\\kept.jpg".to_string(), "Photos\\new.jpg".to_string()];
        assert!(new_since(&now, None).is_empty(), "a first look uploads nothing");
        let seen: std::collections::HashSet<String> = ["photos\\kept.jpg".to_string()].into_iter().collect();
        assert_eq!(new_since(&now, Some(&seen)), vec!["Photos\\new.jpg".to_string()]);
    }

    static TEST_MARKS: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();

    #[test]
    fn a_mark_lapses_and_then_lets_the_users_change_through() {
        mark(&TEST_MARKS, "Photos\\a.jpg", Duration::from_millis(40));
        assert!(marked(&TEST_MARKS, "photos\\A.JPG"));
        assert!(!marked(&TEST_MARKS, "Photos\\b.jpg"));
        std::thread::sleep(Duration::from_millis(60));
        assert!(!marked(&TEST_MARKS, "Photos\\a.jpg"));
        assert!(OWN_FOR <= Duration::from_secs(5));
    }
}
