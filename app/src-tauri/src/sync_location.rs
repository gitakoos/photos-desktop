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

//! Where the Proton Photos folder lives.
//!
//! The place is the one chosen in Settings, kept in the same HKCU key as the other Explorer
//! preferences (the uninstaller reads it too), together with the serial number of the volume it
//! was chosen on. With nothing stored the folder is `%USERPROFILE%\Proton Photos`, as it always
//! was. A folder on a drive that is not there, or on another disk that took its letter, is a
//! paused folder: nothing is registered, created or deleted for it.
//!
//! Every decision about a picked folder is made by `validate` over a `Probe`, so the rules need
//! no real drives to be tested; `WinProbe` answers from the system.

#![cfg(windows)]

use std::collections::{BTreeMap, HashSet};
use std::path::{Component, Path, PathBuf, Prefix};
use std::sync::{Mutex, MutexGuard};

const LOCATION_VALUE: &str = "SyncRoot";
const VOLUME_VALUE: &str = "SyncRootVolume";

/// The id the app registers its own sync root under; every other id is another provider's.
const OWN_ID_PREFIX: &str = "ProtonPhotos!";

/// How often a folder whose drive is gone is looked for again.
pub const DRIVE_CHECK_EVERY: std::time::Duration = std::time::Duration::from_secs(30);

/// The place chosen for the folder, and the volume it was chosen on.
#[derive(Clone, Debug, PartialEq)]
pub struct Location {
    pub path: PathBuf,
    pub volume: Option<u32>,
}

/// What is stored (nothing, or a path and a volume serial) as the place to use. A value that is
/// empty or not an absolute local path is no choice, and a volume with no choice is not kept.
pub fn resolve(stored_path: Option<String>, stored_volume: Option<u32>, default: PathBuf) -> Location {
    match stored_path.map(|p| PathBuf::from(p.trim())) {
        Some(path) if path.is_absolute() && !is_unc(&path) => Location { path, volume: stored_volume },
        _ => Location { path: default, volume: None },
    }
}

/// What the system says about a place. The rules below read these and nothing else.
pub trait Probe {
    /// Whether the path's drive is a network drive.
    fn drive_is_remote(&self, path: &Path) -> bool;
    /// The name of the file system of the path's volume.
    fn file_system(&self, path: &Path) -> Option<String>;
    fn volume_serial(&self, path: &Path) -> Option<u32>;
    /// Bytes free on the path's volume for this user.
    fn free_space(&self, path: &Path) -> Option<u64>;
    fn folder_state(&self, path: &Path) -> FolderState;
    /// The folders other providers have registered as sync roots.
    fn other_sync_roots(&self) -> Vec<PathBuf>;
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum FolderState {
    Missing,
    Empty,
    NotEmpty,
    Unreadable,
}

/// A place the folder can go to, as `validate` accepted it.
#[derive(Debug, PartialEq)]
pub struct Accepted {
    pub path: PathBuf,
    pub volume: u32,
    pub free: Option<u64>,
    /// The pick was a drive's root, so the folder goes in a folder of its own there.
    pub adjusted: bool,
}

/// Why a place was refused. The code is what the window words in the user's language.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Reject {
    NotAbsolute,
    Network,
    NotNtfs,
    Unreadable,
    SameAsCurrent,
    InsideCurrent,
    ContainsCurrent,
    OtherSyncRoot,
    NotEmpty,
}

impl Reject {
    pub fn code(self) -> &'static str {
        match self {
            Reject::NotAbsolute => "notAbsolute",
            Reject::Network => "network",
            Reject::NotNtfs => "notNtfs",
            Reject::Unreadable => "unreadable",
            Reject::SameAsCurrent => "same",
            Reject::InsideCurrent => "insideCurrent",
            Reject::ContainsCurrent => "containsCurrent",
            Reject::OtherSyncRoot => "otherSyncRoot",
            Reject::NotEmpty => "notEmpty",
        }
    }
}

/// Whether a path names a network share (`\\server\share`, also in its `\\?\UNC\` form).
pub fn is_unc(path: &Path) -> bool {
    matches!(
        path.components().next(),
        Some(Component::Prefix(p)) if matches!(p.kind(), Prefix::UNC(..) | Prefix::VerbatimUNC(..))
    )
}

/// Whether a path is a drive's root, `E:\`.
fn is_drive_root(path: &Path) -> bool {
    let mut parts = path.components();
    matches!(
        (parts.next(), parts.next(), parts.next()),
        (Some(Component::Prefix(p)), Some(Component::RootDir), None)
            if matches!(p.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_))
    )
}

/// A path as its parts, lowercased and without the `\\?\` form, so two spellings of one place
/// compare equal.
fn parts(path: &Path) -> Vec<String> {
    path.components()
        .filter_map(|c| match c {
            Component::Prefix(p) => {
                let s = p.as_os_str().to_string_lossy().to_lowercase();
                Some(s.strip_prefix(r"\\?\").unwrap_or(&s).to_string())
            }
            Component::Normal(s) => Some(s.to_string_lossy().to_lowercase()),
            Component::ParentDir => Some("..".to_string()),
            Component::RootDir | Component::CurDir => None,
        })
        .collect()
}

/// Whether two paths name one place, whatever their case or form.
pub fn same_place(a: &Path, b: &Path) -> bool {
    parts(a) == parts(b)
}

/// Whether `child` is `parent` or lies inside it.
pub fn inside(child: &Path, parent: &Path) -> bool {
    let (c, p) = (parts(child), parts(parent));
    !p.is_empty() && c.starts_with(&p)
}

/// The decision about a picked folder: where the folder would really go, or why it cannot.
pub fn validate(probe: &dyn Probe, picked: &Path, current: &Path) -> Result<Accepted, Reject> {
    if !picked.is_absolute() {
        return Err(Reject::NotAbsolute);
    }
    if is_unc(picked) {
        return Err(Reject::Network);
    }
    // A drive's root cannot be a sync root, so the folder gets one of its own there.
    let adjusted = is_drive_root(picked);
    let target = if adjusted { picked.join(crate::cloud_mount::FOLDER_NAME) } else { picked.to_path_buf() };

    if probe.drive_is_remote(&target) {
        return Err(Reject::Network);
    }
    match probe.file_system(&target) {
        Some(name) if name.eq_ignore_ascii_case("NTFS") => {}
        Some(_) => return Err(Reject::NotNtfs),
        None => return Err(Reject::Unreadable),
    }
    if same_place(&target, current) {
        return Err(Reject::SameAsCurrent);
    }
    if inside(&target, current) {
        return Err(Reject::InsideCurrent);
    }
    if inside(current, &target) {
        return Err(Reject::ContainsCurrent);
    }
    if probe.other_sync_roots().iter().any(|root| inside(&target, root) || inside(root, &target)) {
        return Err(Reject::OtherSyncRoot);
    }
    match probe.folder_state(&target) {
        FolderState::Missing | FolderState::Empty => {}
        FolderState::NotEmpty => return Err(Reject::NotEmpty),
        FolderState::Unreadable => return Err(Reject::Unreadable),
    }
    let volume = probe.volume_serial(&target).ok_or(Reject::Unreadable)?;
    Ok(Accepted { free: probe.free_space(&target), path: target, volume, adjusted })
}

/// Whether the folder's drive is there: the volume it was chosen on, not another disk that took
/// its letter. A folder with no volume stored (the default) is always there.
pub fn drive_present(probe: &dyn Probe, location: &Location) -> bool {
    match location.volume {
        None => true,
        Some(serial) => probe.volume_serial(&location.path) == Some(serial),
    }
}

/// The photos among `uids` that one of the `tails` names. A copy reads its photo's uid back cut
/// short at the front, so a tail names a photo when it is the end of its uid.
pub fn match_tails(uids: &[String], tails: &HashSet<String>) -> Vec<String> {
    let mut by_len: BTreeMap<usize, HashSet<&str>> = BTreeMap::new();
    for tail in tails {
        by_len.entry(tail.len()).or_default().insert(tail.as_str());
    }
    uids.iter()
        .filter(|uid| {
            by_len.iter().any(|(len, set)| {
                uid.len() >= *len
                    && uid.len() - len <= 16
                    && uid.get(uid.len() - len..).is_some_and(|tail| set.contains(tail))
            })
        })
        .cloned()
        .collect()
}

// ---- The system's answers ----

pub struct WinProbe;

/// The volume a path is on, as its root (`E:\`), found from the nearest part of the path that
/// exists, so a folder not made yet still names its drive.
fn volume_root(path: &Path) -> Option<windows::core::HSTRING> {
    use windows::core::HSTRING;
    use windows::Win32::Storage::FileSystem::GetVolumePathNameW;
    for candidate in path.ancestors() {
        if candidate.as_os_str().is_empty() {
            continue;
        }
        let wide = HSTRING::from(candidate.as_os_str());
        let mut buf = [0u16; 261];
        if unsafe { GetVolumePathNameW(&wide, &mut buf) }.is_ok() {
            let len = buf.iter().position(|&c| c == 0)?;
            return Some(HSTRING::from_wide(&buf[..len]));
        }
    }
    None
}

impl Probe for WinProbe {
    fn drive_is_remote(&self, path: &Path) -> bool {
        use windows::Win32::Storage::FileSystem::GetDriveTypeW;
        // GetDriveTypeW's answer for a network drive.
        const DRIVE_REMOTE: u32 = 4;
        volume_root(path).is_some_and(|root| unsafe { GetDriveTypeW(&root) } == DRIVE_REMOTE)
    }

    fn file_system(&self, path: &Path) -> Option<String> {
        use windows::Win32::Storage::FileSystem::GetVolumeInformationW;
        let root = volume_root(path)?;
        let mut name = [0u16; 64];
        unsafe { GetVolumeInformationW(&root, None, None, None, None, Some(&mut name)) }.ok()?;
        let len = name.iter().position(|&c| c == 0).unwrap_or(name.len());
        Some(String::from_utf16_lossy(&name[..len]))
    }

    fn volume_serial(&self, path: &Path) -> Option<u32> {
        use windows::Win32::Storage::FileSystem::GetVolumeInformationW;
        let root = volume_root(path)?;
        let mut serial = 0u32;
        unsafe { GetVolumeInformationW(&root, None, Some(&mut serial), None, None, None) }.ok()?;
        Some(serial)
    }

    fn free_space(&self, path: &Path) -> Option<u64> {
        use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
        let root = volume_root(path)?;
        let mut free = 0u64;
        unsafe { GetDiskFreeSpaceExW(&root, Some(&mut free), None, None) }.ok()?;
        Some(free)
    }

    fn folder_state(&self, path: &Path) -> FolderState {
        match std::fs::read_dir(path) {
            Ok(mut entries) => {
                if entries.next().is_none() {
                    FolderState::Empty
                } else {
                    FolderState::NotEmpty
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => FolderState::Missing,
            Err(_) => FolderState::Unreadable,
        }
    }

    fn other_sync_roots(&self) -> Vec<PathBuf> {
        registered_roots().into_iter().filter(|(id, _)| !id.starts_with(OWN_ID_PREFIX)).map(|(_, path)| path).collect()
    }
}

/// Every sync root registered for this user, with the id it was registered under. Needs a COM
/// apartment on the calling thread.
fn registered_roots() -> Vec<(String, PathBuf)> {
    cloud_filter::root::active_roots()
        .map(|roots| roots.into_iter().map(|info| (info.id().as_hstring().to_string(), info.path())).collect())
        .unwrap_or_default()
}

/// The folder this app has registered as its sync root, if it is registered.
pub fn own_registered_root() -> Option<PathBuf> {
    registered_roots().into_iter().find(|(id, _)| id.starts_with(OWN_ID_PREFIX)).map(|(_, path)| path)
}

/// Runs `work` on a thread of its own with a COM apartment, which is what the sync-root APIs
/// need and what a pooled thread cannot be trusted to have.
pub fn on_com_thread<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    std::thread::spawn(move || {
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        }
        work()
    })
    .join()
    .ok()
}

// ---- What is stored ----

static CURRENT: Mutex<Option<Location>> = Mutex::new(None);

fn read_stored() -> Location {
    use winreg::enums::HKEY_CURRENT_USER;
    let key = winreg::RegKey::predef(HKEY_CURRENT_USER).open_subkey(crate::cloud_mount::PREF_KEY).ok();
    let path = key.as_ref().and_then(|k| k.get_value::<String, _>(LOCATION_VALUE).ok());
    let volume = key.as_ref().and_then(|k| k.get_value::<u32, _>(VOLUME_VALUE).ok());
    resolve(path, volume, crate::cloud_mount::default_sync_root())
}

/// The place of the folder now. Read from the registry once, and again only when it is saved.
pub fn current() -> Location {
    CURRENT.lock().unwrap_or_else(|p| p.into_inner()).get_or_insert_with(read_stored).clone()
}

/// Stores a new place for the folder, with the volume it is on.
pub fn save(path: &Path, volume: u32) -> Result<(), String> {
    use winreg::enums::HKEY_CURRENT_USER;
    let (key, _) = winreg::RegKey::predef(HKEY_CURRENT_USER)
        .create_subkey(crate::cloud_mount::PREF_KEY)
        .map_err(|e| e.to_string())?;
    key.set_value(LOCATION_VALUE, &path.to_string_lossy().into_owned()).map_err(|e| e.to_string())?;
    key.set_value(VOLUME_VALUE, &volume).map_err(|e| e.to_string())?;
    *CURRENT.lock().unwrap_or_else(|p| p.into_inner()) = Some(Location { path: path.to_path_buf(), volume: Some(volume) });
    Ok(())
}

/// Whether the folder's drive is there right now.
pub fn available() -> bool {
    drive_present(&WinProbe, &current())
}

static LIFECYCLE: Mutex<()> = Mutex::new(());

/// Held while the folder is attached, detached or moved, so two of those never overlap.
pub fn lifecycle() -> MutexGuard<'static, ()> {
    LIFECYCLE.lock().unwrap_or_else(|p| p.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fake {
        remote: bool,
        fs: Option<&'static str>,
        serial: Option<u32>,
        free: Option<u64>,
        state: FolderState,
        roots: Vec<PathBuf>,
    }

    impl Fake {
        fn good() -> Fake {
            Fake {
                remote: false,
                fs: Some("NTFS"),
                serial: Some(0xABCD),
                free: Some(500),
                state: FolderState::Missing,
                roots: Vec::new(),
            }
        }
    }

    impl Probe for Fake {
        fn drive_is_remote(&self, _: &Path) -> bool {
            self.remote
        }
        fn file_system(&self, _: &Path) -> Option<String> {
            self.fs.map(str::to_string)
        }
        fn volume_serial(&self, _: &Path) -> Option<u32> {
            self.serial
        }
        fn free_space(&self, _: &Path) -> Option<u64> {
            self.free
        }
        fn folder_state(&self, _: &Path) -> FolderState {
            self.state
        }
        fn other_sync_roots(&self) -> Vec<PathBuf> {
            self.roots.clone()
        }
    }

    const CURRENT_ROOT: &str = r"C:\Users\ann\Proton Photos";

    fn check(probe: &Fake, picked: &str) -> Result<Accepted, Reject> {
        validate(probe, Path::new(picked), Path::new(CURRENT_ROOT))
    }

    #[test]
    fn a_free_ntfs_folder_is_accepted_with_its_volume_and_room() {
        let got = check(&Fake::good(), r"D:\Photos").unwrap();
        assert_eq!(
            got,
            Accepted { path: PathBuf::from(r"D:\Photos"), volume: 0xABCD, free: Some(500), adjusted: false }
        );
    }

    #[test]
    fn an_empty_folder_that_exists_is_accepted() {
        let probe = Fake { state: FolderState::Empty, ..Fake::good() };
        assert!(check(&probe, r"D:\Photos").is_ok());
    }

    #[test]
    fn a_network_place_is_refused() {
        assert_eq!(check(&Fake::good(), r"\\server\share\Photos"), Err(Reject::Network));
        assert_eq!(check(&Fake::good(), r"\\?\UNC\server\share\Photos"), Err(Reject::Network));
        let probe = Fake { remote: true, ..Fake::good() };
        assert_eq!(check(&probe, r"Z:\Photos"), Err(Reject::Network));
    }

    #[test]
    fn a_volume_that_is_not_ntfs_is_refused() {
        let probe = Fake { fs: Some("exFAT"), ..Fake::good() };
        assert_eq!(check(&probe, r"E:\Photos"), Err(Reject::NotNtfs));
        let unknown = Fake { fs: None, ..Fake::good() };
        assert_eq!(check(&unknown, r"E:\Photos"), Err(Reject::Unreadable));
        let lower = Fake { fs: Some("ntfs"), ..Fake::good() };
        assert!(check(&lower, r"E:\Photos").is_ok());
    }

    #[test]
    fn a_drive_root_gets_a_folder_of_its_own() {
        let got = check(&Fake::good(), r"E:\").unwrap();
        assert_eq!(got.path, PathBuf::from(r"E:\Proton Photos"));
        assert!(got.adjusted);
        let verbatim = check(&Fake::good(), r"\\?\E:\").unwrap();
        assert!(verbatim.adjusted);
        // The folder it makes is held to the same rules as any other.
        let exfat = Fake { fs: Some("exFAT"), ..Fake::good() };
        assert_eq!(check(&exfat, r"E:\"), Err(Reject::NotNtfs));
        let taken = Fake { state: FolderState::NotEmpty, ..Fake::good() };
        assert_eq!(check(&taken, r"E:\"), Err(Reject::NotEmpty));
    }

    #[test]
    fn a_place_inside_another_providers_sync_root_is_refused() {
        let probe = Fake { roots: vec![PathBuf::from(r"C:\Users\ann\OneDrive")], ..Fake::good() };
        assert_eq!(check(&probe, r"C:\Users\ann\OneDrive\Pictures"), Err(Reject::OtherSyncRoot));
        assert_eq!(check(&probe, r"c:\users\ANN\onedrive"), Err(Reject::OtherSyncRoot));
        // Around a sync root is as bad as inside one.
        let around = Fake { roots: vec![PathBuf::from(r"D:\Photos\Cloud")], ..Fake::good() };
        assert_eq!(check(&around, r"D:\Photos"), Err(Reject::OtherSyncRoot));
        // A name that only starts like the root's is another folder.
        assert!(check(&probe, r"C:\Users\ann\OneDrive Backup").is_ok());
    }

    #[test]
    fn a_place_nested_with_the_current_folder_is_refused_either_way() {
        let probe = Fake::good();
        assert_eq!(check(&probe, CURRENT_ROOT), Err(Reject::SameAsCurrent));
        assert_eq!(check(&probe, r"c:\USERS\ann\proton photos"), Err(Reject::SameAsCurrent));
        assert_eq!(check(&probe, r"C:\Users\ann\Proton Photos\More"), Err(Reject::InsideCurrent));
        assert_eq!(check(&probe, r"C:\Users\ann"), Err(Reject::ContainsCurrent));
        // A sibling that only shares the start of the name is not nested.
        assert!(check(&probe, r"C:\Users\ann\Proton Photos 2").is_ok());
    }

    #[test]
    fn a_folder_with_things_in_it_is_refused() {
        let probe = Fake { state: FolderState::NotEmpty, ..Fake::good() };
        assert_eq!(check(&probe, r"D:\Photos"), Err(Reject::NotEmpty));
        let locked = Fake { state: FolderState::Unreadable, ..Fake::good() };
        assert_eq!(check(&locked, r"D:\Photos"), Err(Reject::Unreadable));
    }

    #[test]
    fn a_place_whose_volume_cannot_be_read_is_refused() {
        let probe = Fake { serial: None, ..Fake::good() };
        assert_eq!(check(&probe, r"D:\Photos"), Err(Reject::Unreadable));
    }

    #[test]
    fn a_relative_pick_is_refused() {
        assert_eq!(check(&Fake::good(), r"Photos"), Err(Reject::NotAbsolute));
        assert_eq!(check(&Fake::good(), r"D:Photos"), Err(Reject::NotAbsolute));
    }

    #[test]
    fn nothing_stored_means_the_default_place() {
        let default = PathBuf::from(r"C:\Users\ann\Proton Photos");
        let got = resolve(None, None, default.clone());
        assert_eq!(got, Location { path: default.clone(), volume: None });
        // A value that cannot be a place is no choice, and takes its volume with it.
        for bad in ["", "   ", r"Photos", r"\\server\share\Photos"] {
            assert_eq!(
                resolve(Some(bad.to_string()), Some(7), default.clone()),
                Location { path: default.clone(), volume: None }
            );
        }
        // A volume with no path is nothing either.
        assert_eq!(resolve(None, Some(7), default.clone()), Location { path: default, volume: None });
    }

    #[test]
    fn a_stored_place_keeps_its_volume() {
        let default = PathBuf::from(r"C:\Users\ann\Proton Photos");
        let got = resolve(Some(r"E:\Proton Photos".to_string()), Some(0x1234), default.clone());
        assert_eq!(got, Location { path: PathBuf::from(r"E:\Proton Photos"), volume: Some(0x1234) });
        let no_volume = resolve(Some(r"E:\Proton Photos".to_string()), None, default);
        assert_eq!(no_volume.volume, None);
        assert_eq!(no_volume.path, PathBuf::from(r"E:\Proton Photos"));
    }

    #[test]
    fn the_drive_is_there_only_for_the_volume_it_was_chosen_on() {
        let here = Location { path: PathBuf::from(r"E:\Proton Photos"), volume: Some(0xABCD) };
        assert!(drive_present(&Fake::good(), &here));
        // Another disk took the letter.
        let other = Fake { serial: Some(0x9999), ..Fake::good() };
        assert!(!drive_present(&other, &here));
        // Nothing answers for the drive.
        let gone = Fake { serial: None, ..Fake::good() };
        assert!(!drive_present(&gone, &here));
        // The default place has no volume to compare, and is always there.
        let default = Location { path: PathBuf::from(r"C:\Users\ann\Proton Photos"), volume: None };
        assert!(drive_present(&gone, &default));
    }

    #[test]
    fn copies_are_matched_to_their_photos_by_the_end_of_the_uid() {
        let uids: Vec<String> = ["AAAA~one_1111", "BBBB~two_2222", "CCCC~three_3333"].map(String::from).to_vec();
        let tails: HashSet<String> = ["one_1111", "three_3333", "unknown_9"].map(String::from).into_iter().collect();
        assert_eq!(match_tails(&uids, &tails), vec!["AAAA~one_1111".to_string(), "CCCC~three_3333".to_string()]);
        assert!(match_tails(&uids, &HashSet::new()).is_empty());
        // A tail that leaves more than the header off the front names nothing.
        let far: HashSet<String> = ["1"].map(String::from).into_iter().collect();
        assert!(match_tails(&["x".repeat(40) + "1"], &far).is_empty());
    }
}
