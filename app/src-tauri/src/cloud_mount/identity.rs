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

//! Which photo a placeholder stands for, and whether a copy on this PC is the cloud file.
//!
//! A placeholder carries its photo's uid as its identity, and that identity is what the file
//! opens: a download asks for exactly that uid. So the folder's index may name a path for a photo
//! only when the file there carries that photo's uid, and it is read here in full, through a
//! handle that never downloads anything.
//!
//! A copy is the cloud file only when that can be shown. The driver's in-sync state is the proof
//! this module keeps true: Windows clears it whenever anything but the provider writes to the
//! file, and it is only ever set here after the bytes were compared with what the cloud holds.
//! Freeing a copy throws its bytes away, so everything that frees goes through that proof.

use std::hash::Hasher;
use std::io::Read;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use std::path::Path;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::Storage::CloudFilters::{
    CfConvertToPlaceholder, CfDehydratePlaceholder, CfGetPlaceholderInfo, CfSetInSyncState, CfUpdatePlaceholder,
    CF_CONVERT_FLAG_DEHYDRATE, CF_CONVERT_FLAG_MARK_IN_SYNC, CF_DEHYDRATE_FLAG_NONE, CF_FS_METADATA,
    CF_IN_SYNC_STATE_IN_SYNC, CF_PLACEHOLDER_INFO_STANDARD, CF_PLACEHOLDER_STANDARD_INFO, CF_SET_IN_SYNC_FLAG_NONE,
    CF_UPDATE_FLAG_MARK_IN_SYNC,
};
use windows::Win32::Storage::FileSystem::FILE_BASIC_INFO;

const OPEN_NO_RECALL: u32 = 0x0010_0000;
const OPEN_REPARSE_POINT: u32 = 0x0020_0000;
const BACKUP_SEMANTICS: u32 = 0x0200_0000;
const READ_ATTRIBUTES: u32 = 0x80;
const WRITE_DAC: u32 = 0x0004_0000;
const SHARE_ALL: u32 = 0x7;
const SHARE_READ: u32 = 0x1;

/// What a placeholder records about itself.
#[derive(Debug)]
pub(super) struct Info {
    /// The identity it was made with: the photo's uid, whole.
    pub identity: Vec<u8>,
    pub in_sync: bool,
    /// Bytes of the file held on this PC; none for a cloud-only one.
    pub on_disk: i64,
}

impl Info {
    pub fn is(&self, uid: &str) -> bool {
        is_identity(&self.identity, uid)
    }
}

/// Whether an identity read off a placeholder is this uid, exactly.
pub(super) fn is_identity(identity: &[u8], uid: &str) -> bool {
    !uid.is_empty() && identity == uid.as_bytes()
}

/// A placeholder's record, through a handle that asks for attributes only and carries no-recall,
/// so a cloud-only file is not downloaded by being looked at. None for a file that is no
/// placeholder or cannot be read.
pub(super) fn read(path: &Path) -> Option<Info> {
    let file = std::fs::OpenOptions::new()
        .access_mode(READ_ATTRIBUTES)
        .share_mode(SHARE_ALL)
        .custom_flags(OPEN_REPARSE_POINT | BACKUP_SEMANTICS | OPEN_NO_RECALL)
        .open(path)
        .ok()?;
    info_of(&file)
}

/// The record behind an open handle.
fn info_of(file: &std::fs::File) -> Option<Info> {
    let header = std::mem::offset_of!(CF_PLACEHOLDER_STANDARD_INFO, FileIdentity);
    let mut buf = vec![0u8; std::mem::size_of::<CF_PLACEHOLDER_STANDARD_INFO>() + 4096];
    let mut returned = 0u32;
    unsafe {
        CfGetPlaceholderInfo(
            HANDLE(file.as_raw_handle()),
            CF_PLACEHOLDER_INFO_STANDARD,
            buf.as_mut_ptr() as _,
            buf.len() as u32,
            Some(&mut returned),
        )
    }
    .ok()?;
    let info = unsafe { std::ptr::read_unaligned(buf.as_ptr() as *const CF_PLACEHOLDER_STANDARD_INFO) };
    let end = header.checked_add(info.FileIdentityLength as usize)?;
    if end > buf.len() || (returned != 0 && end > returned as usize) {
        return None;
    }
    Some(Info {
        identity: buf[header..end].to_vec(),
        in_sync: info.InSyncState == CF_IN_SYNC_STATE_IN_SYNC,
        on_disk: info.OnDiskDataSize,
    })
}

/// The placeholders a download is filling right now, by path, lowercased. A download and a
/// change of identity never overlap on one file: the download runs only through this app's
/// provider, which notes the file here before it writes a byte, and a change of identity is
/// made only while the file is not noted.
fn filling() -> &'static std::sync::Mutex<std::collections::HashSet<String>> {
    static FILLING: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
        std::sync::OnceLock::new();
    FILLING.get_or_init(Default::default)
}

fn fill_key(path: &Path) -> String {
    path.to_string_lossy().to_lowercase()
}

/// A download into one placeholder, from its first byte to its last.
pub(super) struct Filling(String);

impl Filling {
    pub fn begin(path: &Path) -> Filling {
        let key = fill_key(path);
        filling().lock().unwrap_or_else(|p| p.into_inner()).insert(key.clone());
        Filling(key)
    }
}

impl Drop for Filling {
    fn drop(&mut self) {
        filling().lock().unwrap_or_else(|p| p.into_inner()).remove(&self.0);
    }
}

/// Gives a cloud-only placeholder another photo's identity, size and times, marked in sync, so
/// the file opens the photo the folder now names at its path. Refused for a file holding any
/// data, those bytes being the other photo's, and for one a download is filling. The handle
/// asks for no data access: any data open of a cloud-only placeholder counts as reading it.
pub(super) fn retarget_cloud_only(path: &Path, uid: &str, size: u64, filetime: i64) -> Result<(), String> {
    let filling = filling().lock().unwrap_or_else(|p| p.into_inner());
    if filling.contains(&fill_key(path)) {
        return Err("it is being downloaded".into());
    }
    let file = std::fs::OpenOptions::new()
        .access_mode(READ_ATTRIBUTES | WRITE_DAC)
        .share_mode(SHARE_ALL)
        .custom_flags(OPEN_NO_RECALL)
        .open(path)
        .map_err(|e| format!("open: {:?}", e.kind()))?;
    let info = info_of(&file).ok_or("not a placeholder")?;
    if info.on_disk != 0 {
        return Err("it holds data".into());
    }
    let metadata = CF_FS_METADATA {
        BasicInfo: FILE_BASIC_INFO {
            CreationTime: filetime,
            LastAccessTime: 0,
            LastWriteTime: filetime,
            ChangeTime: filetime,
            FileAttributes: 0,
        },
        FileSize: size as i64,
    };
    let blob = uid.as_bytes();
    let updated = unsafe {
        CfUpdatePlaceholder(
            HANDLE(file.as_raw_handle()),
            Some(&metadata),
            Some(blob.as_ptr() as *const core::ffi::c_void),
            blob.len() as u32,
            None,
            CF_UPDATE_FLAG_MARK_IN_SYNC,
            None,
            None,
        )
    };
    drop(filling);
    updated.map_err(|e| format!("{e:?}"))
}

/// The length and digest of bytes as they pass, for telling later whether a file still holds
/// exactly them. Only ever compared within this run of the app.
#[derive(Default)]
pub(super) struct Digest {
    hasher: std::collections::hash_map::DefaultHasher,
    len: u64,
}

impl Digest {
    pub fn add(&mut self, bytes: &[u8]) {
        self.hasher.write(bytes);
        self.len += bytes.len() as u64;
    }

    pub fn finish(&self) -> (u64, u64) {
        (self.len, self.hasher.finish())
    }
}

fn digest_of(mut reader: impl Read) -> std::io::Result<(u64, u64)> {
    let mut digest = Digest::default();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            return Ok(digest.finish());
        }
        digest.add(&buf[..n]);
    }
}

/// Marks a copy that was just downloaded in sync, once it still holds exactly the bytes the
/// download wrote (`written`, from `Digest`). One already in sync is left as it is: the driver
/// keeps the download's own writes in sync and clears the state on any other. True when it is
/// in sync afterwards. Writers are kept out while it is checked, so nothing changes in between.
pub(super) fn mark_in_sync_if_same(path: &Path, written: (u64, u64)) -> Result<bool, String> {
    if read(path).ok_or("not a placeholder")?.in_sync {
        return Ok(true);
    }
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(SHARE_READ)
        .custom_flags(OPEN_NO_RECALL)
        .open(path)
        .map_err(|e| format!("open: {:?}", e.kind()))?;
    if digest_of(&file).map_err(|e| format!("read: {:?}", e.kind()))? != written {
        return Ok(false);
    }
    unsafe { CfSetInSyncState(HANDLE(file.as_raw_handle()), CF_IN_SYNC_STATE_IN_SYNC, CF_SET_IN_SYNC_FLAG_NONE, None) }
        .map_err(|e| format!("{e:?}"))?;
    Ok(true)
}

/// Whether two readers hold the same bytes, to the end of both.
pub(super) fn same_bytes(mut a: impl Read, mut b: impl Read) -> std::io::Result<bool> {
    const CHUNK: usize = 1 << 20;
    let (mut x, mut y) = (vec![0u8; CHUNK], vec![0u8; CHUNK]);
    loop {
        let n = fill(&mut a, &mut x)?;
        let m = fill(&mut b, &mut y)?;
        if n != m || x[..n] != y[..m] {
            return Ok(false);
        }
        if n == 0 {
            return Ok(true);
        }
    }
}

/// Reads until the buffer is full or the reader ends.
fn fill(reader: &mut impl Read, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut got = 0;
    while got < buf.len() {
        match reader.read(&mut buf[got..]) {
            Ok(0) => break,
            Ok(n) => got += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(got)
}

/// What became of a copy offered to be freed against the cloud file's bytes.
#[derive(Debug, PartialEq)]
pub(super) enum Freed {
    Freed,
    /// It holds other bytes than the cloud file: changed here, or not this photo's copy.
    Differs,
    NotFreed,
}

/// Frees a copy that holds byte for byte what the cloud file holds (`cloud`, downloaded for the
/// check). See `free_if`.
pub(super) fn free_if_same(path: &Path, uid: &str, cloud: &Path) -> Freed {
    let Ok(cloud) = std::fs::File::open(cloud) else {
        return Freed::NotFreed;
    };
    free_if(path, uid, |file| same_bytes(file, cloud))
}

/// Frees a copy whose SHA-1 is the one the cloud revision records (`cloud_sha1`, hex). See
/// `free_if`.
pub(super) fn free_if_digest(path: &Path, uid: &str, cloud_sha1: &str) -> Freed {
    free_if(path, uid, |file| Ok(matches_digest(&sha1_of(file)?, cloud_sha1)))
}

/// Frees a copy of this photo that `same` finds to be the cloud file: a placeholder is marked
/// in sync and dehydrated, an ordinary file becomes a cloud-only placeholder carrying `uid`.
/// Anything else keeps its bytes. The handle is exclusive from the check to the free, so
/// nothing can write to the file in between.
fn free_if(path: &Path, uid: &str, same: impl FnOnce(&std::fs::File) -> std::io::Result<bool>) -> Freed {
    let Ok(file) = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(0)
        .custom_flags(OPEN_NO_RECALL)
        .open(path)
    else {
        return Freed::NotFreed;
    };
    let placeholder = info_of(&file);
    if placeholder.as_ref().is_some_and(|info| !info.is(uid)) {
        return Freed::Differs;
    }
    match same(&file) {
        Ok(true) => {}
        Ok(false) => return Freed::Differs,
        Err(_) => return Freed::NotFreed,
    }
    let handle = HANDLE(file.as_raw_handle());
    let freed = if placeholder.is_some() {
        unsafe { CfSetInSyncState(handle, CF_IN_SYNC_STATE_IN_SYNC, CF_SET_IN_SYNC_FLAG_NONE, None) }.is_ok()
            && unsafe { CfDehydratePlaceholder(handle, 0, -1, CF_DEHYDRATE_FLAG_NONE, None) }.is_ok()
    } else {
        let blob = uid.as_bytes();
        unsafe {
            CfConvertToPlaceholder(
                handle,
                Some(blob.as_ptr() as *const core::ffi::c_void),
                blob.len() as u32,
                CF_CONVERT_FLAG_MARK_IN_SYNC | CF_CONVERT_FLAG_DEHYDRATE,
                None,
                None,
            )
        }
        .is_ok()
    };
    if freed {
        Freed::Freed
    } else {
        Freed::NotFreed
    }
}

/// The SHA-1 of what a reader holds, to its end, by the system's own implementation.
pub(super) fn sha1_of(mut reader: impl Read) -> std::io::Result<[u8; 20]> {
    use windows::Win32::Security::Cryptography::{
        BCryptCreateHash, BCryptDestroyHash, BCryptFinishHash, BCryptHashData, BCRYPT_HASH_HANDLE,
        BCRYPT_SHA1_ALG_HANDLE,
    };
    let failed = |what: &str| std::io::Error::other(format!("sha1 {what}"));
    let mut hash = BCRYPT_HASH_HANDLE::default();
    if unsafe { BCryptCreateHash(BCRYPT_SHA1_ALG_HANDLE, &mut hash, None, None, 0) }.is_err() {
        return Err(failed("create"));
    }
    struct Hash(BCRYPT_HASH_HANDLE);
    impl Drop for Hash {
        fn drop(&mut self) {
            let _ = unsafe { BCryptDestroyHash(self.0) };
        }
    }
    let hash = Hash(hash);
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        if unsafe { BCryptHashData(hash.0, &buf[..n], 0) }.is_err() {
            return Err(failed("data"));
        }
    }
    let mut out = [0u8; 20];
    if unsafe { BCryptFinishHash(hash.0, &mut out, 0) }.is_err() {
        return Err(failed("finish"));
    }
    Ok(out)
}

/// Whether a SHA-1 is the one a revision records as hex. Anything that is not a whole digest
/// matches nothing.
pub(super) fn matches_digest(local: &[u8; 20], cloud_hex: &str) -> bool {
    let hex: String = local.iter().map(|b| format!("{b:02x}")).collect();
    cloud_hex.len() == 40 && cloud_hex.eq_ignore_ascii_case(&hex)
}

/// What checking an out-of-sync copy against its revision's digest came to.
#[derive(Debug, PartialEq)]
pub(super) enum Checked {
    /// Its SHA-1 is the revision's: it is marked in sync (or was already).
    InSync,
    /// Its SHA-1 is not the revision's: changed here, and it stays out of sync.
    Differs,
    /// Not looked at now: not this photo's placeholder, not all here, in use or being downloaded.
    NotChecked,
}

/// Marks a copy of this photo that holds all its data but is out of sync in sync, once its
/// SHA-1 is the one the cloud revision records (`cloud_sha1`, hex). Writers are kept out while
/// it is hashed and marked, so nothing changes in between.
pub(super) fn mark_in_sync_if_digest(path: &Path, uid: &str, cloud_sha1: &str) -> Checked {
    if filling().lock().unwrap_or_else(|p| p.into_inner()).contains(&fill_key(path)) {
        return Checked::NotChecked;
    }
    let Ok(file) = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(SHARE_READ)
        .custom_flags(OPEN_NO_RECALL)
        .open(path)
    else {
        return Checked::NotChecked;
    };
    let Some(info) = info_of(&file) else { return Checked::NotChecked };
    if !info.is(uid) {
        return Checked::NotChecked;
    }
    if info.in_sync {
        return Checked::InSync;
    }
    let whole = file.metadata().is_ok_and(|m| m.len() as i64 == info.on_disk);
    if !whole {
        return Checked::NotChecked;
    }
    match sha1_of(&file) {
        Ok(local) if matches_digest(&local, cloud_sha1) => {}
        Ok(_) => return Checked::Differs,
        Err(_) => return Checked::NotChecked,
    }
    let marked =
        unsafe { CfSetInSyncState(HANDLE(file.as_raw_handle()), CF_IN_SYNC_STATE_IN_SYNC, CF_SET_IN_SYNC_FLAG_NONE, None) };
    if marked.is_ok() {
        Checked::InSync
    } else {
        Checked::NotChecked
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_whole_uid_is_the_identity() {
        assert!(is_identity(b"vol~link", "vol~link"));
        assert!(!is_identity(b"l~link", "vol~link"));
        assert!(!is_identity(b"vol~link2", "vol~link"));
        assert!(!is_identity(b"", ""));
    }

    #[test]
    fn a_file_being_downloaded_keeps_its_identity() {
        let path = std::env::temp_dir().join(format!("pfp-filling-{}.jpg", std::process::id()));
        {
            let _filling = Filling::begin(&path);
            assert_eq!(retarget_cloud_only(&path, "v~a", 1, 0), Err("it is being downloaded".to_string()));
        }
        // Once the download is over the file is looked at; this one does not exist.
        assert!(retarget_cloud_only(&path, "v~a", 1, 0).unwrap_err().starts_with("open"));
    }

    #[test]
    fn the_sha1_is_the_systems_and_matches_only_a_whole_digest() {
        let abc = sha1_of(&b"abc"[..]).unwrap();
        assert!(matches_digest(&abc, "a9993e364706816aba3e25717850c26c9cd0d89d"));
        assert!(matches_digest(&abc, "A9993E364706816ABA3E25717850C26C9CD0D89D"));
        assert!(!matches_digest(&abc, "a9993e364706816aba3e25717850c26c9cd0d89e"));
        assert!(!matches_digest(&abc, "a9993e36"));
        assert!(!matches_digest(&abc, ""));
        let empty = sha1_of(&b""[..]).unwrap();
        assert!(matches_digest(&empty, "da39a3ee5e6b4b0d3255bfef95601890afd80709"));
        // Read in pieces larger than one buffer, the digest is the same.
        let long = vec![b'a'; 1_000_000];
        assert!(matches_digest(&sha1_of(&long[..]).unwrap(), "34aa973cd4c4daa4f61eeb2bdbad27316534016f"));
    }

    #[test]
    fn bytes_compare_to_the_end_of_both() {
        let long = vec![7u8; (1 << 20) + 5];
        let mut changed = long.clone();
        *changed.last_mut().unwrap() = 8;
        assert!(same_bytes(&long[..], &long[..]).unwrap());
        assert!(!same_bytes(&long[..], &changed[..]).unwrap());
        assert!(!same_bytes(&long[..], &long[..long.len() - 1]).unwrap());
        assert!(same_bytes(&b""[..], &b""[..]).unwrap());
    }

    #[test]
    fn the_digest_does_not_depend_on_how_the_bytes_were_cut() {
        let bytes: Vec<u8> = (0..300_000u32).map(|i| (i * 31 % 251) as u8).collect();
        let mut whole = Digest::default();
        whole.add(&bytes);
        let mut pieces = Digest::default();
        for chunk in bytes.chunks(4093) {
            pieces.add(chunk);
        }
        assert_eq!(whole.finish(), pieces.finish());
        assert_eq!(digest_of(&bytes[..]).unwrap(), whole.finish());
        let mut other = bytes.clone();
        other[1234] ^= 1;
        assert_ne!(digest_of(&other[..]).unwrap(), whole.finish());
    }
}
