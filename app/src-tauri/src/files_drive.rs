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

// The "Proton Photos" place in the Linux file manager.
//
// Windows gets its drive from the Cloud Filter API, and Linux has nothing a sandboxed app
// can reach in its place: a FUSE mount made inside the Flatpak sandbox lives in the
// sandbox's own mount namespace, where the file manager outside never sees it. What every
// Linux file manager does speak is WebDAV. GVfs mounts it for Files, Nemo, Thunar and
// Caja, and KIO does for Dolphin. So the host serves the library as WebDAV on the loopback
// interface and puts a "Proton Photos" bookmark in the GTK sidebar that points at it.
//
// What it allows:
//   - `Photos/` is the timeline and `Albums/<album>/` each album, the layout of the
//     Explorer mount. Opening or copying a file out downloads it through the sidecar.
//   - A file dropped in uploads through the path an in-app drop takes (frames for video
//     and the stills sharp cannot open, then the sidecar's queue, duplicate check and
//     upload panel included). Where it lands follows where it was dropped: a folder at
//     the top or in `Albums/` becomes an album, one in `Photos/` goes to the timeline,
//     and anything in an album's folder goes into that album; a photo already in the
//     library that is copied or dragged there is added to it.
//   - With the Settings option on (the default), deleting and renaming reach the library
//     but never destroy anything: a photo deleted from `Photos/` goes to Proton's trash,
//     one deleted from an album's folder only leaves the album, and a deleted album's
//     photos stay in the library. With it off, nothing leaves the library from here.
//
// Who may connect: this user on this machine, through a file manager. The server listens
// on 127.0.0.1 alone; each request's peer socket is looked up in /proc/net and must belong
// to this uid; the path must start with a random token kept in the app's own config; and a
// request carrying a browser `Origin`, or a `Host` other than the loopback address, is
// refused, which rules out both cross-site requests and DNS rebinding. While the app is
// locked nothing is listed or served.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager};

use crate::notices::{notice_text, Notice};
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

/// The sidebar entry's name, and the mark that tells our bookmark from the user's own.
const LABEL: &str = "Proton Photos";
const PHOTOS: &str = "Photos";
const ALBUMS: &str = "Albums";
const PREFS_FILE: &str = "files-drive.json";
/// The staging folders, under the app's own cache directory. The sidecar checks both
/// names before it will write to or delete from either.
const DROP_DIR: &str = "pfp-drop";
const HYDRATE_DIR: &str = "pfp-hyd";

/// What the sidecar uploads: its `IMAGE_TYPES` and `VIDEO_TYPES`. Anything else dropped
/// in is refused up front, where the file manager can say so, rather than accepted and
/// then silently skipped by the upload.
const UPLOADABLE: &[&str] = &[
    "jpg", "jpeg", "png", "webp", "gif", "avif", "tif", "tiff", "heic", "heif", "dng", "mp4",
    "mov", "m4v", "webm", "mkv", "3gp",
];

/// Photos per listing request. Small, because the enumeration shares the sidecar's
/// background lane with the thumbnails the open window is waiting on.
const PAGE: u64 = 8;
/// A listing older than this is rebuilt in the background when the file manager next
/// looks, which is what picks up changes made on other devices.
const STALE_AFTER: Duration = Duration::from_secs(5 * 60);
/// How many downloaded files are kept for a following request, and for how long. A video
/// player reads one file as a long run of ranged requests, and each would otherwise
/// download it again.
const KEEP_HYDRATED: usize = 4;
const HYDRATED_FOR: Duration = Duration::from_secs(120);
/// How often the listing is read again while a file manager is using the drive, and
/// how long after its last request it counts as using it.
const KEEP_FRESH_EVERY: Duration = Duration::from_secs(120);
const IN_USE_FOR_MS: i64 = 15 * 60_000;
/// How long an empty folder made in `Photos/` stays listed (see `children`).
const TIMELINE_FOLDER_LINGERS_MS: i64 = 10 * 60_000;

// ---- Preferences ----

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct Prefs {
    enabled: bool,
    #[serde(default)]
    port: u16,
    #[serde(default)]
    token: String,
    /// Whether deleting and renaming in the file manager reach the library.
    #[serde(default = "on")]
    edits: bool,
    /// Whether `Photos/` is split into year and month folders. Off unless chosen.
    #[serde(default)]
    by_date: bool,
    /// The name the drive is reached by: `localhost` or an address in 127.0.0.0/8.
    #[serde(default = "loopback")]
    host: String,
    /// Whether `port` was chosen in Settings; otherwise it is the last free one found,
    /// kept so the bookmark stays valid from one run to the next.
    #[serde(default)]
    custom_port: bool,
}

fn on() -> bool {
    true
}

fn loopback() -> String {
    "127.0.0.1".to_string()
}

impl Default for Prefs {
    fn default() -> Self {
        // On by default, as the Explorer drive is on Windows.
        Prefs {
            enabled: true,
            port: 0,
            token: String::new(),
            edits: true,
            by_date: false,
            host: loopback(),
            custom_port: false,
        }
    }
}

fn prefs_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join(PREFS_FILE))
}

fn load_prefs(app: &AppHandle) -> Prefs {
    prefs_path(app)
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn save_prefs(app: &AppHandle, prefs: &Prefs) {
    let Some(path) = prefs_path(app) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(bytes) = serde_json::to_vec(prefs) {
        if std::fs::write(&path, bytes).is_ok() {
            // The token is the one thing standing between another sandboxed app of this
            // user and the library, so the file is this user's alone.
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
    }
}

fn random_hex(bytes: usize) -> String {
    use aes_gcm::aead::rand_core::RngCore;
    let mut raw = vec![0u8; bytes];
    aes_gcm::aead::OsRng.fill_bytes(&mut raw);
    raw.iter().map(|b| format!("{b:02x}")).collect()
}

// ---- The listing ----

struct Photo {
    uid: String,
    name: String,
    size: u64,
    time_ms: i64,
}

struct Album {
    uid: String,
    name: String,
    /// The album's photos: their file name here, and their place in `Index::photos`.
    files: Vec<(String, usize)>,
    /// Lowercased file name to its place in `files`.
    names: HashMap<String, usize>,
}

impl Album {
    fn drop_photo(&mut self, at: usize) {
        self.files.retain(|(_, p)| *p != at);
        self.names = self
            .files
            .iter()
            .enumerate()
            .map(|(i, (name, _))| (name.to_lowercase(), i))
            .collect();
    }
}

/// The library as the drive shows it, built from the same two sidecar calls the Explorer
/// mount is populated from.
#[derive(Default)]
struct Index {
    photos: Vec<Photo>,
    photo_names: HashMap<String, usize>,
    by_uid: HashMap<String, usize>,
    albums: Vec<Album>,
    album_names: HashMap<String, usize>,
    album_by_uid: HashMap<String, usize>,
    /// The timeline photos marked as favourites, by uid.
    favorites: std::collections::HashSet<String>,
    /// `Trash/`, `Shared/` and the shared albums in it: photos that are not on the
    /// timeline, each folder with its own names.
    trash: Shelf,
    shared: Shelf,
    shared_albums: Vec<SharedAlbum>,
    shared_album_names: HashMap<String, usize>,
    built: Option<Instant>,
}

/// A folder of photos outside the timeline, with names unique within it.
#[derive(Default)]
struct Shelf {
    photos: Vec<Photo>,
    names: HashMap<String, usize>,
}

impl Shelf {
    fn push(&mut self, uid: &str, raw_name: &str, size: u64, time_ms: i64) {
        if uid.is_empty() || size == 0 || self.photos.iter().any(|p| p.uid == uid) {
            return;
        }
        let name = unique_name(&sanitize_name(raw_name), |c| self.names.contains_key(c));
        self.names.insert(name.to_lowercase(), self.photos.len());
        self.photos.push(Photo { uid: uid.to_string(), name, size, time_ms });
    }

    fn remove(&mut self, uid: &str) {
        self.names.retain(|_, &mut at| self.photos[at].uid != uid);
    }

    fn get(&self, lower: &str) -> Option<&Photo> {
        self.names.get(lower).map(|&at| &self.photos[at])
    }

    /// The photos still listed, in their order.
    fn listed(&self) -> impl Iterator<Item = &Photo> {
        self.photos
            .iter()
            .enumerate()
            .filter(|(at, p)| self.names.get(&p.name.to_lowercase()) == Some(at))
            .map(|(_, p)| p)
    }

    fn from_json(items: Option<&serde_json::Value>) -> Shelf {
        let mut shelf = Shelf::default();
        for item in items.and_then(|v| v.as_array()).into_iter().flatten() {
            shelf.push(
                item.get("uid").and_then(|v| v.as_str()).unwrap_or_default(),
                item.get("name").and_then(|v| v.as_str()).unwrap_or_default(),
                item.get("size").and_then(|v| v.as_u64()).unwrap_or(0),
                item.get("captureTime").and_then(|v| v.as_i64()).unwrap_or(0),
            );
        }
        shelf
    }
}

struct SharedAlbum {
    uid: String,
    name: String,
    shelf: Shelf,
}

impl Index {
    fn push_photo(&mut self, uid: &str, raw_name: &str, size: u64, time_ms: i64) {
        if uid.is_empty() || size == 0 || self.by_uid.contains_key(uid) {
            return;
        }
        let name = unique_name(&sanitize_name(raw_name), |c| self.photo_names.contains_key(c));
        self.photo_names.insert(name.to_lowercase(), self.photos.len());
        self.by_uid.insert(uid.to_string(), self.photos.len());
        self.photos.push(Photo { uid: uid.to_string(), name, size, time_ms });
    }

    /// The trash and the shared folders, from `listExtrasForMount`.
    fn set_extras(&mut self, extras: &serde_json::Value) {
        self.trash = Shelf::from_json(extras.get("trash"));
        self.shared = Shelf::from_json(extras.get("shared"));
        self.shared_albums.clear();
        self.shared_album_names.clear();
        for album in extras.get("sharedAlbums").and_then(|v| v.as_array()).into_iter().flatten() {
            let uid = album.get("uid").and_then(|v| v.as_str()).unwrap_or_default().to_string();
            let raw = album.get("name").and_then(|v| v.as_str()).unwrap_or("Album");
            let name = unique_name(&sanitize_name(raw), |c| {
                self.shared_album_names.contains_key(c) || self.shared.names.contains_key(c)
            });
            self.shared_album_names.insert(name.to_lowercase(), self.shared_albums.len());
            self.shared_albums.push(SharedAlbum { uid, name, shelf: Shelf::from_json(album.get("photos")) });
        }
    }

    /// A photo just sent to the trash: out of the timeline and its albums, into `Trash/`.
    fn trash_photo(&mut self, uid: &str) {
        if let Some(&at) = self.by_uid.get(uid) {
            let p = &self.photos[at];
            let (name, size, time_ms) = (p.name.clone(), p.size, p.time_ms);
            self.trash.push(uid, &name, size, time_ms);
        }
        self.favorites.remove(uid);
        self.forget_photo(uid);
    }

    /// A photo just restored: out of `Trash/`, back on the timeline.
    fn restore_photo(&mut self, uid: &str) {
        let restored = self.trash.photos.iter().find(|p| p.uid == uid).map(|p| (p.name.clone(), p.size, p.time_ms));
        self.trash.remove(uid);
        let Some((name, size, time_ms)) = restored else { return };
        if let Some(at) = self.photos.iter().position(|p| p.uid == uid) {
            // Forgotten earlier while the app ran: linked back in where it was.
            let name = unique_name(&name, |c| self.photo_names.contains_key(c));
            self.photos[at].name = name.clone();
            self.photo_names.insert(name.to_lowercase(), at);
            self.by_uid.insert(uid.to_string(), at);
        } else {
            self.push_photo(uid, &name, size, time_ms);
        }
    }

    // The changes below keep the listing true the moment a change made through the drive
    // succeeds: the file manager looks again straight away, long before the rebuild that
    // follows every change. An entry is unlinked from the maps and skipped when listed,
    // rather than taken out of its vector, so every index into those stays valid.

    fn forget_photo(&mut self, uid: &str) {
        let Some(at) = self.by_uid.remove(uid) else { return };
        self.photo_names.remove(&self.photos[at].name.to_lowercase());
        for album in &mut self.albums {
            album.drop_photo(at);
        }
    }

    fn remove_from_album(&mut self, album_uid: &str, uid: &str) {
        if let (Some(&a), Some(&at)) = (self.album_by_uid.get(album_uid), self.by_uid.get(uid)) {
            self.albums[a].drop_photo(at);
        }
    }

    fn add_to_album(&mut self, album_uid: &str, uid: &str) {
        let (Some(&a), Some(&at)) = (self.album_by_uid.get(album_uid), self.by_uid.get(uid)) else {
            return;
        };
        let album = &mut self.albums[a];
        if album.files.iter().any(|(_, p)| *p == at) {
            return;
        }
        let name = unique_name(&self.photos[at].name, |c| album.names.contains_key(c));
        album.names.insert(name.to_lowercase(), album.files.len());
        album.files.push((name, at));
    }

    fn rename_photo(&mut self, uid: &str, name: &str) {
        let Some(&at) = self.by_uid.get(uid) else { return };
        let old = std::mem::replace(&mut self.photos[at].name, name.to_string());
        self.photo_names.remove(&old.to_lowercase());
        self.photo_names.insert(name.to_lowercase(), at);
        for album in &mut self.albums {
            let Some(i) = album.files.iter().position(|(_, p)| *p == at) else { continue };
            album.names.remove(&album.files[i].0.to_lowercase());
            let fresh = unique_name(name, |c| album.names.contains_key(c));
            album.names.insert(fresh.to_lowercase(), i);
            album.files[i].0 = fresh;
        }
    }

    fn rename_album(&mut self, uid: &str, name: &str) {
        let Some(&a) = self.album_by_uid.get(uid) else { return };
        let old = std::mem::replace(&mut self.albums[a].name, name.to_string());
        self.album_names.remove(&old.to_lowercase());
        self.album_names.insert(name.to_lowercase(), a);
    }

    fn forget_album(&mut self, uid: &str) {
        if let Some(a) = self.album_by_uid.remove(uid) {
            self.album_names.remove(&self.albums[a].name.to_lowercase());
        }
    }

    /// Whether the photo at `at` is still listed (not forgotten since the last build).
    fn has_photo(&self, at: usize) -> bool {
        self.by_uid.get(&self.photos[at].uid) == Some(&at)
    }

    fn has_album(&self, a: usize) -> bool {
        self.album_by_uid.get(&self.albums[a].uid) == Some(&a)
    }

    /// The year and month of every listed timeline photo.
    fn dates(&self) -> impl Iterator<Item = (i32, u32)> + '_ {
        self.photos
            .iter()
            .enumerate()
            .filter(|(i, _)| self.has_photo(*i))
            .map(|(_, p)| year_month(p.time_ms))
    }

    /// The years the timeline has photos in, newest first.
    fn years(&self) -> Vec<i32> {
        let mut years: Vec<i32> = self.dates().map(|(y, _)| y).collect();
        years.sort_unstable_by(|a, b| b.cmp(a));
        years.dedup();
        years
    }

    /// A year's months that have photos, newest first.
    fn months(&self, year: i32) -> Vec<u32> {
        let mut months: Vec<u32> = self.dates().filter(|(y, _)| *y == year).map(|(_, m)| m).collect();
        months.sort_unstable_by(|a, b| b.cmp(a));
        months.dedup();
        months
    }

    fn has_year(&self, year: i32) -> bool {
        self.dates().any(|(y, _)| y == year)
    }

    fn has_month(&self, year: i32, month: u32) -> bool {
        self.dates().any(|date| date == (year, month))
    }

    fn set_albums(&mut self, albums: &[serde_json::Value]) {
        self.albums.clear();
        self.album_names.clear();
        self.album_by_uid.clear();
        for album in albums {
            let uid = album.get("uid").and_then(|v| v.as_str()).unwrap_or_default();
            if uid.is_empty() || self.album_by_uid.contains_key(uid) {
                continue;
            }
            let raw = album.get("name").and_then(|v| v.as_str()).unwrap_or("Album");
            let name = unique_name(&sanitize_name(raw), |c| self.album_names.contains_key(c));
            let mut entry = Album { uid: uid.to_string(), name, files: Vec::new(), names: HashMap::new() };
            for member in album.get("uids").and_then(|v| v.as_array()).into_iter().flatten() {
                // A photo the timeline does not list (one shared into the album by
                // someone else) has no name or size here, as on Windows.
                let Some(&at) = member.as_str().and_then(|u| self.by_uid.get(u)) else { continue };
                let file = unique_name(&self.photos[at].name, |c| entry.names.contains_key(c));
                entry.names.insert(file.to_lowercase(), entry.files.len());
                entry.files.push((file, at));
            }
            self.album_names.insert(entry.name.to_lowercase(), self.albums.len());
            self.album_by_uid.insert(entry.uid.clone(), self.albums.len());
            self.albums.push(entry);
        }
    }
}

/// A name the file manager can show and a path can carry: no separator, no control
/// character, not `.` or `..`, and short enough for any filesystem it is copied to.
fn sanitize_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c == '/' || c == '\\' || c.is_control() { '_' } else { c })
        .collect();
    let mut cleaned = cleaned.trim().to_string();
    while cleaned.len() > 240 {
        cleaned.pop();
    }
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        return "photo".to_string();
    }
    cleaned
}

/// `base`, or `base (2)`, `base (3)`, ... before the extension, whichever is free.
/// `taken` is asked about the lowercased candidate, so two names differing only in case
/// never share a folder: copied onto a case-insensitive disk, one would overwrite the other.
fn unique_name(base: &str, taken: impl Fn(&str) -> bool) -> String {
    if !taken(&base.to_lowercase()) {
        return base.to_string();
    }
    let (stem, ext) = match base.rfind('.') {
        Some(i) if i > 0 => (&base[..i], &base[i..]),
        _ => (base, ""),
    };
    for n in 2..100_000 {
        let candidate = format!("{stem} ({n}){ext}");
        if !taken(&candidate.to_lowercase()) {
            return candidate;
        }
    }
    base.to_string()
}

// ---- What was dropped in ----

/// Where the files dropped anywhere under a folder go.
enum Target {
    Existing(String),
    /// Made on the first photo dropped in, so a folder holding none never leaves an
    /// empty album behind. Every sub-folder shares its top folder's target, since a
    /// folder uploads as one album, however deep its photos sit.
    New { name: String, uid: Option<String> },
    /// A folder dropped into `Photos/`, which is the timeline: its photos go there and
    /// no album is made, since albums live in `Albums/`.
    Timeline,
}

/// What a new folder (MKCOL) stands for, by where it was made. Every place takes one,
/// so a folder dropped anywhere lands somewhere that makes sense.
#[derive(Debug, PartialEq)]
enum NewFolder {
    /// At the top or in `Albums/`: a new album named after it.
    Album,
    /// In `Photos/`: its photos go to the timeline.
    Timeline,
    /// Inside an album's folder or a folder made here: whatever that one stands for.
    Inherit,
    /// In Favorites, the trash or what is shared: there is nothing a folder could be.
    Refused,
}

fn new_folder_kind(parent: &Dir) -> NewFolder {
    match parent {
        Dir::Root | Dir::Albums => NewFolder::Album,
        Dir::Photos | Dir::Year(_) | Dir::Month(..) => NewFolder::Timeline,
        Dir::Album { .. } | Dir::Folder(_) => NewFolder::Inherit,
        Dir::Favorites | Dir::Trash | Dir::Shared | Dir::SharedAlbum { .. } => NewFolder::Refused,
    }
}

/// A folder the file manager made (MKCOL) to copy a folder in. It exists only on this
/// side, until its photos are uploaded and it shows among the albums.
#[derive(Clone)]
struct Folder {
    name: String,
    /// The lowercased path of the folder it sits in.
    parent: String,
    target: Arc<Mutex<Target>>,
    /// The folder whose MKCOL made a new album, which lists that album's photos once they
    /// have uploaded, so the folder that was dropped in shows what went into it.
    origin: bool,
    made_ms: i64,
}

/// A file PUT and not yet uploaded, listed where it was dropped until then, so the file
/// manager finds what it has just written.
struct Staged {
    dir: String,
    name: String,
    path: PathBuf,
    size: u64,
    time_ms: i64,
}

struct Hydrated {
    uid: String,
    path: PathBuf,
    used: Instant,
    progress: Arc<Progress>,
    /// Requests reading it right now: one being read is never dropped or stopped.
    readers: Arc<std::sync::atomic::AtomicUsize>,
}

// ---- The drive ----

struct Drive {
    app: AppHandle,
    server: Arc<Server>,
    /// The name it is reached by, the address it listens on, and every name a request
    /// may call it by (see `host_names`).
    host: String,
    ip: std::net::Ipv4Addr,
    hosts: Vec<String>,
    port: u16,
    token: String,
    uid: u32,
    /// Whether the sidecar holds an unlocked session. Nothing is listed or served without.
    live: AtomicBool,
    /// Bumped as a session ends, so work started for the old one is thrown away.
    session: AtomicU64,
    index: RwLock<Index>,
    refreshing: Mutex<(bool, bool)>,
    refresh_soon: AtomicBool,
    watching_uploads: AtomicBool,
    hydrated: Mutex<Vec<Hydrated>>,
    hydrating: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// How many downloads may run at once, and who waits for one (see `Slots`).
    slots: Slots,
    folders: Mutex<HashMap<String, Folder>>,
    staged: Mutex<Vec<Staged>>,
    /// Deletes being counted into one notice each (see `tell`).
    notices: Mutex<HashMap<Notice, usize>>,
    /// Whether this process has already retried the staged uploads an earlier one left.
    retried: AtomicBool,
    /// Whether deleting and renaming reach the library (the Settings option).
    edits: AtomicBool,
    /// Whether `Photos/` is split into year and month folders (the Settings option).
    by_date: AtomicBool,
    /// When a file manager last asked anything, in Unix milliseconds.
    last_request: std::sync::atomic::AtomicI64,
    drop_root: PathBuf,
    hydrate_root: PathBuf,
}

static DRIVE: Mutex<Option<Arc<Drive>>> = Mutex::new(None);

fn drive() -> Option<Arc<Drive>> {
    DRIVE.lock().unwrap().clone()
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// A staging folder only this user can read.
fn private_dir(dir: &Path) {
    if std::fs::create_dir_all(dir).is_ok() {
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
}

/// Start serving, when the preference is on. Once per process, from the app's startup.
pub fn start(app: &AppHandle) {
    let mut prefs = load_prefs(app);
    if !prefs.enabled {
        // Switched off while the app was not running: the bookmarks go too.
        write_bookmark(None);
        write_kde_place(None);
        return;
    }
    if drive().is_some() {
        return;
    }
    if prefs.token.len() < 32 {
        prefs.token = random_hex(16);
    }
    let (host, ip, _) = parse_address(&prefs.host, "")
        .unwrap_or_else(|_| (loopback(), std::net::Ipv4Addr::LOCALHOST, 0));
    // The same port as last time keeps the bookmark valid; when something else holds
    // it now, any free one does and the bookmark is rewritten. A port chosen in Settings
    // is tried again at the next start.
    let server = Server::http((ip, prefs.port)).or_else(|_| Server::http((ip, 0)));
    let server = match server {
        Ok(s) => Arc::new(s),
        Err(e) => {
            crate::note(app, &format!("[drive] could not listen: {e}"));
            return;
        }
    };
    let Some(port) = server.server_addr().to_ip().map(|a| a.port()) else { return };
    if !prefs.custom_port {
        prefs.port = port;
    }
    save_prefs(app, &prefs);

    let Ok(cache) = app.path().app_cache_dir() else { return };
    let drop_root = cache.join(DROP_DIR);
    let hydrate_root = cache.join(HYDRATE_DIR);
    // Downloads an earlier run left behind are plaintext nothing will collect, and go.
    // Staged uploads stay: each may be the only copy left of a file moved in, and the
    // first unlock uploads them again.
    let _ = std::fs::remove_dir_all(&hydrate_root);
    private_dir(&drop_root);
    private_dir(&hydrate_root);

    let uid = std::fs::metadata("/proc/self").map(|m| m.uid()).unwrap_or(u32::MAX);
    let drive = Arc::new(Drive {
        app: app.clone(),
        server: server.clone(),
        hosts: host_names(&host, ip),
        host,
        ip,
        port,
        token: prefs.token.clone(),
        uid,
        live: AtomicBool::new(false),
        session: AtomicU64::new(0),
        index: RwLock::new(Index::default()),
        refreshing: Mutex::new((false, false)),
        refresh_soon: AtomicBool::new(false),
        watching_uploads: AtomicBool::new(false),
        hydrated: Mutex::new(Vec::new()),
        hydrating: Mutex::new(HashMap::new()),
        slots: Slots::default(),
        folders: Mutex::new(HashMap::new()),
        staged: Mutex::new(Vec::new()),
        retried: AtomicBool::new(false),
        notices: Mutex::new(HashMap::new()),
        edits: AtomicBool::new(prefs.edits),
        by_date: AtomicBool::new(prefs.by_date),
        last_request: std::sync::atomic::AtomicI64::new(0),
        drop_root,
        hydrate_root,
    });
    *DRIVE.lock().unwrap() = Some(drive.clone());

    let serving = drive.clone();
    std::thread::spawn(move || {
        for request in serving.server.incoming_requests() {
            let d = serving.clone();
            std::thread::spawn(move || handle(&d, request));
        }
    });
    // Downloaded copies are plaintext, so they are dropped on a clock as well as when
    // pushed out, and never outlive their two minutes for want of a next request.
    let janitor = Arc::downgrade(&drive);
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(30));
        let Some(d) = janitor.upgrade() else { return };
        sweep_hydrated(&d, false);
    });
    // What changed on other devices shows the next time a folder is opened: while a file
    // manager is using the drive, the listing is read again every couple of minutes. The
    // file manager itself cannot be told (GVfs watches nothing over WebDAV).
    let watcher = Arc::downgrade(&drive);
    std::thread::spawn(move || loop {
        std::thread::sleep(KEEP_FRESH_EVERY);
        let Some(d) = watcher.upgrade() else { return };
        let recent = now_ms() - d.last_request.load(Ordering::SeqCst) < IN_USE_FOR_MS;
        if recent && d.live.load(Ordering::SeqCst) {
            refresh(&d);
        }
    });

    write_bookmark(Some(&drive.address()));
    write_kde_place(Some(&drive.address().replacen("dav://", "webdav://", 1)));
    crate::note(app, "[drive] serving the file-manager drive on the loopback interface");
}

/// Stop serving and take the bookmark away.
fn stop() {
    let Some(d) = DRIVE.lock().unwrap().take() else {
        write_bookmark(None);
        write_kde_place(None);
        return;
    };
    d.live.store(false, Ordering::SeqCst);
    d.session.fetch_add(1, Ordering::SeqCst);
    d.server.unblock();
    sweep_hydrated(&d, true);
    write_bookmark(None);
    write_kde_place(None);
}

impl Drive {
    fn address(&self) -> String {
        format!("dav://{}:{}/{}/", self.host, self.port, self.token)
    }
}

// ---- Session hooks, from the host's RPC bridge ----

/// The sidecar has an unlocked session: the timeline just loaded.
pub fn session_started() {
    if let Some(d) = drive() {
        if !d.live.swap(true, Ordering::SeqCst) {
            refresh(&d);
        }
        if !d.retried.swap(true, Ordering::SeqCst) {
            std::thread::spawn(move || retry_staged(&d));
        }
    }
}

/// The session is ending (lock or sign-out). Called BEFORE the sidecar is asked, so no
/// request is answered from a library the user has just locked away.
pub fn session_ended() {
    let Some(d) = drive() else { return };
    d.live.store(false, Ordering::SeqCst);
    d.session.fetch_add(1, Ordering::SeqCst);
    *d.index.write().unwrap() = Index::default();
    d.folders.lock().unwrap().clear();
    d.staged.lock().unwrap().clear();
    sweep_hydrated(&d, true);
}

/// Something in the app changed the library; the listing catches up shortly after.
pub fn library_changed() {
    let Some(d) = drive() else { return };
    if !d.live.load(Ordering::SeqCst) || d.refresh_soon.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        // A burst of changes (a multi-select trash, an album being filled) lands as one.
        std::thread::sleep(Duration::from_secs(4));
        d.refresh_soon.store(false, Ordering::SeqCst);
        refresh(&d);
    });
}

/// An upload started, in the app or through the drive: the listing is rebuilt once the
/// queue has drained, so the new photos show up in the file manager.
pub fn upload_started() {
    if let Some(d) = drive() {
        watch_uploads(&d);
    }
}

fn watch_uploads(d: &Arc<Drive>) {
    if d.watching_uploads.swap(true, Ordering::SeqCst) {
        return;
    }
    let d = d.clone();
    std::thread::spawn(move || {
        let running = |d: &Drive| {
            crate::sidecar_rpc(&d.app, "uploadStatus", serde_json::json!({}))
                .ok()
                .and_then(|s| s.get("running").and_then(|v| v.as_bool()))
                .unwrap_or(false)
        };
        loop {
            std::thread::sleep(Duration::from_secs(3));
            while d.live.load(Ordering::SeqCst) && running(&d) {
                std::thread::sleep(Duration::from_secs(3));
            }
            d.watching_uploads.store(false, Ordering::SeqCst);
            refresh(&d);
            // An upload that started between the last look and the flag going down found
            // the flag still up, so it is picked up here rather than missed.
            if !d.live.load(Ordering::SeqCst)
                || !running(&d)
                || d.watching_uploads.swap(true, Ordering::SeqCst)
            {
                return;
            }
        }
    });
}

/// Rebuild the listing in the background; one build at a time, and one more queued at most.
fn refresh(d: &Arc<Drive>) {
    {
        let mut state = d.refreshing.lock().unwrap();
        if state.0 {
            state.1 = true;
            return;
        }
        *state = (true, false);
    }
    let d = d.clone();
    std::thread::spawn(move || loop {
        build(&d);
        let mut state = d.refreshing.lock().unwrap();
        if state.1 {
            state.1 = false;
            continue;
        }
        state.0 = false;
        return;
    });
}

fn build(d: &Drive) {
    let session = d.session.load(Ordering::SeqCst);
    if !d.live.load(Ordering::SeqCst) {
        return;
    }
    // The first listing of a session fills the live one page by page, so the file manager
    // shows photos while a large library is still being read. A later rebuild is made on
    // the side and swapped in whole, so nothing a user is looking at blinks out meanwhile.
    let first = d.index.read().unwrap().photos.is_empty();
    let mut fresh = Index::default();
    let mut offset = 0u64;
    loop {
        let page = match crate::sidecar_rpc(
            &d.app,
            "listForMount",
            serde_json::json!({ "offset": offset, "limit": PAGE }),
        ) {
            Ok(p) => p,
            Err(e) => {
                crate::note(&d.app, &format!("[drive] listing stopped: {e}"));
                return;
            }
        };
        let items = page.get("items").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        let total = page.get("total").and_then(|v| v.as_u64()).unwrap_or(0);
        let fill = |index: &mut Index| {
            for item in &items {
                index.push_photo(
                    item.get("uid").and_then(|v| v.as_str()).unwrap_or_default(),
                    item.get("name").and_then(|v| v.as_str()).unwrap_or_default(),
                    item.get("size").and_then(|v| v.as_u64()).unwrap_or(0),
                    item.get("captureTime").and_then(|v| v.as_i64()).unwrap_or(0),
                );
                if item.get("favorite").and_then(|v| v.as_bool()) == Some(true) {
                    if let Some(uid) = item.get("uid").and_then(|v| v.as_str()) {
                        index.favorites.insert(uid.to_string());
                    }
                }
            }
        };
        if first {
            let mut live = d.index.write().unwrap();
            // Checked under the lock `session_ended` clears it under, so a page read for a
            // session that has just ended can never land in the next one's listing.
            if d.session.load(Ordering::SeqCst) != session {
                return;
            }
            fill(&mut *live);
        } else {
            fill(&mut fresh);
        }
        offset += PAGE;
        if total == 0 || offset >= total {
            break;
        }
        if d.session.load(Ordering::SeqCst) != session {
            return;
        }
        // Room for the window's own requests between pages.
        std::thread::sleep(Duration::from_millis(100));
    }

    let albums = match crate::sidecar_rpc(&d.app, "listAlbumsForMount", serde_json::json!({})) {
        Ok(v) => v.as_array().cloned().unwrap_or_default(),
        Err(e) => {
            crate::note(&d.app, &format!("[drive] albums skipped: {e}"));
            Vec::new()
        }
    };
    // The trash and what others shared: a failure leaves those two folders empty and
    // everything else as it is.
    let extras = crate::sidecar_rpc(&d.app, "listExtrasForMount", serde_json::json!({}))
        .unwrap_or_else(|e| {
            crate::note(&d.app, &format!("[drive] trash and shared skipped: {e}"));
            serde_json::json!({})
        });
    let mut live = d.index.write().unwrap();
    if d.session.load(Ordering::SeqCst) != session {
        return;
    }
    if first {
        live.set_albums(&albums);
        live.set_extras(&extras);
        live.built = Some(Instant::now());
    } else {
        fresh.set_albums(&albums);
        fresh.set_extras(&extras);
        fresh.built = Some(Instant::now());
        *live = fresh;
    }
    crate::note(
        &d.app,
        &format!("[drive] listing: {} photos, {} albums", live.photos.len(), live.albums.len()),
    );
}

// ---- Downloaded copies ----

/// How many photos download at once. A file manager showing thumbnails asks for every
/// image in a folder together, and each is a whole download: unbounded, a few hundred ran
/// at once and choked the sidecar the whole app talks through.
const MAX_DOWNLOADS: usize = 3;
/// How many may wait for one; past it a request is turned away rather than parked.
const MAX_WAITING: usize = 256;
/// How long a download nobody is reading any more is kept going, in case it is asked for
/// again (a player reopening, a thumbnail being retried), before it is stopped.
const ABANDONED_AFTER: Duration = Duration::from_secs(15);

/// The download places: `MAX_DOWNLOADS` of them, handed out newest request first. A photo
/// someone just opened is asked for after a thumbnailer's run of requests, and it is the
/// one somebody is looking at, so it goes ahead of them.
#[derive(Default)]
struct Slots(Arc<SlotsInner>);

#[derive(Default)]
struct SlotsInner {
    state: Mutex<SlotState>,
    freed: std::sync::Condvar,
}

#[derive(Default)]
struct SlotState {
    running: usize,
    /// Waiting tickets, the newest last.
    waiting: Vec<u64>,
    next: u64,
}

/// A place held for as long as one download runs; given back when dropped.
struct Slot(Arc<SlotsInner>);

impl Drop for Slot {
    fn drop(&mut self) {
        self.0.state.lock().unwrap().running -= 1;
        self.0.freed.notify_all();
    }
}

impl Slots {
    /// Wait for a place; `None` when too many already wait.
    fn take(&self) -> Option<Slot> {
        let inner = &self.0;
        let mut state = inner.state.lock().unwrap();
        if state.waiting.len() >= MAX_WAITING {
            return None;
        }
        let ticket = state.next;
        state.next += 1;
        state.waiting.push(ticket);
        while state.running >= MAX_DOWNLOADS || state.waiting.last() != Some(&ticket) {
            state = inner.freed.wait(state).unwrap();
        }
        state.waiting.pop();
        state.running += 1;
        drop(state);
        // The next newest may be able to go too.
        inner.freed.notify_all();
        Some(Slot(inner.clone()))
    }
}

/// How far one download has got, set by the thread that watches it.
#[derive(Default)]
struct Progress {
    done: AtomicBool,
    failed: AtomicBool,
}

impl Progress {
    fn finished() -> Arc<Progress> {
        let p = Progress::default();
        p.done.store(true, Ordering::SeqCst);
        Arc::new(p)
    }
}

/// A file being downloaded while it is read: a read that reaches what has arrived so far
/// waits for more rather than ending, so a player can start on a video long before its
/// last byte is in. Seeking past what has arrived waits the same way.
struct Growing {
    file: File,
    progress: Arc<Progress>,
    waiting_since: Option<Instant>,
    /// The count of requests reading this download, which this one is part of until it
    /// is dropped.
    readers: Arc<std::sync::atomic::AtomicUsize>,
}

impl Growing {
    fn new(file: File, progress: Arc<Progress>, readers: Arc<std::sync::atomic::AtomicUsize>) -> Growing {
        readers.fetch_add(1, Ordering::SeqCst);
        Growing { file, progress, waiting_since: None, readers }
    }
}

impl Drop for Growing {
    fn drop(&mut self) {
        self.readers.fetch_sub(1, Ordering::SeqCst);
    }
}

/// How long a read waits for the next bytes before giving up on a stalled download.
const STALLED_AFTER: Duration = Duration::from_secs(120);

impl Read for Growing {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        loop {
            let n = self.file.read(buf)?;
            if n > 0 {
                self.waiting_since = None;
                return Ok(n);
            }
            if self.progress.failed.load(Ordering::SeqCst) {
                return Err(std::io::Error::other("the download failed"));
            }
            // Complete: whatever arrived after the read above is read now, and an empty
            // read after that is the real end.
            if self.progress.done.load(Ordering::SeqCst) {
                return self.file.read(buf);
            }
            if self.waiting_since.get_or_insert_with(Instant::now).elapsed() > STALLED_AFTER {
                return Err(std::io::Error::other("the download stalled"));
            }
            std::thread::sleep(Duration::from_millis(40));
        }
    }
}

impl Seek for Growing {
    fn seek(&mut self, to: SeekFrom) -> std::io::Result<u64> {
        self.file.seek(to)
    }
}

fn running(h: &Hydrated) -> bool {
    !h.progress.done.load(Ordering::SeqCst) && !h.progress.failed.load(Ordering::SeqCst)
}

fn read_now(h: &Hydrated) -> bool {
    h.readers.load(Ordering::SeqCst) > 0
}

/// Stop a download that is still running, off the caller's thread.
fn cancel_download(d: &Drive, h: &Hydrated) {
    if !running(h) {
        return;
    }
    let app = d.app.clone();
    let path = h.path.to_string_lossy().into_owned();
    std::thread::spawn(move || {
        let _ = crate::sidecar_rpc(&app, "cancelHydrate", serde_json::json!({ "path": path }));
    });
}

/// Drop copies unused for `HYDRATED_FOR` and stop downloads nobody has read for
/// `ABANDONED_AFTER`, or with `all`, everything. A copy being read stays, except with
/// `all` (a lock), where the reader's open file keeps what it has and gets no more.
fn sweep_hydrated(d: &Drive, all: bool) {
    let mut list = d.hydrated.lock().unwrap();
    list.retain(|h| {
        let idle = h.used.elapsed();
        let keep = !all
            && (read_now(h) || (idle < HYDRATED_FOR && !(running(h) && idle > ABANDONED_AFTER)));
        if !keep {
            cancel_download(d, h);
            let _ = std::fs::remove_file(&h.path);
        }
        keep
    });
    d.hydrating.lock().unwrap().retain(|_, gate| Arc::strong_count(gate) > 1);
}

/// The photo's bytes as they download through the sidecar, or reused from a moment ago.
/// `size` is the size listed for it, which is how its download is known to be complete
/// without asking.
fn hydrated_file(d: &Drive, uid: &str, size: u64) -> Result<Growing, String> {
    // One download per photo at a time: a player's run of ranged requests all share it.
    let gate = d.hydrating.lock().unwrap().entry(uid.to_string()).or_default().clone();
    let _held = gate.lock().unwrap();

    let known = d.hydrated.lock().unwrap().iter_mut().find(|h| h.uid == uid).map(|h| {
        h.used = Instant::now();
        (h.path.clone(), h.progress.clone(), h.readers.clone())
    });
    if let Some((path, progress, readers)) = known {
        if !progress.failed.load(Ordering::SeqCst) {
            if let Ok(file) = File::open(&path) {
                return Ok(Growing::new(file, progress, readers));
            }
        }
    }

    let Some(slot) = d.slots.take() else { return Err("busy".into()) };
    let session = d.session.load(Ordering::SeqCst);
    if !d.live.load(Ordering::SeqCst) {
        return Err("locked".into());
    }
    let result = crate::sidecar_rpc(
        &d.app,
        "startHydrate",
        serde_json::json!({ "uid": uid, "dir": d.hydrate_root.to_string_lossy() }),
    )?;
    let path = PathBuf::from(result.get("path").and_then(|v| v.as_str()).ok_or("no path")?);
    let file = File::open(&path).map_err(|e| e.to_string());
    let progress = Arc::new(Progress::default());
    let readers = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let entry = Hydrated {
        uid: uid.to_string(),
        path: path.clone(),
        used: Instant::now(),
        progress: progress.clone(),
        readers: readers.clone(),
    };
    if file.is_err() || d.session.load(Ordering::SeqCst) != session {
        // Locked meanwhile: the copy must not stay behind for anyone.
        cancel_download(d, &entry);
        let _ = std::fs::remove_file(&path);
        return Err("locked".into());
    }

    // The slot goes with the watcher and is given back when the download ends, so no
    // more than `MAX_DOWNLOADS` run, and no more than that many watchers ask after them.
    let watched = progress.clone();
    let watch_path = path.clone();
    let app = d.app.clone();
    std::thread::spawn(move || {
        let _slot = slot;
        let path_text = watch_path.to_string_lossy().into_owned();
        loop {
            std::thread::sleep(Duration::from_millis(300));
            // All of it on disk is all of it: no need to ask.
            if size > 0 && std::fs::metadata(&watch_path).is_ok_and(|m| m.len() >= size) {
                watched.done.store(true, Ordering::SeqCst);
                return;
            }
            match crate::sidecar_rpc(&app, "hydrateProgress", serde_json::json!({ "path": path_text })) {
                Ok(v) if v.get("done").and_then(|b| b.as_bool()) == Some(true) => {
                    watched.done.store(true, Ordering::SeqCst);
                    return;
                }
                Ok(v) if v.get("error").is_some_and(|e| !e.is_null()) => {
                    watched.failed.store(true, Ordering::SeqCst);
                    return;
                }
                Ok(_) => {}
                Err(_) => {
                    watched.failed.store(true, Ordering::SeqCst);
                    return;
                }
            }
        }
    });

    d.hydrated.lock().unwrap().push(entry);
    sweep_overflow(d);
    Ok(Growing::new(file?, progress, readers))
}

/// Past `KEEP_HYDRATED`, drop the least recently used copies nobody is reading.
fn sweep_overflow(d: &Drive) {
    let mut list = d.hydrated.lock().unwrap();
    while list.len() > KEEP_HYDRATED {
        let Some(oldest) = (0..list.len()).filter(|&i| !read_now(&list[i])).min_by_key(|&i| list[i].used)
        else {
            break;
        };
        let gone = list.remove(oldest);
        cancel_download(d, &gone);
        let _ = std::fs::remove_file(&gone.path);
    }
}

// ---- Who may ask ----

fn header<'a>(request: &'a Request, name: &'static str) -> Option<&'a str> {
    request
        .headers()
        .iter()
        .find(|h| h.field.equiv(name))
        .map(|h| h.value.as_str())
}

/// Whether a Host header names this drive: one of its names (see `Drive::hosts`) with
/// its port.
fn host_ok(host: &str, names: &[String], port: u16) -> bool {
    names.iter().any(|name| host.eq_ignore_ascii_case(&format!("{name}:{port}")))
}

/// The names a request may call the drive by: the one chosen in Settings, the address it
/// listens on, and `localhost` when that is 127.0.0.1, which it resolves to.
fn host_names(host: &str, ip: std::net::Ipv4Addr) -> Vec<String> {
    let mut names = vec![host.to_string(), ip.to_string()];
    if ip == std::net::Ipv4Addr::LOCALHOST {
        names.push("localhost".to_string());
    }
    names.dedup();
    names
}

/// The address the drive listens on, from what Settings was given: `localhost` or an
/// address in 127.0.0.0/8, and a port from 1024 up, or none for any free one. Never one
/// another machine can reach: the drive's whole protection starts from nothing but local
/// connections arriving. The error is a code the page translates.
fn parse_address(host: &str, port: &str) -> Result<(String, std::net::Ipv4Addr, u16), &'static str> {
    let host = host.trim().to_ascii_lowercase();
    let (name, ip) = match host.as_str() {
        "" | "127.0.0.1" => ("127.0.0.1".to_string(), std::net::Ipv4Addr::LOCALHOST),
        "localhost" => ("localhost".to_string(), std::net::Ipv4Addr::LOCALHOST),
        other => match other.parse::<std::net::Ipv4Addr>() {
            Ok(ip) if ip.is_loopback() => (ip.to_string(), ip),
            _ => return Err("address"),
        },
    };
    let port = match port.trim() {
        "" | "0" => 0,
        p => match p.parse::<u16>() {
            Ok(n) if n >= 1024 => n,
            _ => return Err("port"),
        },
    };
    Ok((name, ip, port))
}

/// Whether an address as /proc/net prints it (hex, the kernel's native word order) is in
/// 127.0.0.0/8: an IPv4 one, or one mapped into IPv6.
fn is_loopback_hex(ip: &str) -> bool {
    let word = match ip.len() {
        8 => ip,
        32 if ip[..24].eq_ignore_ascii_case("0000000000000000FFFF0000") => &ip[24..],
        _ => return false,
    };
    u32::from_str_radix(word, 16).is_ok_and(|w| w.to_ne_bytes()[0] == 127)
}

/// The uid owning the client end of a loopback connection to our port, from a
/// /proc/net/tcp or tcp6 table.
fn uid_in_table(table: &str, client: u16, server: u16) -> Option<u32> {
    for line in table.lines().skip(1) {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 8 {
            continue;
        }
        let (Some((local_ip, local_port)), Some((remote_ip, remote_port))) =
            (fields[1].rsplit_once(':'), fields[2].rsplit_once(':'))
        else {
            continue;
        };
        if !is_loopback_hex(local_ip) || !is_loopback_hex(remote_ip) {
            continue;
        }
        if u16::from_str_radix(local_port, 16) == Ok(client)
            && u16::from_str_radix(remote_port, 16) == Ok(server)
        {
            return fields[7].parse().ok();
        }
    }
    None
}

fn peer_uid(client: u16, server: u16) -> Option<u32> {
    ["/proc/net/tcp", "/proc/net/tcp6"]
        .iter()
        .find_map(|t| uid_in_table(&std::fs::read_to_string(t).ok()?, client, server))
}

fn authorised(d: &Drive, request: &Request) -> bool {
    let Some(peer) = request.remote_addr() else { return false };
    if !peer.ip().is_loopback() {
        return false;
    }
    // Browsers name the page behind every cross-origin request; file managers never do.
    if header(request, "Origin").is_some() {
        return false;
    }
    // A hostile name made to resolve to 127.0.0.1 still sends its own name as the Host.
    if !header(request, "Host").is_some_and(|h| host_ok(h, &d.hosts, d.port)) {
        return false;
    }
    peer_uid(peer.port(), d.port) == Some(d.uid)
}

// ---- Paths ----

fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The path's segments after the token, or `None` for anything outside the drive: a
/// missing or wrong token, a `.`/`..` segment, or bytes that are not UTF-8.
fn segments(target: &str, token: &str) -> Option<Vec<String>> {
    let path = target.split(['?', '#']).next().unwrap_or("");
    // A Destination header carries a whole URL.
    let path = match path.split_once("://") {
        Some((_, rest)) => &rest[rest.find('/').unwrap_or(rest.len())..],
        None => path,
    };
    let mut parts = path.split('/').filter(|p| !p.is_empty());
    if parts.next()? != token {
        return None;
    }
    let mut out = Vec::new();
    for part in parts {
        let part = percent_decode(part)?;
        if part == "." || part == ".." || part.contains('/') || part.contains('\0') {
            return None;
        }
        out.push(part);
    }
    Some(out)
}

fn key_of(segs: &[String]) -> String {
    segs.join("/").to_lowercase()
}

#[derive(Clone)]
enum Dir {
    Root,
    Photos,
    Albums,
    Album { uid: String, name: String },
    Folder(Folder),
    /// `Photos/Favorites/`: the timeline's favourites.
    Favorites,
    /// `Photos/<year>/` and `Photos/<year>/<month>/`, when the timeline is split by date.
    Year(i32),
    Month(i32, u32),
    /// `Trash/`: read, copied out and restored from, never emptied from here.
    Trash,
    /// `Shared/` and the albums in it: what others shared with this account, read-only.
    Shared,
    SharedAlbum { uid: String, name: String },
}

const FAVORITES: &str = "Favorites";
const TRASH: &str = "Trash";
const SHARED: &str = "Shared";

/// The calendar year and month (1-12) of a Unix time in milliseconds, in UTC.
fn year_month(ms: i64) -> (i32, u32) {
    // Days to civil date (Howard Hinnant's algorithm), which needs no calendar crate.
    let days = ms.div_euclid(86_400_000);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = (yoe + era * 400 + i64::from(month <= 2)) as i32;
    (year, month)
}

enum Node {
    Dir(Dir),
    Photo { uid: String, name: String, size: u64, time_ms: i64 },
    Staged { path: PathBuf, name: String, size: u64, time_ms: i64 },
}

impl Node {
    fn name(&self) -> String {
        match self {
            Node::Dir(Dir::Root) => LABEL.to_string(),
            Node::Dir(Dir::Photos) => PHOTOS.to_string(),
            Node::Dir(Dir::Albums) => ALBUMS.to_string(),
            Node::Dir(Dir::Album { name, .. }) | Node::Dir(Dir::SharedAlbum { name, .. }) => name.clone(),
            Node::Dir(Dir::Folder(f)) => f.name.clone(),
            Node::Dir(Dir::Favorites) => FAVORITES.to_string(),
            Node::Dir(Dir::Year(y)) => y.to_string(),
            Node::Dir(Dir::Month(_, m)) => format!("{m:02}"),
            Node::Dir(Dir::Trash) => TRASH.to_string(),
            Node::Dir(Dir::Shared) => SHARED.to_string(),
            Node::Photo { name, .. } | Node::Staged { name, .. } => name.clone(),
        }
    }
}

fn photo_node(index: &Index, at: usize, name: &str) -> Node {
    let p = &index.photos[at];
    Node::Photo { uid: p.uid.clone(), name: name.to_string(), size: p.size, time_ms: p.time_ms }
}

fn shelf_node(p: &Photo) -> Node {
    Node::Photo { uid: p.uid.clone(), name: p.name.clone(), size: p.size, time_ms: p.time_ms }
}

/// The album a folder made, once it exists in the listing.
fn origin_album<'a>(index: &'a Index, folder: &Folder) -> Option<&'a Album> {
    if !folder.origin {
        return None;
    }
    match &*folder.target.lock().unwrap() {
        Target::New { uid: Some(uid), .. } | Target::Existing(uid) => {
            index.album_by_uid.get(uid).map(|&i| &index.albums[i])
        }
        Target::New { uid: None, .. } | Target::Timeline => None,
    }
}

/// What a DELETE means, by what it names and where.
#[derive(Debug, PartialEq)]
enum Deletion {
    /// A photo on the timeline: to Proton's trash, where it can be restored for 30 days.
    Trash(String),
    /// A photo in an album's folder: out of that album, still in the library.
    FromAlbum { album: String, photo: String },
    /// A photo in `Photos/Favorites/`: no longer a favourite, still on the timeline.
    Unfavorite(String),
    /// An album's folder: the album goes, its photos stay in the library.
    Album(String),
    /// A folder made here or a staged file: nothing in the library yet.
    Local,
    Refused,
}

/// Folders whose photos are not this account's to change: the trash (which is never
/// emptied from here) and what others shared.
fn read_only(dir: &Dir) -> bool {
    matches!(dir, Dir::Trash | Dir::Shared | Dir::SharedAlbum { .. })
}

/// Folders showing the timeline itself.
fn on_timeline(dir: &Dir) -> bool {
    matches!(dir, Dir::Photos | Dir::Year(_) | Dir::Month(..))
}

fn deletion(node: &Node, parent: &Dir) -> Deletion {
    match (node, parent) {
        // Nothing in the trash is ever deleted for good from here, and nothing shared.
        (_, dir) if read_only(dir) => Deletion::Refused,
        (Node::Photo { uid, .. }, dir) if on_timeline(dir) => Deletion::Trash(uid.clone()),
        (Node::Photo { uid, .. }, Dir::Favorites) => Deletion::Unfavorite(uid.clone()),
        (Node::Photo { uid, .. }, dir) => match album_of(dir) {
            Some(album) => Deletion::FromAlbum { album, photo: uid.clone() },
            None => Deletion::Refused,
        },
        (Node::Dir(Dir::Album { uid, .. }), _) => Deletion::Album(uid.clone()),
        (Node::Dir(Dir::Folder(_)), _) | (Node::Staged { .. }, _) => Deletion::Local,
        _ => Deletion::Refused,
    }
}

/// What a MOVE means: a rename when it stays in its folder, otherwise a change of place
/// that the library can express.
#[derive(Debug, PartialEq)]
enum Moving {
    RenamePhoto(String),
    RenameAlbum(String),
    /// A folder made here: its name is only ours until it becomes an album.
    RenameFolder,
    /// Onto an album's folder; `from` is the album it leaves, when it came out of one.
    IntoAlbum { from: Option<String> },
    /// Out of an album's folder onto the timeline: out of that album.
    OutOfAlbum(String),
    /// Out of `Trash/` onto the timeline.
    Restore(String),
    /// Into `Trash/`.
    ToTrash(String),
    Favorite(String),
    /// Out of `Photos/Favorites/` onto the timeline.
    Unfavorite(String),
    Refused,
}

fn moving(node: &Node, from: &Dir, to: &Dir, same_folder: bool) -> Moving {
    if same_folder {
        if read_only(from) {
            return Moving::Refused;
        }
        return match node {
            Node::Photo { uid, .. } => Moving::RenamePhoto(uid.clone()),
            Node::Dir(Dir::Album { uid, .. }) => Moving::RenameAlbum(uid.clone()),
            Node::Dir(Dir::Folder(_)) => Moving::RenameFolder,
            _ => Moving::Refused,
        };
    }
    let Node::Photo { uid, .. } = node else { return Moving::Refused };
    let uid = uid.clone();
    let lands_on_timeline = on_timeline(to) || matches!(to, Dir::Root | Dir::Favorites);
    match (from, to) {
        // Out of the trash onto the timeline, or into an album, which restores it first.
        (Dir::Trash, to) if lands_on_timeline || target_of(to).is_some() => return Moving::Restore(uid),
        (from, _) if read_only(from) => return Moving::Refused,
        (_, Dir::Trash) => return Moving::ToTrash(uid),
        (_, Dir::Favorites) => return Moving::Favorite(uid),
        (_, to) if read_only(to) => return Moving::Refused,
        (Dir::Favorites, to) if on_timeline(to) || matches!(to, Dir::Root) => {
            return Moving::Unfavorite(uid);
        }
        _ => {}
    }
    let source = album_of(from);
    if target_of(to).is_some() {
        // Between two folders of one album there is nothing to leave.
        let leaving = source.filter(|s| album_of(to).as_deref() != Some(s.as_str()));
        return Moving::IntoAlbum { from: leaving };
    }
    match source {
        Some(album) if on_timeline(to) || matches!(to, Dir::Root) => Moving::OutOfAlbum(album),
        _ => Moving::Refused,
    }
}

/// The album a folder's photos are in, if it stands for one that exists.
fn album_of(dir: &Dir) -> Option<String> {
    match dir {
        Dir::Album { uid, .. } => Some(uid.clone()),
        Dir::Folder(f) => match &*f.target.lock().unwrap() {
            Target::Existing(uid) | Target::New { uid: Some(uid), .. } => Some(uid.clone()),
            _ => None,
        },
        _ => None,
    }
}

fn resolve(d: &Drive, index: &Index, segs: &[String]) -> Option<Node> {
    let Some((name, parent)) = segs.split_last() else {
        return Some(Node::Dir(Dir::Root));
    };
    let Node::Dir(dir) = resolve(d, index, parent)? else { return None };
    let lower = name.to_lowercase();
    let key = key_of(segs);

    if let Some(folder) = d.folders.lock().unwrap().get(&key) {
        return Some(Node::Dir(Dir::Folder(folder.clone())));
    }
    let timeline_photo = |check: &dyn Fn(&Photo) -> bool| {
        index
            .photo_names
            .get(&lower)
            .filter(|&&i| check(&index.photos[i]))
            .map(|&i| photo_node(index, i, &index.photos[i].name))
    };
    let shelf_photo = |shelf: &Shelf| {
        shelf.get(&lower).map(|p| Node::Photo {
            uid: p.uid.clone(),
            name: p.name.clone(),
            size: p.size,
            time_ms: p.time_ms,
        })
    };
    let found = match &dir {
        Dir::Root if lower == PHOTOS.to_lowercase() => Some(Node::Dir(Dir::Photos)),
        Dir::Root if lower == ALBUMS.to_lowercase() => Some(Node::Dir(Dir::Albums)),
        Dir::Root if lower == SHARED.to_lowercase() => Some(Node::Dir(Dir::Shared)),
        Dir::Root if lower == TRASH.to_lowercase() => Some(Node::Dir(Dir::Trash)),
        Dir::Photos if lower == FAVORITES.to_lowercase() => Some(Node::Dir(Dir::Favorites)),
        Dir::Photos => match lower.parse::<i32>() {
            Ok(year) if d.by_date.load(Ordering::SeqCst) && index.has_year(year) => {
                Some(Node::Dir(Dir::Year(year)))
            }
            _ => timeline_photo(&|_| true),
        },
        Dir::Year(year) => match lower.parse::<u32>() {
            Ok(month) if lower.len() == 2 && index.has_month(*year, month) => {
                Some(Node::Dir(Dir::Month(*year, month)))
            }
            _ => None,
        },
        Dir::Month(year, month) => timeline_photo(&|p| year_month(p.time_ms) == (*year, *month)),
        Dir::Favorites => timeline_photo(&|p| index.favorites.contains(&p.uid)),
        Dir::Trash => shelf_photo(&index.trash),
        Dir::Shared => match index.shared_album_names.get(&lower) {
            Some(&a) => Some(Node::Dir(Dir::SharedAlbum {
                uid: index.shared_albums[a].uid.clone(),
                name: index.shared_albums[a].name.clone(),
            })),
            None => shelf_photo(&index.shared),
        },
        Dir::SharedAlbum { uid, .. } => index
            .shared_albums
            .iter()
            .find(|a| &a.uid == uid)
            .and_then(|a| shelf_photo(&a.shelf)),
        Dir::Albums => index.album_names.get(&lower).map(|&i| {
            let a = &index.albums[i];
            Node::Dir(Dir::Album { uid: a.uid.clone(), name: a.name.clone() })
        }),
        Dir::Album { uid, .. } => index.album_by_uid.get(uid).and_then(|&a| {
            let album = &index.albums[a];
            album.names.get(&lower).map(|&f| photo_node(index, album.files[f].1, &album.files[f].0))
        }),
        Dir::Folder(folder) => origin_album(index, folder).and_then(|album| {
            album.names.get(&lower).map(|&f| photo_node(index, album.files[f].1, &album.files[f].0))
        }),
        _ => None,
    };
    if found.is_some() {
        return found;
    }
    let parent_key = key_of(parent);
    let staged = d.staged.lock().unwrap();
    staged
        .iter()
        .find(|s| s.dir == parent_key && s.name.to_lowercase() == lower && s.path.exists())
        .map(|s| Node::Staged { path: s.path.clone(), name: s.name.clone(), size: s.size, time_ms: s.time_ms })
}

fn children(d: &Drive, index: &Index, dir: &Dir, segs: &[String]) -> Vec<Node> {
    let mut out = Vec::new();
    match dir {
        Dir::Root => {
            out.push(Node::Dir(Dir::Photos));
            out.push(Node::Dir(Dir::Albums));
            out.push(Node::Dir(Dir::Shared));
            out.push(Node::Dir(Dir::Trash));
        }
        Dir::Photos => {
            out.push(Node::Dir(Dir::Favorites));
            if d.by_date.load(Ordering::SeqCst) {
                out.extend(index.years().into_iter().map(|y| Node::Dir(Dir::Year(y))));
            } else {
                for (i, p) in index.photos.iter().enumerate().filter(|(i, _)| index.has_photo(*i)) {
                    out.push(photo_node(index, i, &p.name));
                }
            }
        }
        Dir::Year(year) => {
            out.extend(index.months(*year).into_iter().map(|m| Node::Dir(Dir::Month(*year, m))));
        }
        Dir::Month(year, month) => {
            for (i, p) in index.photos.iter().enumerate().filter(|(i, _)| index.has_photo(*i)) {
                if year_month(p.time_ms) == (*year, *month) {
                    out.push(photo_node(index, i, &p.name));
                }
            }
        }
        Dir::Favorites => {
            for (i, p) in index.photos.iter().enumerate().filter(|(i, _)| index.has_photo(*i)) {
                if index.favorites.contains(&p.uid) {
                    out.push(photo_node(index, i, &p.name));
                }
            }
        }
        Dir::Trash => out.extend(index.trash.listed().map(shelf_node)),
        Dir::Shared => {
            for a in &index.shared_albums {
                out.push(Node::Dir(Dir::SharedAlbum { uid: a.uid.clone(), name: a.name.clone() }));
            }
            out.extend(index.shared.listed().map(shelf_node));
        }
        Dir::SharedAlbum { uid, .. } => {
            if let Some(a) = index.shared_albums.iter().find(|a| &a.uid == uid) {
                out.extend(a.shelf.listed().map(shelf_node));
            }
        }
        Dir::Albums => {
            for (_, a) in index.albums.iter().enumerate().filter(|(a, _)| index.has_album(*a)) {
                out.push(Node::Dir(Dir::Album { uid: a.uid.clone(), name: a.name.clone() }));
            }
        }
        Dir::Album { uid, .. } => {
            if let Some(&a) = index.album_by_uid.get(uid) {
                for (name, at) in &index.albums[a].files {
                    out.push(photo_node(index, *at, name));
                }
            }
        }
        Dir::Folder(folder) => {
            if let Some(album) = origin_album(index, folder) {
                for (name, at) in &album.files {
                    out.push(photo_node(index, *at, name));
                }
            }
        }
    }
    let key = key_of(segs);
    let staged_dirs: Vec<String> = d
        .staged
        .lock()
        .unwrap()
        .iter()
        .filter(|s| s.path.exists())
        .map(|s| s.dir.clone())
        .collect();
    let now = now_ms();
    for (folder_key, folder) in d.folders.lock().unwrap().iter() {
        if folder.parent != key {
            continue;
        }
        // A folder dropped into Photos is only the way its photos went to the timeline:
        // once they are there it has nothing left to show, and it goes. A fresh one stays
        // a while, so a folder just made can still be named.
        if matches!(&*folder.target.lock().unwrap(), Target::Timeline) {
            let inside = format!("{folder_key}/");
            let busy = staged_dirs.iter().any(|dir| dir == folder_key || dir.starts_with(&inside));
            if !busy && now - folder.made_ms > TIMELINE_FOLDER_LINGERS_MS {
                continue;
            }
        }
        out.push(Node::Dir(Dir::Folder(folder.clone())));
    }
    let mut staged = d.staged.lock().unwrap();
    // A staged file the upload has finished with is gone from disk, and from here with it.
    staged.retain(|s| s.path.exists());
    // One name per folder. An edited photo saved back arrives under its original's name,
    // and two entries of one name would leave the file manager guessing which it is
    // opening; the photo in the library is shown until the new copy has uploaded and
    // appears under a name of its own.
    let mut names: std::collections::HashSet<String> =
        out.iter().map(|n| n.name().to_lowercase()).collect();
    for s in staged.iter().filter(|s| s.dir == key) {
        if names.insert(s.name.to_lowercase()) {
            out.push(Node::Staged { path: s.path.clone(), name: s.name.clone(), size: s.size, time_ms: s.time_ms });
        }
    }
    out
}

// ---- Answers ----

type Answer = Response<Box<dyn Read + Send>>;

fn text(code: u16, body: &str) -> Answer {
    let bytes = body.as_bytes().to_vec();
    let len = bytes.len();
    Response::new(
        StatusCode(code),
        vec![Header::from_bytes(&b"Content-Type"[..], &b"text/plain; charset=utf-8"[..]).unwrap()],
        Box::new(std::io::Cursor::new(bytes)) as Box<dyn Read + Send>,
        Some(len),
        None,
    )
}

fn with(response: Answer, name: &str, value: &str) -> Answer {
    match Header::from_bytes(name.as_bytes(), value.as_bytes()) {
        Ok(h) => response.with_header(h),
        Err(_) => response,
    }
}

fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

fn http_date(ms: i64) -> String {
    let ms = if ms > 0 { ms as u64 } else { 0 };
    httpdate::fmt_http_date(UNIX_EPOCH + Duration::from_millis(ms))
}

fn mime_of(name: &str) -> &'static str {
    crate::local_file::media_entry(&crate::local_file::extension_of(name))
        .map(|(_, mime, _)| *mime)
        .unwrap_or("application/octet-stream")
}

/// A short, stable tag for one photo's bytes; the uid itself stays out of the headers.
fn etag_of(uid: &str, size: u64) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in uid.bytes() {
        h = (h ^ b as u64).wrapping_mul(0x0100_0000_01b3);
    }
    format!("\"{h:016x}-{size:x}\"")
}

fn href(token: &str, segs: &[String], dir: bool) -> String {
    let mut out = format!("/{token}/");
    for (i, s) in segs.iter().enumerate() {
        if i > 0 {
            out.push('/');
        }
        out.push_str(&percent_encode(s));
    }
    if dir && !segs.is_empty() {
        out.push('/');
    }
    out
}

fn prop_entry(xml: &mut String, token: &str, segs: &[String], node: &Node, fallback_ms: i64) {
    let (dir, size, time_ms, etag) = match node {
        Node::Dir(Dir::Folder(f)) => (true, 0, f.made_ms, None),
        Node::Dir(_) => (true, 0, fallback_ms, None),
        Node::Photo { uid, size, time_ms, .. } => (false, *size, *time_ms, Some(etag_of(uid, *size))),
        Node::Staged { size, time_ms, path, .. } => {
            (false, *size, *time_ms, Some(etag_of(&path.to_string_lossy(), *size)))
        }
    };
    xml.push_str("<D:response><D:href>");
    xml.push_str(&xml_escape(&href(token, segs, dir)));
    xml.push_str("</D:href><D:propstat><D:prop><D:displayname>");
    xml.push_str(&xml_escape(&node.name()));
    xml.push_str("</D:displayname><D:getlastmodified>");
    xml.push_str(&http_date(time_ms));
    xml.push_str("</D:getlastmodified>");
    if dir {
        xml.push_str("<D:resourcetype><D:collection/></D:resourcetype>");
    } else {
        xml.push_str("<D:resourcetype/><D:getcontentlength>");
        xml.push_str(&size.to_string());
        xml.push_str("</D:getcontentlength><D:getcontenttype>");
        xml.push_str(mime_of(&node.name()));
        xml.push_str("</D:getcontenttype>");
        if let Some(tag) = etag {
            xml.push_str("<D:getetag>");
            xml.push_str(&xml_escape(&tag));
            xml.push_str("</D:getetag>");
        }
    }
    xml.push_str("</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>");
}

fn propfind(d: &Arc<Drive>, request: &mut Request, segs: &[String]) -> Answer {
    // The client may say which properties it wants; every one it can use is always sent.
    let _ = std::io::copy(&mut request.as_reader().take(64 * 1024), &mut std::io::sink());
    let depth0 = header(request, "Depth") == Some("0");
    let index = d.index.read().unwrap();
    if index.built.is_some_and(|b| b.elapsed() > STALE_AFTER) {
        refresh(d);
    }
    let Some(node) = resolve(d, &index, segs) else { return text(404, "Not found") };

    let started = now_ms();
    let mut xml = String::from("<?xml version=\"1.0\" encoding=\"utf-8\"?><D:multistatus xmlns:D=\"DAV:\">");
    prop_entry(&mut xml, &d.token, segs, &node, started);
    if let (false, Node::Dir(dir)) = (depth0, &node) {
        let mut path = segs.to_vec();
        for child in children(d, &index, dir, segs) {
            path.push(child.name());
            prop_entry(&mut xml, &d.token, &path, &child, started);
            path.pop();
        }
    }
    xml.push_str("</D:multistatus>");
    let len = xml.len();
    Response::new(
        StatusCode(207),
        vec![Header::from_bytes(&b"Content-Type"[..], &b"application/xml; charset=utf-8"[..]).unwrap()],
        Box::new(std::io::Cursor::new(xml.into_bytes())) as Box<dyn Read + Send>,
        Some(len),
        None,
    )
}

/// `Range: bytes=a-b` against a file of `size` bytes: `None` to send it all, `Some(Err)`
/// for a range that lies outside it. Only a single range is honoured; a list of them is
/// answered with the whole file, which every client accepts.
fn parse_range(value: &str, size: u64) -> Option<Result<(u64, u64), ()>> {
    let spec = value.trim().strip_prefix("bytes=")?;
    if spec.contains(',') {
        return None;
    }
    let (a, b) = spec.split_once('-')?;
    let (a, b) = (a.trim(), b.trim());
    if size == 0 {
        return Some(Err(()));
    }
    let range = if a.is_empty() {
        let n: u64 = b.parse().ok()?;
        if n == 0 {
            return Some(Err(()));
        }
        (size.saturating_sub(n), size - 1)
    } else {
        let start: u64 = a.parse().ok()?;
        let end = if b.is_empty() { size - 1 } else { b.parse::<u64>().ok()?.min(size - 1) };
        if start > end || start >= size {
            return Some(Err(()));
        }
        (start, end)
    };
    Some(Ok(range))
}

/// `size` is the file's whole size as listed: a download still arriving is served by
/// it, its reads waiting for the bytes (see `Growing`).
fn send_file(request: &Request, mut file: Growing, size: u64, name: &str, time_ms: i64, etag: String) -> Answer {
    let base = |code: u16, reader: Box<dyn Read + Send>, len: u64| {
        let r = Response::new(StatusCode(code), Vec::new(), reader, Some(len as usize), None)
            // Always a Content-Length, never chunked: players seek by it.
            .with_chunked_threshold(usize::MAX);
        let r = with(r, "Content-Type", mime_of(name));
        let r = with(r, "Accept-Ranges", "bytes");
        let r = with(r, "Last-Modified", &http_date(time_ms));
        with(r, "ETag", &etag)
    };
    match header(request, "Range").and_then(|v| parse_range(v, size)) {
        Some(Ok((start, end))) => {
            if file.seek(SeekFrom::Start(start)).is_err() {
                return text(500, "Read failed");
            }
            let len = end - start + 1;
            let r = base(206, Box::new(file.take(len)), len);
            with(r, "Content-Range", &format!("bytes {start}-{end}/{size}"))
        }
        Some(Err(())) => with(text(416, "Range not satisfiable"), "Content-Range", &format!("bytes */{size}")),
        None => base(200, Box::new(file), size),
    }
}

fn get(d: &Drive, request: &Request, segs: &[String], head: bool) -> Answer {
    let node = {
        let index = d.index.read().unwrap();
        resolve(d, &index, segs)
    };
    match node {
        None => text(404, "Not found"),
        Some(Node::Dir(_)) => text(405, "A folder"),
        Some(Node::Photo { uid, name, size, time_ms }) => {
            if head {
                // The listing already knows the size: a HEAD downloads nothing.
                let r = Response::new(StatusCode(200), Vec::new(), Box::new(std::io::empty()) as Box<dyn Read + Send>, Some(size as usize), None)
                    .with_chunked_threshold(usize::MAX);
                let r = with(r, "Content-Type", mime_of(&name));
                let r = with(r, "Accept-Ranges", "bytes");
                return with(r, "ETag", &etag_of(&uid, size));
            }
            match hydrated_file(d, &uid, size) {
                Ok(file) => send_file(request, file, size, &name, time_ms, etag_of(&uid, size)),
                Err(_) => text(503, "Photos for Proton could not download this photo"),
            }
        }
        Some(Node::Staged { path, name, time_ms, .. }) => match File::open(&path) {
            Ok(file) => {
                let size = file.metadata().map(|m| m.len()).unwrap_or(0);
                let tag = etag_of(&path.to_string_lossy(), size);
                let whole = Growing::new(file, Progress::finished(), Arc::default());
                send_file(request, whole, size, &name, time_ms, tag)
            }
            Err(_) => text(404, "Not found"),
        },
    }
}

/// A new folder or file name from the client: one path segment it could have listed.
fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 240 && sanitize_name(name) == name
}

/// Where photos dropped into this folder go: `None` is the timeline.
fn target_of(dir: &Dir) -> Option<Arc<Mutex<Target>>> {
    match dir {
        Dir::Album { uid, .. } => Some(Arc::new(Mutex::new(Target::Existing(uid.clone())))),
        Dir::Folder(f) if matches!(&*f.target.lock().unwrap(), Target::Timeline) => None,
        Dir::Folder(f) => Some(f.target.clone()),
        _ => None,
    }
}

fn mkcol(d: &Drive, segs: &[String]) -> Answer {
    let Some((name, parent)) = segs.split_last() else { return text(405, "Exists") };
    if !valid_name(name) {
        return text(403, "Not a name this folder can take");
    }
    let (dir, exists) = {
        let index = d.index.read().unwrap();
        (resolve(d, &index, parent), resolve(d, &index, segs).is_some())
    };
    let Some(Node::Dir(dir)) = dir else { return text(409, "No such folder") };
    if exists {
        return text(405, "Exists");
    }
    let (target, origin) = match (new_folder_kind(&dir), &dir) {
        (NewFolder::Refused, _) => return text(403, "No folder can be made here"),
        (NewFolder::Album, _) => {
            (Arc::new(Mutex::new(Target::New { name: name.clone(), uid: None })), true)
        }
        (NewFolder::Timeline, _) => (Arc::new(Mutex::new(Target::Timeline)), true),
        // A folder made here passes on its own target, a timeline one included.
        (NewFolder::Inherit, Dir::Folder(f)) => (f.target.clone(), false),
        (NewFolder::Inherit, _) => (target_of(&dir).expect("an album's folder has a target"), false),
    };
    d.folders.lock().unwrap().insert(
        key_of(segs),
        Folder { name: name.clone(), parent: key_of(parent), target, origin, made_ms: now_ms() },
    );
    text(201, "Created")
}

/// The album uid a target stands for, making the album first when it is a new one.
///
/// Never holds a target while it takes the listing's lock: `origin_album` takes the two
/// the other way round, under a listing lock a waiting rebuild would stop being shared.
fn album_uid(d: &Drive, target: &Mutex<Target>) -> Result<(String, String), String> {
    let existing = match &*target.lock().unwrap() {
        Target::Existing(uid) => Some(uid.clone()),
        Target::Timeline => return Err("the timeline is not an album".into()),
        Target::New { .. } => None,
    };
    if let Some(uid) = existing {
        let index = d.index.read().unwrap();
        let name = index
            .album_by_uid
            .get(uid.as_str())
            .map(|&i| index.albums[i].name.clone())
            .unwrap_or_else(|| "Album".to_string());
        return Ok((uid, name));
    }
    // Held across the creation, so the photos of one folder, arriving one after another,
    // make one album between them.
    let mut target = target.lock().unwrap();
    match &mut *target {
        Target::Existing(uid) => Ok((uid.clone(), "Album".to_string())),
        Target::Timeline => Err("the timeline is not an album".into()),
        Target::New { name, uid } => {
            if let Some(uid) = uid {
                return Ok((uid.clone(), name.clone()));
            }
            let made = crate::sidecar_rpc(&d.app, "createAlbum", serde_json::json!({ "name": name }))?;
            let made = made.get("uid").and_then(|v| v.as_str()).ok_or("no album")?.to_string();
            *uid = Some(made.clone());
            library_changed();
            Ok((made, name.clone()))
        }
    }
}

fn put(d: &Arc<Drive>, request: &mut Request, segs: &[String]) -> Answer {
    let Some((name, parent)) = segs.split_last() else { return text(405, "A folder") };
    let dir = {
        let index = d.index.read().unwrap();
        match resolve(d, &index, parent) {
            Some(Node::Dir(dir)) => dir,
            _ => return text(409, "No such folder"),
        }
    };
    if read_only(&dir) {
        tell(d, Notice::ReadOnly);
        return text(403, "Nothing can be added here");
    }
    // A 2xx here is a promise: when the file manager MOVES a file in, GVfs deletes the
    // original the moment it sees one (`push_finished`). So a file is taken only when it
    // will be kept until it is in the library, and everything else is refused, which
    // leaves the original where it was. That includes a file manager's hidden
    // bookkeeping (`.directory`, `.picasa.ini`) and an empty file, neither of which is
    // a photo, and both of which a move would otherwise have deleted for nothing.
    if name.starts_with('.') || !valid_name(name) {
        return text(403, "Not a photo or a video");
    }
    if !UPLOADABLE.contains(&crate::local_file::extension_of(name).as_str()) {
        return text(415, "Only photos and videos can be uploaded to Proton Photos");
    }

    let folder = d.drop_root.join(random_hex(8));
    if std::fs::create_dir_all(&folder).is_err() {
        return text(507, "No room to take this file");
    }
    let path = folder.join(name);
    // The original's modification time, which GVfs sends along: the upload falls back on
    // it for a file with no date of its own, as it does for a file dropped on the window.
    let modified = header(request, "X-OC-Mtime")
        .and_then(|v| v.trim().parse::<u64>().ok())
        .map(|secs| UNIX_EPOCH + Duration::from_secs(secs));
    let written = File::create(&path).and_then(|mut f| {
        let n = std::io::copy(request.as_reader(), &mut f)?;
        f.sync_all()?;
        if let Some(time) = modified {
            let _ = f.set_modified(time);
        }
        Ok(n)
    });
    let size = match written {
        Ok(n) if n > 0 => n,
        Ok(_) => {
            let _ = std::fs::remove_dir_all(&folder);
            return text(403, "An empty file is not a photo or a video");
        }
        Err(_) => {
            let _ = std::fs::remove_dir_all(&folder);
            return text(500, "The file did not arrive whole");
        }
    };
    d.staged.lock().unwrap().push(Staged {
        dir: key_of(parent),
        name: name.clone(),
        path: path.clone(),
        size,
        time_ms: modified
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|t| t.as_millis() as i64)
            .unwrap_or_else(now_ms),
    });

    let target = target_of(&dir);
    let favorite = matches!(dir, Dir::Favorites);
    let d = d.clone();
    std::thread::spawn(move || upload_staged(&d, path, target, favorite));
    text(201, "Created")
}

/// The file next to a staged copy that names the album it goes into, so a copy whose
/// upload did not finish goes back into the same album when it is retried.
const ALBUM_NOTE: &str = ".album";
/// Beside a staged copy dropped into Favorites, so a retried upload is a favourite too.
const FAVORITE_NOTE: &str = ".favorite";

/// Upload one staged copy through the sidecar's queue. The sidecar deletes the copy once
/// it is in the library (or already was); a copy whose upload fails stays staged, since
/// the original may be gone, and is retried at the next unlock (`retry_staged`).
fn upload_staged(d: &Arc<Drive>, path: PathBuf, target: Option<Arc<Mutex<Target>>>, favorite: bool) {
    let (album, album_name) = match target.map(|t| album_uid(d, &t)) {
        None => (None, None),
        Some(Ok((uid, name))) => (Some(uid), Some(name)),
        Some(Err(e)) => {
            crate::note(&d.app, &format!("[drive] could not make the album: {e}"));
            return;
        }
    };
    if let (Some(uid), Some(folder)) = (&album, path.parent()) {
        let _ = std::fs::write(folder.join(ALBUM_NOTE), uid);
    }
    if let (true, Some(folder)) = (favorite, path.parent()) {
        let _ = std::fs::write(folder.join(FAVORITE_NOTE), "1");
    }
    let paths = vec![path.to_string_lossy().into_owned()];
    let prep = crate::upload_frame::prepare(&d.app, &paths);
    let mut params = serde_json::to_value(&prep).unwrap_or_else(|_| serde_json::json!({}));
    params["paths"] = serde_json::json!(paths);
    params["albumUid"] = serde_json::json!(album);
    params["albumName"] = serde_json::json!(album_name);
    params["favorite"] = serde_json::json!(favorite);
    match crate::sidecar_rpc(&d.app, "startDropUpload", params) {
        Ok(_) => {
            // The window's upload panel shows the drive's uploads with its own.
            let _ = d.app.emit("drive-upload", ());
            watch_uploads(d);
        }
        Err(e) => crate::note(&d.app, &format!("[drive] upload not started: {e}")),
    }
}

/// Staged copies an earlier session did not get into the library, uploaded again. Each
/// sits in its own folder under `pfp-drop/`, with the album it was meant for beside it.
/// A copy that is already in the library comes back as a duplicate and is only deleted.
fn retry_staged(d: &Arc<Drive>) {
    let Ok(folders) = std::fs::read_dir(&d.drop_root) else { return };
    let mut retried = 0usize;
    for folder in folders.flatten().map(|e| e.path()).filter(|p| p.is_dir()) {
        let files: Vec<PathBuf> = std::fs::read_dir(&folder)
            .map(|r| r.flatten().map(|e| e.path()).collect())
            .unwrap_or_default();
        let staged = files.iter().find(|p| {
            let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            !name.starts_with('.')
                && p.is_file()
                && UPLOADABLE.contains(&crate::local_file::extension_of(&name).as_str())
        });
        let Some(path) = staged.cloned() else {
            // A write cut short before it was answered: nothing was promised for it.
            let _ = std::fs::remove_dir_all(&folder);
            continue;
        };
        let target = std::fs::read_to_string(folder.join(ALBUM_NOTE))
            .ok()
            .map(|uid| uid.trim().to_string())
            .filter(|uid| !uid.is_empty())
            .map(|uid| Arc::new(Mutex::new(Target::Existing(uid))));
        let size = path.metadata().map(|m| m.len()).unwrap_or(0);
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        d.staged.lock().unwrap().push(Staged {
            dir: PHOTOS.to_lowercase(),
            name,
            path: path.clone(),
            size,
            time_ms: now_ms(),
        });
        let favorite = folder.join(FAVORITE_NOTE).exists();
        upload_staged(d, path, target, favorite);
        retried += 1;
    }
    if retried > 0 {
        crate::note(&d.app, &format!("[drive] retrying {retried} staged upload(s)"));
    }
}

/// A photo copied or dragged onto an album's folder inside the drive is added to that
/// album: `None` when the request is not that. A drag within one mount arrives as MOVE
/// (Nautilus moves within a filesystem); `move_` then takes it out of the album it came
/// from, if any.
fn add_to_album(d: &Drive, request: &Request, segs: &[String]) -> Option<Answer> {
    let dest = header(request, "Destination").and_then(|v| segments(v, &d.token))?;
    let (_, dest_parent) = dest.split_last()?;
    let (source, dir) = {
        let index = d.index.read().unwrap();
        (resolve(d, &index, segs), resolve(d, &index, dest_parent))
    };
    let (Some(Node::Photo { uid, .. }), Some(Node::Dir(dir))) = (source, dir) else { return None };
    let target = target_of(&dir)?;
    let album = match album_uid(d, &target) {
        Ok((album, _)) => album,
        Err(_) => return Some(text(502, "The album could not be made")),
    };
    Some(
        match crate::sidecar_rpc(
            &d.app,
            "addPhotosToAlbum",
            serde_json::json!({ "albumUid": album, "uids": [uid] }),
        ) {
            Ok(_) => {
                library_changed();
                text(201, "Added to the album")
            }
            Err(_) => text(502, "The photo could not be added"),
        },
    )
}

/// COPY within the drive: what a MOVE there would do, where it only adds: a photo into
/// an album or Favorites, or out of the trash. Nothing is ever taken from anywhere by a
/// copy.
fn copy(d: &Drive, request: &Request, segs: &[String]) -> Answer {
    relocate(d, request, segs, true)
}

const EDITS_OFF: &str = "Deleting and renaming in Files is turned off in Photos for Proton";

/// A sidecar call that changes the library, true when it reports success: a call that
/// answers per photo (trash, album removal) succeeds only when its one photo did.
fn changed(d: &Drive, method: &str, params: serde_json::Value) -> bool {
    match crate::sidecar_rpc(&d.app, method, params) {
        Ok(serde_json::Value::Array(results)) => {
            results.iter().all(|r| r.get("ok").and_then(|v| v.as_bool()) == Some(true))
        }
        Ok(serde_json::Value::Object(o)) => {
            o.get("status").and_then(|v| v.as_str()).is_none_or(|s| s == "deleted")
        }
        Ok(_) => true,
        Err(e) => {
            crate::note(&d.app, &format!("[drive] {method} failed: {e}"));
            false
        }
    }
}

/// DELETE. What it does depends on where (see `Deletion`); nothing is ever deleted for
/// good from here, and with the option off only what is not in the library yet goes.
fn delete(d: &Drive, segs: &[String]) -> Answer {
    let Some((_, parent)) = segs.split_last() else { return text(403, "Not this folder") };
    let (node, dir) = {
        let index = d.index.read().unwrap();
        (resolve(d, &index, segs), resolve(d, &index, parent))
    };
    let (Some(node), Some(Node::Dir(dir))) = (node, dir) else { return text(404, "Not found") };
    let action = deletion(&node, &dir);
    if !matches!(action, Deletion::Local | Deletion::Refused) && !d.edits.load(Ordering::SeqCst) {
        return text(403, EDITS_OFF);
    }
    let done = match action {
        Deletion::Local => {
            forget_local(d, segs, &node);
            true
        }
        Deletion::Trash(uid) => {
            let ok = changed(d, "trashPhotos", serde_json::json!({ "uids": [uid] }));
            if ok {
                d.index.write().unwrap().trash_photo(&uid);
                tell(d, Notice::Trashed);
            }
            ok
        }
        Deletion::Unfavorite(uid) => {
            let ok = changed(d, "setFavorite", serde_json::json!({ "uids": [uid], "favorite": false }));
            if ok {
                d.index.write().unwrap().favorites.remove(&uid);
                tell(d, Notice::Unfavorited);
            }
            ok
        }
        Deletion::FromAlbum { album, photo } => {
            let ok = changed(
                d,
                "removePhotosFromAlbum",
                serde_json::json!({ "albumUid": album, "uids": [photo] }),
            );
            if ok {
                let name = album_name(d, &album);
                d.index.write().unwrap().remove_from_album(&album, &photo);
                tell(d, Notice::LeftAlbum(name));
            }
            ok
        }
        Deletion::Album(uid) => {
            // Photos that are in no timeline go to it rather than with the album.
            let ok = changed(d, "deleteAlbum", serde_json::json!({ "uid": uid, "saveToTimeline": true }));
            if ok {
                let name = album_name(d, &uid);
                d.index.write().unwrap().forget_album(&uid);
                tell(d, Notice::AlbumDeleted(name));
            }
            ok
        }
        Deletion::Refused => {
            // Nothing leaves the trash from here; say so, since the file manager only
            // shows a bare refusal (and a move out of the drive ends in one).
            if matches!((&node, &dir), (Node::Photo { .. }, Dir::Trash)) {
                tell(d, Notice::TrashKept);
            }
            return text(403, "This cannot be deleted here");
        }
    };
    if !done {
        return text(502, "Proton did not accept the change");
    }
    library_changed();
    text(204, "")
}

/// Drop a folder made here (and everything made inside it), or a staged file whose
/// upload has not started, which is what deleting either means.
fn forget_local(d: &Drive, segs: &[String], node: &Node) {
    match node {
        Node::Staged { path, .. } => {
            let _ = std::fs::remove_dir_all(path.parent().unwrap_or(path));
            d.staged.lock().unwrap().retain(|s| &s.path != path);
        }
        Node::Dir(Dir::Folder(_)) => {
            let key = key_of(segs);
            let inside = format!("{key}/");
            d.folders.lock().unwrap().retain(|k, _| k != &key && !k.starts_with(&inside));
        }
        _ => {}
    }
}

/// MOVE: a rename in place, or a photo changing place (see `Moving`).
fn move_(d: &Drive, request: &Request, segs: &[String]) -> Answer {
    relocate(d, request, segs, false)
}

/// MOVE and COPY within the drive. A copy does only what adds: a photo into an album or
/// Favorites, or out of the trash; it takes nothing out of anywhere.
fn relocate(d: &Drive, request: &Request, segs: &[String], copy: bool) -> Answer {
    let refused = || text(403, "That cannot be moved there");
    let Some(dest) = header(request, "Destination").and_then(|v| segments(v, &d.token)) else {
        return refused();
    };
    let (Some((new_name, dest_parent)), Some((_, parent))) = (dest.split_last(), segs.split_last()) else {
        return refused();
    };
    let (node, from, to, taken) = {
        let index = d.index.read().unwrap();
        (
            resolve(d, &index, segs),
            resolve(d, &index, parent),
            resolve(d, &index, dest_parent),
            resolve(d, &index, &dest).is_some(),
        )
    };
    let (Some(node), Some(Node::Dir(from)), Some(Node::Dir(to))) = (node, from, to) else {
        return text(409, "No such folder");
    };
    let edits = d.edits.load(Ordering::SeqCst);
    let action = match moving(&node, &from, &to, key_of(parent) == key_of(dest_parent)) {
        Moving::IntoAlbum { .. } if copy => Moving::IntoAlbum { from: None },
        action @ (Moving::IntoAlbum { .. } | Moving::Favorite(_) | Moving::Restore(_)) => action,
        _ if copy => Moving::Refused,
        action => action,
    };
    let rename = |method: &str, params: serde_json::Value| -> Option<Answer> {
        if !edits {
            return Some(text(403, EDITS_OFF));
        }
        if taken {
            return Some(text(412, "That name is taken"));
        }
        if !valid_name(new_name) {
            return Some(text(403, "Not a name this folder can take"));
        }
        (!changed(d, method, params)).then(|| text(502, "Proton did not accept the change"))
    };
    let rejected = || text(502, "Proton did not accept the change");
    match action {
        Moving::RenamePhoto(uid) => {
            if let Some(refusal) = rename("renamePhoto", serde_json::json!({ "uid": uid, "name": new_name })) {
                return refusal;
            }
            d.index.write().unwrap().rename_photo(&uid, new_name);
        }
        Moving::RenameAlbum(uid) => {
            if let Some(refusal) = rename("renameAlbum", serde_json::json!({ "uid": uid, "name": new_name })) {
                return refusal;
            }
            d.index.write().unwrap().rename_album(&uid, new_name);
        }
        Moving::RenameFolder => return rename_new_folder(d, &dest, segs),
        Moving::IntoAlbum { from: leaving } => {
            let Some(answer) = add_to_album(d, request, segs) else { return refused() };
            if answer.status_code().0 != 201 {
                return answer;
            }
            // A move between two albums leaves the first one; with the option off it is
            // only a copy, which takes nothing from anywhere.
            if let (Some(album), true, Node::Photo { uid, .. }) = (leaving, edits, &node) {
                if changed(d, "removePhotosFromAlbum", serde_json::json!({ "albumUid": album, "uids": [uid] })) {
                    d.index.write().unwrap().remove_from_album(&album, uid);
                }
            }
        }
        Moving::OutOfAlbum(album) => {
            if !edits {
                return text(403, EDITS_OFF);
            }
            let Node::Photo { uid, .. } = &node else { return refused() };
            if !changed(d, "removePhotosFromAlbum", serde_json::json!({ "albumUid": album, "uids": [uid] })) {
                return rejected();
            }
            d.index.write().unwrap().remove_from_album(&album, uid);
        }
        // Out of the trash is always allowed: it undoes a delete, and takes nothing.
        Moving::Restore(uid) => {
            if !changed(d, "restorePhotos", serde_json::json!({ "uids": [uid] })) {
                return rejected();
            }
            d.index.write().unwrap().restore_photo(&uid);
            tell(d, Notice::Restored);
            if matches!(to, Dir::Favorites)
                && changed(d, "setFavorite", serde_json::json!({ "uids": [uid], "favorite": true }))
            {
                d.index.write().unwrap().favorites.insert(uid.clone());
            }
            // Dropped onto an album's folder: into that album as well.
            if let Some(target) = target_of(&to) {
                if let Ok((album, _)) = album_uid(d, &target) {
                    if changed(d, "addPhotosToAlbum", serde_json::json!({ "albumUid": album, "uids": [uid] })) {
                        d.index.write().unwrap().add_to_album(&album, &uid);
                    }
                }
            }
        }
        Moving::ToTrash(uid) => {
            if !edits {
                return text(403, EDITS_OFF);
            }
            if !changed(d, "trashPhotos", serde_json::json!({ "uids": [uid] })) {
                return rejected();
            }
            d.index.write().unwrap().trash_photo(&uid);
        }
        Moving::Favorite(uid) => {
            if !changed(d, "setFavorite", serde_json::json!({ "uids": [uid], "favorite": true })) {
                return rejected();
            }
            d.index.write().unwrap().favorites.insert(uid);
        }
        Moving::Unfavorite(uid) => {
            if !edits {
                return text(403, EDITS_OFF);
            }
            if !changed(d, "setFavorite", serde_json::json!({ "uids": [uid], "favorite": false })) {
                return rejected();
            }
            d.index.write().unwrap().favorites.remove(&uid);
        }
        Moving::Refused => return refused(),
    }
    library_changed();
    text(201, "Moved")
}

/// Rename a folder made here that is still empty and not yet an album, which touches
/// nothing in the library. A file manager's "New folder" makes one named "Untitled
/// Folder" and renames it straight away; an album-to-be takes the new name with it.
fn rename_new_folder(d: &Drive, dest: &[String], segs: &[String]) -> Answer {
    let refused = || text(403, "Only a new, empty folder can be renamed here");
    let Some((new_name, _)) = dest.split_last() else { return refused() };
    if !valid_name(new_name) {
        return refused();
    }
    // The listing's lock is let go before the folders' is taken: `album_uid` takes them
    // the other way round, and a waiting rebuild would otherwise deadlock the two.
    let taken = {
        let index = d.index.read().unwrap();
        resolve(d, &index, dest).is_some()
    };
    if taken {
        return text(412, "That name is taken");
    }
    let key = key_of(segs);
    let mut folders = d.folders.lock().unwrap();
    let Some(folder) = folders.get(&key) else { return refused() };
    let untouched = matches!(
        &*folder.target.lock().unwrap(),
        Target::New { uid: None, .. } | Target::Timeline
    ) && !folders.values().any(|f| f.parent == key)
        && !d.staged.lock().unwrap().iter().any(|s| s.dir == key);
    if !untouched {
        return refused();
    }
    let mut renamed = folders.remove(&key).expect("looked up above");
    renamed.name = new_name.clone();
    if let Target::New { name, .. } = &mut *renamed.target.lock().unwrap() {
        *name = new_name.clone();
    }
    folders.insert(key_of(dest), renamed);
    text(201, "Renamed")
}

fn handle(d: &Arc<Drive>, mut request: Request) {
    d.last_request.store(now_ms(), Ordering::SeqCst);
    let answer = answer(d, &mut request);
    // Whatever body a refused request carried is read off here, a piece at a time.
    // Left to tiny_http, it drains the rest in one buffer the size of what is left, and
    // GVfs never waits for a 100-continue, so a refused video would arrive whole.
    let _ = std::io::copy(&mut request.as_reader(), &mut std::io::sink());
    let _ = request.respond(answer);
}

fn answer(d: &Arc<Drive>, request: &mut Request) -> Answer {
    if !authorised(d, request) {
        return text(403, "Forbidden");
    }
    let Some(segs) = segments(request.url(), &d.token) else { return text(404, "Not found") };
    let method = request.method().clone();
    if method == Method::Options {
        let r = text(200, "");
        let r = with(r, "DAV", "1");
        return with(r, "Allow", "OPTIONS, GET, HEAD, PROPFIND, PUT, MKCOL, COPY, MOVE, DELETE");
    }
    if !d.live.load(Ordering::SeqCst) {
        return text(503, "Open and unlock Photos for Proton to reach your photos");
    }
    match method.as_str() {
        "PROPFIND" => propfind(d, request, &segs),
        "GET" => get(d, request, &segs, false),
        "HEAD" => get(d, request, &segs, true),
        "PUT" => put(d, request, &segs),
        "MKCOL" => mkcol(d, &segs),
        "COPY" => copy(d, request, &segs),
        "MOVE" => move_(d, request, &segs),
        "DELETE" => delete(d, &segs),
        "PROPPATCH" => text(403, "Properties cannot be changed here"),
        _ => text(405, "Not supported"),
    }
}

// ---- Saying what a delete did ----

/// The app's language: the one chosen in its settings, else the system's, else English.
pub(crate) fn app_language(app: &AppHandle) -> String {
    crate::page_setting(app, "lang")
        .and_then(|v| v.as_str().map(str::to_string))
        .or_else(|| std::env::var("LANG").ok())
        .map(|l| l.chars().take(2).collect::<String>().to_lowercase())
        .unwrap_or_else(|| "en".into())
}

/// Count one photo into a notice, shown a moment later together with every other one the
/// same action touched, so deleting fifty is one notice rather than fifty.
fn tell(d: &Drive, notice: Notice) {
    let first = {
        let mut pending = d.notices.lock().unwrap();
        let count = pending.entry(notice.clone()).or_insert(0);
        *count += 1;
        *count == 1
    };
    if !first {
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(2));
        let Some(d) = drive() else { return };
        let count = d.notices.lock().unwrap().remove(&notice).unwrap_or(1);
        let (title, body) = notice_text(&app_language(&d.app), &notice);
        let album = match &notice {
            Notice::LeftAlbum(a) | Notice::AlbumDeleted(a) => a.as_str(),
            _ => "",
        };
        let fill = |s: &str| s.replace("{n}", &count.to_string()).replace("{album}", album);
        send_notification(&fill(title), &fill(body));
    });
}

/// An album's name as the drive lists it.
fn album_name(d: &Drive, uid: &str) -> String {
    let index = d.index.read().unwrap();
    index.album_by_uid.get(uid).map(|&a| index.albums[a].name.clone()).unwrap_or_default()
}

/// A desktop notification, through the notification service the manifest may talk to.
pub(crate) fn send_notification(title: &str, body: &str) {
    let Ok(conn) = dbus::blocking::Connection::new_session() else { return };
    let proxy = conn.with_proxy(
        "org.freedesktop.Notifications",
        "/org/freedesktop/Notifications",
        Duration::from_secs(5),
    );
    let hints: dbus::arg::PropMap = HashMap::new();
    let _: Result<(u32,), _> = proxy.method_call(
        "org.freedesktop.Notifications",
        "Notify",
        ("Photos for Proton", 0u32, "eu.akoos.photos", title, body, Vec::<String>::new(), hints, -1i32),
    );
}

// ---- The sidebar bookmark ----

/// The GTK bookmarks file, which Files, Nemo, Thunar, Caja and every GTK file chooser read.
/// Inside the sandbox the app's own config directory stands in for the user's, so the
/// real one is found the way Flatpak exposes it.
fn bookmarks_path() -> Option<PathBuf> {
    let in_flatpak = Path::new("/.flatpak-info").exists();
    let base = std::env::var_os("HOST_XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            if in_flatpak {
                None
            } else {
                std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from)
            }
        })
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))?;
    Some(base.join("gtk-3.0").join("bookmarks"))
}

/// Ours whatever address it was written with: our name on a dav address on this machine.
fn is_our_bookmark(line: &str) -> bool {
    let (uri, label) = line.split_once(' ').unwrap_or((line, ""));
    let host = uri.strip_prefix("dav://").and_then(|rest| rest.split(':').next()).unwrap_or("");
    (host == "localhost" || host.starts_with("127.")) && label.trim() == LABEL
}

/// The bookmarks with ours replaced by `uri`, or removed when there is none. Every other
/// line, the user's own, stays exactly as it was and where it was.
fn with_bookmark(text: &str, uri: Option<&str>) -> String {
    let mut lines: Vec<String> = text.lines().filter(|l| !is_our_bookmark(l)).map(str::to_string).collect();
    if let Some(uri) = uri {
        lines.push(format!("{uri} {LABEL}"));
    }
    if lines.is_empty() {
        String::new()
    } else {
        lines.join("\n") + "\n"
    }
}

fn write_bookmark(uri: Option<&str>) {
    let Some(path) = bookmarks_path() else { return };
    let current = std::fs::read_to_string(&path).unwrap_or_default();
    let next = with_bookmark(&current, uri);
    if next == current {
        return;
    }
    let Some(dir) = path.parent() else { return };
    let _ = std::fs::create_dir_all(dir);
    // Written beside it and renamed over it, as GTK itself does, so a reader never sees
    // half a file.
    let temp = dir.join(format!(".bookmarks.pfp-{}", random_hex(4)));
    if std::fs::write(&temp, next).is_ok() && std::fs::rename(&temp, &path).is_err() {
        let _ = std::fs::remove_file(&temp);
    }
}

/// KDE's places, which Dolphin's sidebar and every KDE file dialog read.
fn kde_places_path() -> Option<PathBuf> {
    let in_flatpak = Path::new("/.flatpak-info").exists();
    let base = std::env::var_os("HOST_XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| if in_flatpak { None } else { std::env::var_os("XDG_DATA_HOME").map(PathBuf::from) })
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))?;
    Some(base.join("user-places.xbel"))
}

/// Marks our entry among KDE's places, so it is the only one ever touched.
const KDE_ID: &str = "photosforproton-drive";

/// The places with ours replaced by `uri`, or removed when there is none; `None` when the
/// file is not a shape this can safely edit. Every other entry is left byte for byte.
fn with_kde_place(xml: &str, uri: Option<&str>) -> Option<String> {
    let mut text = xml.to_string();
    let marker = format!("<ID>{KDE_ID}</ID>");
    while let Some(at) = text.find(&marker) {
        let start = text[..at].rfind("<bookmark ")?;
        let mut end = at + text[at..].find("</bookmark>")? + "</bookmark>".len();
        if text[end..].starts_with('\n') {
            end += 1;
        }
        // Back to the start of the line, taking the indentation with the entry.
        let start = text[..start].rfind('\n').map_or(start, |nl| nl + 1);
        text.replace_range(start..end, "");
    }
    if let Some(uri) = uri {
        let close = text.rfind("</xbel>")?;
        let entry = format!(
            " <bookmark href=\"{}\">\n  <title>{LABEL}</title>\n  <info>\n   <metadata owner=\"http://www.kde.org\">\n    <ID>{KDE_ID}</ID>\n   </metadata>\n  </info>\n </bookmark>\n",
            xml_escape(uri)
        );
        text.insert_str(close, &entry);
    }
    Some(text)
}

fn write_kde_place(uri: Option<&str>) {
    let Some(path) = kde_places_path() else { return };
    // Only someone on KDE has the file; nobody else gets one made for them.
    let Ok(current) = std::fs::read_to_string(&path) else { return };
    let Some(next) = with_kde_place(&current, uri) else { return };
    if next != current {
        // Written in place, not beside and renamed: inside the sandbox this one file is
        // all that is shared with it, and nothing can be renamed over it.
        let _ = std::fs::write(&path, next);
    }
}

// ---- Settings ----

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveStatus {
    enabled: bool,
    edits: bool,
    by_date: bool,
    /// The name and port chosen in Settings; no port when any free one does.
    host: String,
    port: Option<u16>,
    /// A port chosen in Settings that something else held at start, so another is in use.
    port_taken: bool,
    /// The address for a file manager that does not read the GTK bookmarks.
    address: Option<String>,
}

pub fn status(app: &AppHandle) -> DriveStatus {
    let prefs = load_prefs(app);
    let running = drive();
    DriveStatus {
        enabled: prefs.enabled,
        edits: prefs.edits,
        by_date: prefs.by_date,
        port_taken: prefs.custom_port && running.as_ref().is_some_and(|d| d.port != prefs.port),
        port: prefs.custom_port.then_some(prefs.port),
        host: prefs.host,
        address: running.map(|d| d.address()),
    }
}

/// Whether `Photos/` is split into year and month folders. Applies at once.
pub fn set_by_date(app: &AppHandle, by_date: bool) -> DriveStatus {
    let mut prefs = load_prefs(app);
    prefs.by_date = by_date;
    save_prefs(app, &prefs);
    if let Some(d) = drive() {
        d.by_date.store(by_date, Ordering::SeqCst);
    }
    status(app)
}

/// Whether deleting and renaming in the file manager reach the library. Applies at once.
pub fn set_edits(app: &AppHandle, edits: bool) -> DriveStatus {
    let mut prefs = load_prefs(app);
    prefs.edits = edits;
    save_prefs(app, &prefs);
    if let Some(d) = drive() {
        d.edits.store(edits, Ordering::SeqCst);
    }
    status(app)
}

/// Applies at once: the server starts or stops and the bookmark follows it.
pub fn set_enabled(app: &AppHandle, enabled: bool) -> DriveStatus {
    let mut prefs = load_prefs(app);
    prefs.enabled = enabled;
    save_prefs(app, &prefs);
    if enabled {
        start_serving(app);
    } else {
        stop();
    }
    status(app)
}

/// Start, and when the app is already unlocked, serve at once rather than at the next
/// unlock.
fn start_serving(app: &AppHandle) {
    let unlocked = crate::sidecar_rpc(app, "lockStatus", serde_json::json!({}))
        .ok()
        .and_then(|s| s.get("unlocked").and_then(|v| v.as_bool()))
        == Some(true);
    start(app);
    if unlocked {
        session_started();
    }
}

/// Listen on another address or port, chosen in Settings (see `parse_address`). A new
/// port is tried before anything is let go of, so a taken one leaves the drive as it
/// was. The error is a code the page translates.
pub fn set_address(app: &AppHandle, host: &str, port: &str) -> Result<DriveStatus, String> {
    let (name, ip, port) = parse_address(host, port).map_err(str::to_string)?;
    let current = drive();
    let already_there = current.as_ref().is_some_and(|d| d.ip == ip && d.port == port);
    if port != 0 && !already_there && std::net::TcpListener::bind((ip, port)).is_err() {
        return Err("in-use".into());
    }
    let mut prefs = load_prefs(app);
    prefs.host = name.clone();
    prefs.custom_port = port != 0;
    if port != 0 {
        prefs.port = port;
    }
    save_prefs(app, &prefs);
    // Listen again only when where it listens, or the name it is called by, changed.
    // Back to any free port keeps the one in use.
    let moved = current
        .as_ref()
        .is_some_and(|d| d.host != name || d.ip != ip || (port != 0 && d.port != port));
    if prefs.enabled && moved {
        stop();
        start_serving(app);
    }
    Ok(status(app))
}

/// Downloads an earlier run left behind, for the startup sweep. Staged uploads are not
/// touched: see `start`.
pub fn reap(app: &AppHandle) {
    if let Ok(cache) = app.path().app_cache_dir() {
        let _ = std::fs::remove_dir_all(cache.join(HYDRATE_DIR));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_peer_is_found_by_its_ports_and_answers_with_its_uid() {
        let lo = format!("{:08X}", u32::from_ne_bytes([127, 0, 0, 1]));
        let table = format!(
            "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n\
             0: {lo}:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1\n\
             1: {lo}:D431 {lo}:1F90 01 00000000:00000000 00:00000000 00000000  1001        0 2\n\
             2: {lo}:1F90 {lo}:D431 01 00000000:00000000 00:00000000 00000000  1000        0 3\n"
        );
        // The client end (local 0xD431, remote 0x1F90) is the one that counts.
        assert_eq!(uid_in_table(&table, 0xD431, 0x1F90), Some(1001));
        assert_eq!(uid_in_table(&table, 0xD432, 0x1F90), None);
    }

    #[test]
    fn a_connection_that_is_not_loopback_is_not_ours() {
        let lo = format!("{:08X}", u32::from_ne_bytes([127, 0, 0, 1]));
        let far = format!("{:08X}", u32::from_ne_bytes([10, 0, 0, 7]));
        let table = format!(
            "header\n 1: {far}:D431 {lo}:1F90 01 00000000:00000000 00:00000000 00000000  1000        0 2\n"
        );
        assert_eq!(uid_in_table(&table, 0xD431, 0x1F90), None);
        // A v4-mapped IPv6 socket ends in the same word.
        let mapped = format!("0000000000000000FFFF0000{lo}");
        let table6 = format!(
            "header\n 1: {mapped}:D431 {mapped}:1F90 01 00000000:00000000 00:00000000 00000000  1000        0 2\n"
        );
        assert_eq!(uid_in_table(&table6, 0xD431, 0x1F90), Some(1000));
        // Any address in 127.0.0.0/8 is this machine; a plain IPv6 one is not ours.
        assert!(is_loopback_hex(&format!("{:08X}", u32::from_ne_bytes([127, 0, 0, 7]))));
        assert!(!is_loopback_hex(&format!("{:08X}", u32::from_ne_bytes([10, 0, 0, 7]))));
        assert!(!is_loopback_hex("00000000000000000000000001000000"));
    }

    #[test]
    fn only_the_loopback_host_on_our_port_is_accepted() {
        let names = host_names("127.0.0.1", std::net::Ipv4Addr::LOCALHOST);
        assert!(host_ok("127.0.0.1:4000", &names, 4000));
        assert!(host_ok("localhost:4000", &names, 4000));
        assert!(host_ok("LOCALHOST:4000", &names, 4000));
        assert!(!host_ok("127.0.0.1:4001", &names, 4000));
        assert!(!host_ok("evil.example:4000", &names, 4000));
        assert!(!host_ok("127.0.0.1", &names, 4000));
        // Another loopback address answers to its own name, not to localhost's.
        let other = host_names("127.0.0.7", "127.0.0.7".parse().unwrap());
        assert!(host_ok("127.0.0.7:4000", &other, 4000));
        assert!(!host_ok("localhost:4000", &other, 4000));
    }

    #[test]
    fn only_an_address_on_this_machine_can_be_chosen() {
        let lo = std::net::Ipv4Addr::LOCALHOST;
        assert_eq!(parse_address("", ""), Ok(("127.0.0.1".into(), lo, 0)));
        assert_eq!(parse_address(" LocalHost ", "8765"), Ok(("localhost".into(), lo, 8765)));
        assert_eq!(parse_address("127.0.0.7", "0"), Ok(("127.0.0.7".into(), "127.0.0.7".parse().unwrap(), 0)));
        // Nothing another machine could reach.
        assert_eq!(parse_address("0.0.0.0", ""), Err("address"));
        assert_eq!(parse_address("192.168.1.10", ""), Err("address"));
        assert_eq!(parse_address("example.com", ""), Err("address"));
        assert_eq!(parse_address("::1", ""), Err("address"));
        // No privileged port, and nothing that is not one.
        assert_eq!(parse_address("", "80"), Err("port"));
        assert_eq!(parse_address("", "70000"), Err("port"));
        assert_eq!(parse_address("", "abc"), Err("port"));
    }

    #[test]
    fn a_bookmark_of_ours_is_found_at_any_local_address() {
        assert!(is_our_bookmark(&format!("dav://127.0.0.1:4000/t/ {LABEL}")));
        assert!(is_our_bookmark(&format!("dav://localhost:4000/t/ {LABEL}")));
        assert!(is_our_bookmark(&format!("dav://127.0.0.7:4000/t/ {LABEL}")));
        assert!(!is_our_bookmark(&format!("dav://nas.local/photos {LABEL}")));
        assert!(!is_our_bookmark("dav://127.0.0.1:4000/t/ Something else"));
    }

    #[test]
    fn a_path_outside_the_token_or_walking_up_is_refused() {
        let t = "abc123";
        assert_eq!(segments("/abc123/", t), Some(vec![]));
        assert_eq!(segments("/abc123", t), Some(vec![]));
        assert_eq!(
            segments("/abc123/Photos/IMG%201.jpg", t),
            Some(vec!["Photos".to_string(), "IMG 1.jpg".to_string()])
        );
        assert_eq!(segments("/wrong/Photos", t), None);
        assert_eq!(segments("/", t), None);
        assert_eq!(segments("/abc123/Photos/../x", t), None);
        assert_eq!(segments("/abc123/%2E%2E/x", t), None);
        assert_eq!(segments("/abc123/a%2Fb", t), None);
        assert_eq!(segments("/abc123/%FF", t), None);
        // A Destination header is a whole URL.
        assert_eq!(
            segments("http://127.0.0.1:4000/abc123/Albums/Trip/a.jpg", t),
            Some(vec!["Albums".into(), "Trip".into(), "a.jpg".into()])
        );
    }

    #[test]
    fn names_round_trip_through_an_href() {
        let segs = vec!["Albums".to_string(), "Nyár & tél 100%".to_string(), "a b.jpg".to_string()];
        let h = href("tok", &segs, false);
        assert_eq!(segments(&h, "tok"), Some(segs.clone()));
        assert!(href("tok", &segs[..2], true).ends_with('/'));
    }

    #[test]
    fn names_are_made_safe_and_unique() {
        assert_eq!(sanitize_name("a/b\\c"), "a_b_c");
        assert_eq!(sanitize_name(".."), "photo");
        assert_eq!(sanitize_name("  "), "photo");
        assert_eq!(sanitize_name("x\u{0007}y"), "x_y");
        let taken = ["img.jpg", "img (2).jpg"];
        assert_eq!(unique_name("IMG.jpg", |c| taken.contains(&c)), "IMG (3).jpg");
        assert_eq!(unique_name("new.jpg", |c| taken.contains(&c)), "new.jpg");
        assert!(valid_name("Trip 2026"));
        assert!(!valid_name("a/b"));
        assert!(!valid_name(""));
        assert!(!valid_name(".."));
    }

    #[test]
    fn a_range_is_read_the_way_players_send_it() {
        assert_eq!(parse_range("bytes=0-99", 1000), Some(Ok((0, 99))));
        assert_eq!(parse_range("bytes=900-", 1000), Some(Ok((900, 999))));
        assert_eq!(parse_range("bytes=-100", 1000), Some(Ok((900, 999))));
        assert_eq!(parse_range("bytes=0-5000", 1000), Some(Ok((0, 999))));
        assert_eq!(parse_range("bytes=1000-", 1000), Some(Err(())));
        assert_eq!(parse_range("bytes=0-1,5-6", 1000), None);
        assert_eq!(parse_range("items=0-1", 1000), None);
    }

    #[test]
    fn the_bookmark_replaces_only_its_own_line() {
        let user = "file:///home/u/Music Music\nsftp://nas/ NAS\n";
        let with_ours = with_bookmark(user, Some("dav://127.0.0.1:4000/tok/"));
        assert_eq!(with_ours, format!("{user}dav://127.0.0.1:4000/tok/ {LABEL}\n"));
        // A new port replaces the old line rather than adding a second.
        let moved = with_bookmark(&with_ours, Some("dav://127.0.0.1:5000/tok/"));
        assert_eq!(moved.matches(LABEL).count(), 1);
        assert!(moved.contains(":5000/"));
        // Off takes it away and leaves the user's own untouched.
        assert_eq!(with_bookmark(&moved, None), user);
        // A bookmark the user named the same but pointing elsewhere is theirs.
        let theirs = format!("sftp://nas/ {LABEL}\n");
        assert_eq!(with_bookmark(&theirs, None), theirs);
    }

    #[test]
    fn listing_names_stay_unique_and_albums_hold_only_known_photos() {
        let mut index = Index::default();
        index.push_photo("u1", "IMG.jpg", 10, 0);
        index.push_photo("u2", "img.jpg", 20, 0);
        index.push_photo("u3", "x.jpg", 0, 0); // no size: skipped, as on Windows
        index.push_photo("u1", "again.jpg", 10, 0); // seen: skipped
        assert_eq!(index.photos.len(), 2);
        assert_eq!(index.photos[1].name, "img (2).jpg");
        index.set_albums(&[
            serde_json::json!({ "uid": "a1", "name": "Trip", "uids": ["u1", "u2", "shared-in"] }),
            serde_json::json!({ "uid": "a2", "name": "trip", "uids": [] }),
        ]);
        assert_eq!(index.albums[0].files.len(), 2);
        assert_eq!(index.albums[1].name, "trip (2)");
    }

    fn folder(target: Target) -> Dir {
        Dir::Folder(Folder {
            name: "f".into(),
            parent: String::new(),
            target: Arc::new(Mutex::new(target)),
            origin: true,
            made_ms: 0,
        })
    }

    fn album(uid: &str) -> Dir {
        Dir::Album { uid: uid.into(), name: uid.into() }
    }

    fn photo(uid: &str) -> Node {
        Node::Photo { uid: uid.into(), name: format!("{uid}.jpg"), size: 1, time_ms: 0 }
    }

    #[test]
    fn a_new_folder_lands_where_it_makes_sense() {
        assert_eq!(new_folder_kind(&Dir::Root), NewFolder::Album);
        assert_eq!(new_folder_kind(&Dir::Albums), NewFolder::Album);
        // Photos is the timeline: no album is made there.
        assert_eq!(new_folder_kind(&Dir::Photos), NewFolder::Timeline);
        assert_eq!(new_folder_kind(&album("a1")), NewFolder::Inherit);
        assert_eq!(new_folder_kind(&folder(Target::Timeline)), NewFolder::Inherit);
        // A timeline folder is not an album anything can be dropped into.
        assert!(target_of(&folder(Target::Timeline)).is_none());
        assert!(target_of(&folder(Target::New { name: "x".into(), uid: None })).is_some());
    }

    #[test]
    fn a_delete_never_destroys_a_photo() {
        assert_eq!(deletion(&photo("p1"), &Dir::Photos), Deletion::Trash("p1".into()));
        assert_eq!(
            deletion(&photo("p1"), &album("a1")),
            Deletion::FromAlbum { album: "a1".into(), photo: "p1".into() }
        );
        assert_eq!(
            deletion(&photo("p1"), &folder(Target::Existing("a2".into()))),
            Deletion::FromAlbum { album: "a2".into(), photo: "p1".into() }
        );
        assert_eq!(deletion(&Node::Dir(album("a1")), &Dir::Albums), Deletion::Album("a1".into()));
        assert_eq!(deletion(&Node::Dir(folder(Target::Timeline)), &Dir::Photos), Deletion::Local);
        // The three fixed folders stay.
        assert_eq!(deletion(&Node::Dir(Dir::Photos), &Dir::Root), Deletion::Refused);
        assert_eq!(deletion(&Node::Dir(Dir::Albums), &Dir::Root), Deletion::Refused);
    }

    #[test]
    fn a_move_is_a_rename_or_a_change_of_album() {
        assert_eq!(moving(&photo("p1"), &Dir::Photos, &Dir::Photos, true), Moving::RenamePhoto("p1".into()));
        assert_eq!(
            moving(&Node::Dir(album("a1")), &Dir::Albums, &Dir::Albums, true),
            Moving::RenameAlbum("a1".into())
        );
        assert_eq!(
            moving(&photo("p1"), &Dir::Photos, &album("a1"), false),
            Moving::IntoAlbum { from: None }
        );
        assert_eq!(
            moving(&photo("p1"), &album("a1"), &album("a2"), false),
            Moving::IntoAlbum { from: Some("a1".into()) }
        );
        // Into a folder of the same album there is nothing to leave.
        assert_eq!(
            moving(&photo("p1"), &album("a1"), &folder(Target::Existing("a1".into())), false),
            Moving::IntoAlbum { from: None }
        );
        assert_eq!(moving(&photo("p1"), &album("a1"), &Dir::Photos, false), Moving::OutOfAlbum("a1".into()));
        // Nothing else moves: not a photo onto the album list, not an album anywhere.
        assert_eq!(moving(&photo("p1"), &Dir::Photos, &Dir::Albums, false), Moving::Refused);
        assert_eq!(moving(&Node::Dir(album("a1")), &Dir::Albums, &Dir::Photos, false), Moving::Refused);
        assert_eq!(moving(&photo("p1"), &Dir::Photos, &folder(Target::Timeline), false), Moving::Refused);
    }

    #[test]
    fn the_listing_follows_a_change_at_once() {
        let mut index = Index::default();
        index.push_photo("u1", "a.jpg", 10, 0);
        index.push_photo("u2", "b.jpg", 10, 0);
        index.set_albums(&[serde_json::json!({ "uid": "a1", "name": "Trip", "uids": ["u1", "u2"] })]);

        index.rename_photo("u1", "renamed.jpg");
        assert!(index.photo_names.contains_key("renamed.jpg"));
        assert!(!index.photo_names.contains_key("a.jpg"));
        assert!(index.albums[0].names.contains_key("renamed.jpg"));

        index.remove_from_album("a1", "u2");
        assert_eq!(index.albums[0].files.len(), 1);
        index.add_to_album("a1", "u2");
        index.add_to_album("a1", "u2");
        assert_eq!(index.albums[0].files.len(), 2, "added once");

        index.forget_photo("u1");
        assert!(!index.has_photo(0));
        assert!(index.has_photo(1));
        assert_eq!(index.albums[0].files.len(), 1);

        index.rename_album("a1", "Holiday");
        assert!(index.album_names.contains_key("holiday"));
        index.forget_album("a1");
        assert!(!index.has_album(0));
        assert!(index.album_names.is_empty());
    }

    #[test]
    fn a_time_lands_in_its_calendar_month() {
        assert_eq!(year_month(0), (1970, 1));
        assert_eq!(year_month(-1), (1969, 12));
        assert_eq!(year_month(1_758_672_000_000), (2025, 9)); // 2025-09-24
        assert_eq!(year_month(1_709_208_000_000), (2024, 2)); // 2024-02-29, a leap day
        assert_eq!(year_month(951_868_800_000), (2000, 3)); // 2000-03-01
        assert_eq!(year_month(1_735_689_599_999), (2024, 12)); // the last moment of 2024
    }

    #[test]
    fn the_trash_and_what_is_shared_are_never_changed_from_here() {
        assert_eq!(deletion(&photo("p1"), &Dir::Trash), Deletion::Refused);
        assert_eq!(deletion(&photo("p1"), &Dir::Shared), Deletion::Refused);
        let shared_album = Dir::SharedAlbum { uid: "s1".into(), name: "s1".into() };
        assert_eq!(deletion(&photo("p1"), &shared_album), Deletion::Refused);
        assert_eq!(deletion(&Node::Dir(Dir::Trash), &Dir::Root), Deletion::Refused);
        assert_eq!(moving(&photo("p1"), &Dir::Trash, &Dir::Trash, true), Moving::Refused);
        assert_eq!(moving(&photo("p1"), &Dir::Shared, &Dir::Photos, false), Moving::Refused);
        assert_eq!(moving(&photo("p1"), &Dir::Photos, &Dir::Shared, false), Moving::Refused);
        assert_eq!(moving(&photo("p1"), &Dir::Trash, &album("a1"), false), Moving::Restore("p1".into()));
        assert_eq!(moving(&photo("p1"), &Dir::Trash, &Dir::Albums, false), Moving::Refused);
        assert_eq!(new_folder_kind(&Dir::Trash), NewFolder::Refused);
        assert_eq!(new_folder_kind(&Dir::Favorites), NewFolder::Refused);
    }

    #[test]
    fn favourites_trash_and_dates_move_as_the_library_does() {
        assert_eq!(deletion(&photo("p1"), &Dir::Favorites), Deletion::Unfavorite("p1".into()));
        assert_eq!(deletion(&photo("p1"), &Dir::Month(2025, 9)), Deletion::Trash("p1".into()));
        assert_eq!(moving(&photo("p1"), &Dir::Trash, &Dir::Photos, false), Moving::Restore("p1".into()));
        assert_eq!(moving(&photo("p1"), &Dir::Trash, &Dir::Month(2025, 9), false), Moving::Restore("p1".into()));
        assert_eq!(moving(&photo("p1"), &Dir::Photos, &Dir::Trash, false), Moving::ToTrash("p1".into()));
        assert_eq!(moving(&photo("p1"), &album("a1"), &Dir::Favorites, false), Moving::Favorite("p1".into()));
        assert_eq!(moving(&photo("p1"), &Dir::Favorites, &Dir::Photos, false), Moving::Unfavorite("p1".into()));
        assert_eq!(
            moving(&photo("p1"), &Dir::Month(2025, 9), &album("a1"), false),
            Moving::IntoAlbum { from: None }
        );
        assert_eq!(moving(&photo("p1"), &album("a1"), &Dir::Month(2025, 9), false), Moving::OutOfAlbum("a1".into()));
        assert_eq!(new_folder_kind(&Dir::Month(2025, 9)), NewFolder::Timeline);
    }

    #[test]
    fn a_photo_goes_to_the_trash_and_back_in_the_listing() {
        let mut index = Index::default();
        index.push_photo("u1", "a.jpg", 10, 0);
        index.favorites.insert("u1".into());
        index.trash_photo("u1");
        assert!(!index.has_photo(0));
        assert!(!index.favorites.contains("u1"));
        assert!(index.trash.get("a.jpg").is_some());
        index.restore_photo("u1");
        assert!(index.has_photo(0));
        assert!(index.trash.get("a.jpg").is_none());
        assert_eq!(index.trash.listed().count(), 0);
    }

    #[test]
    fn the_trash_and_the_shared_folders_load_with_names_of_their_own() {
        let mut index = Index::default();
        index.set_extras(&serde_json::json!({
            "trash": [{ "uid": "t1", "name": "x.jpg", "size": 5, "captureTime": 0 },
                      { "uid": "t2", "name": "x.jpg", "size": 5, "captureTime": 0 }],
            "shared": [{ "uid": "s1", "name": "Trip", "size": 5, "captureTime": 0 }],
            "sharedAlbums": [{ "uid": "sa", "name": "Trip", "photos": [
                { "uid": "p1", "name": "y.jpg", "size": 5, "captureTime": 0 }] }],
        }));
        assert!(index.trash.get("x (2).jpg").is_some());
        // A shared album never takes a shared photo's name.
        assert_eq!(index.shared_albums[0].name, "Trip (2)");
        assert_eq!(index.shared_albums[0].shelf.listed().count(), 1);
    }

    #[test]
    fn the_kde_place_is_ours_alone() {
        let kde = "<?xml version=\"1.0\"?>\n<xbel>\n <bookmark href=\"file:///home/u\">\n  <title>Home</title>\n </bookmark>\n</xbel>\n";
        let with_ours = with_kde_place(kde, Some("webdav://127.0.0.1:4000/tok/")).unwrap();
        assert!(with_ours.contains("webdav://127.0.0.1:4000/tok/"));
        assert!(with_ours.contains("<title>Home</title>"));
        // A new address replaces the entry rather than adding another.
        let moved = with_kde_place(&with_ours, Some("webdav://127.0.0.1:5000/tok/")).unwrap();
        assert_eq!(moved.matches(KDE_ID).count(), 1);
        assert!(!moved.contains(":4000/"));
        // Off takes it away and leaves the file exactly as it was.
        assert_eq!(with_kde_place(&moved, None).unwrap(), kde);
        // Something that is not a places file is left alone.
        assert_eq!(with_kde_place("not xml", Some("webdav://x/")), None);
    }

    #[test]
    fn downloads_run_a_few_at_a_time_and_the_newest_waiter_goes_first() {
        let slots = Arc::new(Slots::default());
        let held: Vec<Slot> = (0..MAX_DOWNLOADS).map(|_| slots.take().unwrap()).collect();
        let order = Arc::new(Mutex::new(Vec::new()));
        let mut waiters = Vec::new();
        for n in 0..2 {
            let (mine, log) = (slots.clone(), order.clone());
            waiters.push(std::thread::spawn(move || {
                let slot = mine.take().unwrap();
                log.lock().unwrap().push(n);
                std::thread::sleep(Duration::from_millis(50));
                drop(slot);
            }));
            // Queued in this order: 0 first, then 1.
            while slots.0.state.lock().unwrap().waiting.len() < n + 1 {
                std::thread::yield_now();
            }
        }
        // Nobody past the limit got one.
        assert!(order.lock().unwrap().is_empty());
        assert_eq!(slots.0.state.lock().unwrap().running, MAX_DOWNLOADS);
        // One place frees: the newest request takes it.
        let mut held = held;
        drop(held.pop());
        while order.lock().unwrap().is_empty() {
            std::thread::yield_now();
        }
        assert_eq!(order.lock().unwrap()[0], 1);
        drop(held);
        for w in waiters {
            w.join().unwrap();
        }
        assert_eq!(*order.lock().unwrap(), vec![1, 0]);
        assert_eq!(slots.0.state.lock().unwrap().running, 0);
    }

    #[test]
    fn xml_carries_names_safely() {
        assert_eq!(xml_escape("a<b>&\"c'"), "a&lt;b&gt;&amp;&quot;c&apos;");
    }
}
