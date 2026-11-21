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

//! Moving the Proton Photos folder to another place, and keeping watch over the drive it is on.
//!
//! The safety of a move rests on one order. The old folder is let go of by the sync engine
//! first: Explorer's watcher stopped, the engine disconnected, the sync root unregistered. Only
//! then is anything in it removed, because a placeholder removed under a registered root is
//! reported to the provider as the user deleting that photo, and the library would send it to
//! the trash. An unregistered root reports nothing. `clean_old_root` takes the proof of the
//! unregister as an argument, and checks the registration itself as well.
//!
//! Only the app's own placeholders are removed. Which files those are is read off the files while
//! the folder is still a sync root, because the unregister takes that record off them: the
//! cloud-only ones are removed by Windows itself, and the downloaded ones become plain files.
//! A downloaded copy goes only when it is of a photo the folder's index lists, which the move
//! downloads again in the new place; any other copy, such as the one left of a photo deleted
//! from Drive for good, stays in the old folder.

use super::*;
use crate::sync_location as place;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

static MOVING: AtomicBool = AtomicBool::new(false);
static RESTORING: AtomicBool = AtomicBool::new(false);

/// The photos a move still has to download again in the new place, sealed in the app's folder
/// until they are, so a first fill that fails or a restart in between loses none of them.
pub(crate) const RESTORE_FILE: &str = "relocate-restore.enc";

struct Moving;

impl Drop for Moving {
    fn drop(&mut self) {
        MOVING.store(false, Ordering::SeqCst);
    }
}

/// What `unregister_sync_root` hands back when the folder is no longer a sync root. It can be
/// made nowhere else.
struct Unregistered(());

fn own_id() -> Result<cloud_filter::root::SyncRootId, String> {
    use cloud_filter::root::{SecurityId, SyncRootIdBuilder};
    let sid = SecurityId::current_user().map_err(|e| format!("{e:?}"))?;
    Ok(SyncRootIdBuilder::new("ProtonPhotos").user_security_id(sid).build())
}

/// Takes the folder out of the sync roots. Succeeds only once it no longer is one.
fn unregister_sync_root() -> Result<Unregistered, String> {
    let id = own_id()?;
    if id.is_registered().map_err(|e| format!("{e:?}"))? {
        id.unregister().map_err(|e| format!("{e:?}"))?;
    }
    if id.is_registered().map_err(|e| format!("{e:?}"))? {
        return Err("still registered".into());
    }
    Ok(Unregistered(()))
}

/// Where the folder is and whether its drive is there, for the Settings row.
pub(super) fn info() -> LocationInfo {
    let current = place::current();
    LocationInfo {
        is_default: place::same_place(&current.path, &default_sync_root()),
        available: place::drive_present(&place::WinProbe, &current),
        moving: MOVING.load(Ordering::SeqCst),
        path: current.path.to_string_lossy().into_owned(),
    }
}

/// Whether a picked folder can be the new place, and what the Settings row tells about it.
pub(super) fn check(picked: &str) -> LocationCheck {
    let (picked, current) = (PathBuf::from(picked), sync_root_path());
    match place::on_com_thread(move || place::validate(&place::WinProbe, &picked, &current)) {
        Some(Ok(ok)) => LocationCheck {
            ok: true,
            reason: None,
            path: ok.path.to_string_lossy().into_owned(),
            free: ok.free,
            adjusted: ok.adjusted,
        },
        Some(Err(reason)) => LocationCheck { reason: Some(reason.code()), ..Default::default() },
        None => LocationCheck { reason: Some("unreadable"), ..Default::default() },
    }
}

/// Moves the folder. The error is a code the window words: a rule the place broke, or the step
/// that did not work.
pub(super) fn move_folder(app: &tauri::AppHandle, picked: &Path) -> Result<LocationMoved, String> {
    if MOVING.swap(true, Ordering::SeqCst) {
        return Err("busy".into());
    }
    let _moving = Moving;
    let (app, picked) = (app.clone(), picked.to_path_buf());
    place::on_com_thread(move || run(&app, &picked)).unwrap_or_else(|| Err("failed".into()))
}

/// A step failed after the folder was let go of: the folder is attached again where it was, and
/// the failure is reported.
fn fail(app: &tauri::AppHandle, code: &str) -> Result<LocationMoved, String> {
    mount(app.clone());
    Err(code.into())
}

fn run(app: &tauri::AppHandle, picked: &Path) -> Result<LocationMoved, String> {
    let _life = place::lifecycle();
    let old = sync_root_path();
    if !place::available() {
        return Err("driveMissing".into());
    }
    let accepted = place::validate(&place::WinProbe, picked, &old).map_err(|r| r.code().to_string())?;
    // The new place is made first: one that cannot be made stops the move before anything is let go of.
    std::fs::create_dir_all(&accepted.path).map_err(|_| "create".to_string())?;
    let fill = populate_lock();
    crate::note(app, "[cloud] moving the folder");
    let local = local_copy_tails(&old);
    let listed: Vec<String> = mount_index().lock().unwrap().keys().cloned().collect();
    let restore = place::match_tails(&timeline_uids(), &local);

    // Nothing watches or answers for the old folder any more.
    crate::keep_all::interrupt();
    if let Err(e) = detach() {
        crate::note(app, &format!("[cloud] move stopped: {e}"));
        return fail(app, "detach");
    }
    let ours = own_placeholders(&old, &listed.into_iter().collect());
    // The old root is unregistered FIRST. Without the proof it hands back, nothing below runs.
    let unregistered = match unregister_sync_root() {
        Ok(proof) => proof,
        Err(e) => {
            crate::note(app, &format!("[cloud] move stopped, could not unregister: {e}"));
            return fail(app, "unregister");
        }
    };
    // Recorded before anything is removed: what goes from the old folder comes back from here.
    if let Err(e) = save_restore(app, &restore) {
        crate::note(app, &format!("[cloud] move stopped, could not note the photos to download again: {e}"));
        return fail(app, "save");
    }
    let left = match clean_old_root(&unregistered, &old, &ours) {
        Ok(left) => left,
        Err(e) => {
            crate::note(app, &format!("[cloud] move stopped while clearing the old folder: {e}"));
            return fail(app, "clean");
        }
    };

    forget_mount_state();
    if let Ok(dir) = crate::secure_store::app_dir(app) {
        let _ = std::fs::remove_file(dir.join(crate::explorer_sync::SEEN_FILE));
    }
    if let Err(e) = place::save(&accepted.path, accepted.volume) {
        crate::note(app, &format!("[cloud] move stopped, could not save the place: {e}"));
        return fail(app, "save");
    }
    if !attach(app) {
        return Err("register".into());
    }
    let first_fill = {
        let _busy = BusyGuard::new(app);
        let _doing = Doing::new(app, "fill", None, None);
        match populate_locked(app) {
            Ok(()) => {
                FILL_STARTED.store(true, Ordering::SeqCst);
                filled();
                true
            }
            Err(e) => {
                crate::note(app, &format!("[cloud] first fill of the new folder failed: {e}"));
                forget_fills();
                false
            }
        }
    };
    drop(fill);
    crate::note(app, "[cloud] folder moved");

    // What was on this PC comes back in the background once the new folder is filled; the move
    // is done without waiting for it. A failed first fill leaves it to the next fill.
    if first_fill {
        resume_restore(app);
    }
    {
        use tauri::Emitter;
        let _ = app.emit("refresh-view", ());
    }
    Ok(LocationMoved { path: accepted.path.to_string_lossy().into_owned(), left })
}

/// The uid ends of the downloaded copies in a folder, at any depth. Nothing is opened but a copy
/// that holds its data, so reading them recalls nothing.
fn local_copy_tails(root: &Path) -> HashSet<String> {
    let mut out = HashSet::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            match entry.file_type() {
                Ok(t) if t.is_dir() => stack.push(entry.path()),
                Ok(t) if t.is_file() => {
                    if let Some(tail) = downloaded_uid(&entry.path()) {
                        out.insert(tail);
                    }
                }
                _ => {}
            }
        }
    }
    out
}

/// The app's own placeholders in a folder, at any depth, each with its file id: the Cloud Files
/// placeholders whose sync root is that folder and that hold no change the cloud lacks. A file
/// changed in the folder and not yet uploaded is no longer in sync, and is left out, and so is
/// one whose photo is not among the `listed` ones. The unregister removes a cloud-only one of
/// those by itself; a downloaded one, such as the copy left of a photo deleted from Drive for
/// good, stays as a plain file.
fn own_placeholders(root: &Path, listed: &HashSet<String>) -> HashMap<PathBuf, i64> {
    let mut out = HashMap::new();
    let Some(root_id) = file_id(root) else { return out };
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            match entry.file_type() {
                Ok(t) if t.is_dir() => stack.push(entry.path()),
                Ok(t) if t.is_file() => {
                    let path = entry.path();
                    let Some(placeholder) = placeholder_state(&path) else { continue };
                    if placeholder.sync_root == root_id && placeholder.in_sync && listed.contains(&placeholder.uid) {
                        if let Some(id) = file_id(&path) {
                            out.insert(path, id);
                        }
                    }
                }
                _ => {}
            }
        }
    }
    out
}

/// Removes what the app put in the old folder: its placeholders, cloud-only and downloaded alike,
/// and the folders that are empty afterwards. `ours` is what `own_placeholders` found before the
/// unregister; a file goes only when it is one of those and still the same file. Anything else
/// stays, with the folders around it: a file the user put there, a placeholder of another
/// program, a deduplicated or a linked file, and a file that cannot be removed right now.
/// Returns how many such files stay.
///
/// Refuses while the folder is still a sync root.
fn clean_old_root(_: &Unregistered, root: &Path, ours: &HashMap<PathBuf, i64>) -> Result<u64, String> {
    if own_id()?.is_registered().map_err(|e| format!("{e:?}"))? {
        return Err("the folder is still a sync root".into());
    }
    if !root.is_dir() {
        return Ok(0);
    }
    clean_dir(root, true, ours)
}

fn clean_dir(dir: &Path, top: bool, ours: &HashMap<PathBuf, i64>) -> Result<u64, String> {
    let mut left = 0u64;
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if top => return Err(format!("read: {e}")),
        Err(_) => return Ok(1),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        match entry.file_type() {
            Ok(t) if t.is_symlink() => left += 1,
            Ok(t) if t.is_dir() => left += clean_dir(&path, false, ours)?,
            Ok(t) if t.is_file() => {
                // A file in use stays where it is, and the rest of the folder is still cleared.
                let gone = ours.get(&path).is_some_and(|&id| file_id(&path) == Some(id))
                    && std::fs::remove_file(&path).is_ok();
                if !gone {
                    left += 1;
                }
            }
            _ => left += 1,
        }
    }
    // The top folder may be one the user is looking at in Explorer right now; any other folder
    // that cannot be removed counts as one thing left.
    if left == 0 && std::fs::remove_dir(dir).is_err() && !top {
        left += 1;
    }
    Ok(left)
}

struct PlaceholderState {
    /// The file id of the sync root the placeholder was made under.
    sync_root: i64,
    in_sync: bool,
    /// The uid of the photo it was made for, whole.
    uid: String,
}

/// What a Cloud Files placeholder records about itself. The open asks for attributes only and
/// carries no-recall, so a cloud-only placeholder is not downloaded by it. None for a file that
/// is no placeholder.
fn placeholder_state(path: &Path) -> Option<PlaceholderState> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::CloudFilters::{
        CfGetPlaceholderInfo, CF_IN_SYNC_STATE_IN_SYNC, CF_PLACEHOLDER_BASIC_INFO, CF_PLACEHOLDER_INFO_BASIC,
    };
    const OPEN_NO_RECALL: u32 = 0x0010_0000;
    let file = open_attributes_only(path, OPEN_NO_RECALL)?;
    let mut buf = vec![0u8; std::mem::size_of::<CF_PLACEHOLDER_BASIC_INFO>() + 4096];
    unsafe {
        CfGetPlaceholderInfo(
            HANDLE(file.as_raw_handle()),
            CF_PLACEHOLDER_INFO_BASIC,
            buf.as_mut_ptr() as _,
            buf.len() as u32,
            None,
        )
    }
    .ok()?;
    let info = unsafe { std::ptr::read_unaligned(buf.as_ptr() as *const CF_PLACEHOLDER_BASIC_INFO) };
    let start = std::mem::offset_of!(CF_PLACEHOLDER_BASIC_INFO, FileIdentity);
    let identity = buf.get(start..start + info.FileIdentityLength as usize).unwrap_or_default();
    Some(PlaceholderState {
        sync_root: info.SyncRootFileId,
        in_sync: info.InSyncState == CF_IN_SYNC_STATE_IN_SYNC,
        uid: String::from_utf8_lossy(identity).into_owned(),
    })
}

/// A file's or folder's file id, which stays with it through a rename and is not reused while it exists.
fn file_id(path: &Path) -> Option<i64> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION};
    let file = open_attributes_only(path, 0)?;
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut info) }.ok()?;
    Some(((info.nFileIndexHigh as i64) << 32) | info.nFileIndexLow as i64)
}

fn open_attributes_only(path: &Path, flags: u32) -> Option<std::fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    const READ_ATTRIBUTES: u32 = 0x80;
    const SHARE_ALL: u32 = 0x7;
    const OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const BACKUP_SEMANTICS: u32 = 0x0200_0000;
    std::fs::OpenOptions::new()
        .access_mode(READ_ATTRIBUTES)
        .share_mode(SHARE_ALL)
        .custom_flags(OPEN_REPARSE_POINT | BACKUP_SEMANTICS | flags)
        .open(path)
        .ok()
}

fn save_restore(app: &tauri::AppHandle, uids: &[String]) -> Result<(), String> {
    if uids.is_empty() {
        clear_restore(app);
        return Ok(());
    }
    crate::secure_store::write_sealed(app, RESTORE_FILE, &uids.join("\n"))
}

fn clear_restore(app: &tauri::AppHandle) {
    if let Ok(dir) = crate::secure_store::app_dir(app) {
        let _ = std::fs::remove_file(dir.join(RESTORE_FILE));
    }
}

/// Starts downloading again what a move noted, when there is something noted and nothing is
/// doing it already. Called after every fill that succeeded.
pub(crate) fn resume_restore(app: &tauri::AppHandle) {
    let uids: Vec<String> = match crate::secure_store::read_sealed(app, RESTORE_FILE) {
        Ok(Some(text)) => text.lines().filter(|l| !l.is_empty()).map(str::to_string).collect(),
        _ => return,
    };
    if uids.is_empty() || RESTORING.swap(true, Ordering::SeqCst) {
        return;
    }
    let (keep, root) = (app.clone(), sync_root_path());
    std::thread::spawn(move || {
        restore_local(&keep, &uids, &root);
        RESTORING.store(false, Ordering::SeqCst);
    });
}

/// Downloads again the photos that were on this PC before the move, as far as the new drive has
/// room. The folder's mode (every photo, or the photos that arrive) carries on by itself.
fn restore_local(app: &tauri::AppHandle, uids: &[String], root: &Path) {
    let _busy = BusyGuard::new(app);
    let _doing = Doing::new(app, "offline", None, None);
    let mut restored = 0usize;
    for uid in uids {
        if sync_root_path() != root || !show_in_explorer_enabled() || detaching() {
            break;
        }
        let size = cloud_size_of(uid).unwrap_or(0);
        if free_space().is_some_and(|free| !crate::keep_all::space_ok(free, size)) {
            crate::note(app, "[cloud] the new drive is full, the rest stays in the cloud");
            break;
        }
        if hydrate_cloud_only(uid) {
            restored += 1;
        }
    }
    clear_restore(app);
    rescan_hydrated();
    bump_hydrated_version();
    crate::keep_all::nudge();
    crate::note(app, &format!("[cloud] {restored} of {} photos on this PC downloaded again", uids.len()));
}

/// Watches for the folder's drive going away and coming back. With the drive gone the engine is
/// disconnected and nothing else is touched; with it back, the folder is attached again.
pub(super) fn watch_drive(app: tauri::AppHandle) {
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        com_init();
        let mut was = place::available();
        loop {
            std::thread::sleep(place::DRIVE_CHECK_EVERY);
            if MOVING.load(Ordering::SeqCst) || !show_in_explorer_enabled() {
                continue;
            }
            let _life = place::lifecycle();
            let now = place::available();
            if now && !mounted() {
                attach(&app);
            } else if !now && mounted() {
                if let Err(e) = detach() {
                    crate::note(&app, &format!("[cloud] could not let go of the folder: {e}"));
                }
            }
            if now != was {
                was = now;
                crate::note(&app, if now { "[cloud] the folder's drive is back" } else { "[cloud] the folder's drive is gone" });
                use tauri::Emitter;
                let _ = app.emit("explorer-location", info());
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Gives a file a reparse point of a tag that is not the Cloud Files one, the way a
    /// deduplicated file or another program's file carries one.
    fn foreign_reparse_point(path: &Path) {
        use std::os::windows::fs::OpenOptionsExt;
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::System::IO::DeviceIoControl;
        const FSCTL_SET_REPARSE_POINT: u32 = 0x0009_00A4;
        const OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        let data = b"not a placeholder";
        let mut buf = Vec::new();
        buf.extend_from_slice(&0x0000_7A11u32.to_le_bytes());
        buf.extend_from_slice(&(data.len() as u16).to_le_bytes());
        buf.extend_from_slice(&0u16.to_le_bytes());
        buf.extend_from_slice(&[0x5Au8; 16]);
        buf.extend_from_slice(data);
        let file = std::fs::OpenOptions::new().write(true).custom_flags(OPEN_REPARSE_POINT).open(path).expect("open");
        let set = unsafe {
            DeviceIoControl(
                HANDLE(file.as_raw_handle()),
                FSCTL_SET_REPARSE_POINT,
                Some(buf.as_ptr() as _),
                buf.len() as u32,
                None,
                0,
                None,
                None,
            )
        };
        set.expect("set reparse point");
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pfp-relocate-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("Photos")).unwrap();
        dir
    }

    #[test]
    fn a_reparse_point_that_is_no_placeholder_of_ours_stays() {
        let root = scratch("foreign");
        let file = root.join("Photos").join("deduplicated.jpg");
        std::fs::write(&file, b"user data").unwrap();
        foreign_reparse_point(&file);
        assert!(file_attributes(&file).is_some_and(|a| a & 0x400 != 0));

        let left = clean_dir(&root, true, &HashMap::new()).unwrap();

        assert!(file.exists(), "a file that is not one of the app's placeholders was deleted");
        assert_eq!(left, 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn only_the_same_file_that_was_found_ours_is_removed() {
        let root = scratch("ours");
        let dir = root.join("Photos");
        let (ours, swapped, user) = (dir.join("ours.jpg"), dir.join("swapped.jpg"), dir.join("user.jpg"));
        for f in [&ours, &swapped, &user] {
            std::fs::write(f, b"x").unwrap();
        }
        let mut found = HashMap::new();
        found.insert(ours.clone(), file_id(&ours).unwrap());
        found.insert(swapped.clone(), file_id(&swapped).unwrap());
        // Another file put in its place after it was found.
        std::fs::remove_file(&swapped).unwrap();
        std::fs::write(dir.join("other.jpg"), b"y").unwrap();
        std::fs::rename(dir.join("other.jpg"), &swapped).unwrap();

        let left = clean_dir(&root, true, &found).unwrap();

        assert!(!ours.exists());
        assert!(swapped.exists());
        assert!(user.exists());
        assert_eq!(left, 2);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_file_that_cannot_be_removed_stays_and_the_rest_is_still_cleared() {
        use std::os::windows::fs::OpenOptionsExt;
        let root = scratch("in-use");
        let dir = root.join("Photos");
        let (busy, free) = (dir.join("busy.jpg"), dir.join("free.jpg"));
        for f in [&busy, &free] {
            std::fs::write(f, b"x").unwrap();
        }
        let found: HashMap<PathBuf, i64> =
            [&busy, &free].iter().map(|f| ((*f).clone(), file_id(f).unwrap())).collect();
        // Open with no sharing, as a program holding the file would.
        let held = std::fs::OpenOptions::new().read(true).share_mode(0).open(&busy).unwrap();

        let left = clean_dir(&root, true, &found);

        drop(held);
        assert_eq!(left, Ok(1), "the busy file stays");
        assert!(busy.exists());
        assert!(!free.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_plain_file_is_no_placeholder() {
        let root = scratch("plain");
        let file = root.join("Photos").join("plain.jpg");
        std::fs::write(&file, b"x").unwrap();
        assert!(placeholder_state(&file).is_none());
        assert!(own_placeholders(&root, &HashSet::new()).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Registers a throwaway sync root under another name, so it is run by hand only:
    /// `cargo test --lib own_placeholders_across_unregister -- --ignored`.
    #[test]
    #[ignore]
    fn own_placeholders_across_unregister() {
        use cloud_filter::metadata::Metadata;
        use cloud_filter::placeholder::{ConvertOptions, Placeholder};
        use cloud_filter::placeholder_file::PlaceholderFile;
        use cloud_filter::root::{SecurityId, SyncRootIdBuilder};
        let root = scratch("unregister");
        let id = SyncRootIdBuilder::new("PfpRelocateTest").user_security_id(SecurityId::current_user().unwrap()).build();
        register_with_insync_policy(&id, &root, r"%SystemRoot%\system32\shell32.dll,0").unwrap();
        let dir = root.join("Photos");
        PlaceholderFile::new("cloud.jpg")
            .mark_in_sync()
            .metadata(Metadata::file().size(5))
            .blob(b"uid-cloud".to_vec())
            .create::<&Path>(&dir)
            .unwrap();
        let convert = |name: &str, options: ConvertOptions| {
            std::fs::write(dir.join(name), b"hello").unwrap();
            let mut placeholder: Placeholder =
                std::fs::OpenOptions::new().write(true).open(dir.join(name)).unwrap().into();
            placeholder.convert_to_placeholder(options, None).unwrap();
        };
        convert("local.jpg", ConvertOptions::default().mark_in_sync().blob(b"uid-local".to_vec()));
        // The copy left of a photo deleted from Drive for good: downloaded, in sync, not listed.
        convert("orphan.jpg", ConvertOptions::default().mark_in_sync().blob(b"uid-orphan".to_vec()));
        convert("edited.jpg", ConvertOptions::default().blob(b"uid-edited".to_vec()));
        std::fs::write(dir.join("user.jpg"), b"user").unwrap();
        let deduplicated = dir.join("deduplicated.jpg");
        std::fs::write(&deduplicated, b"user").unwrap();
        foreign_reparse_point(&deduplicated);

        let listed: HashSet<String> = ["uid-cloud", "uid-local", "uid-edited"].map(String::from).into_iter().collect();
        let ours = own_placeholders(&root, &listed);
        let mut downloaded = super::super::downloaded_copies_under(&root);
        id.unregister().unwrap();
        let left = clean_dir(&root, true, &ours);
        let names: Vec<String> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        let _ = std::fs::remove_dir_all(&root);

        let mut found: Vec<_> = ours.keys().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
        found.sort();
        assert_eq!(found, ["cloud.jpg", "local.jpg"]);
        downloaded.sort();
        assert_eq!(downloaded, [r"Photos\edited.jpg", r"Photos\local.jpg", r"Photos\orphan.jpg"]);
        assert_eq!(left, Ok(4));
        let mut names = names;
        names.sort();
        assert_eq!(names, ["deduplicated.jpg", "edited.jpg", "orphan.jpg", "user.jpg"]);
    }
}
