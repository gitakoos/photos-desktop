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

//! A file pinned in place while it is in use, so that what was read or checked through
//! it is what later runs or is copied by its name.
//!
//! Compiled into both the app and the installer: the app holds the update installer it
//! has checked until it has started it, and the installer holds its own executable for
//! the whole run, as it copies itself in as the uninstaller. Windows only: both
//! declare it under `cfg(windows)`, as the share modes that make the hold are Windows'.

use std::fs::File;
use std::path::Path;

/// Opens `path` so that, for as long as the returned handle lives, nothing can write to
/// the file, rename it or delete it, and its name keeps pointing at the same bytes.
/// Reading stays shared: reads through this handle, other readers, and the loader's own
/// open for read and execute when the file is started.
///
/// Refused when something already has the file open for writing or deleting, since that
/// handle would keep its access, and when the name is a link: the link could be pointed
/// at another file while the one it led to stays held. A file whose bytes are its own but
/// carry a reparse point (a cloud file such as OneDrive's, a compressed or deduplicated
/// one) is no link and is held like a plain file.
pub fn hold(path: &Path) -> Result<File, String> {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|_| "the file is missing or in use".to_string())?;
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("the file is not a plain file".to_string());
    }
    if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 && !reparse_tag(&file).is_some_and(holds_own_data) {
        return Err("the file is not a plain file".to_string());
    }
    Ok(file)
}

/// Whether a reparse point leaves the file's data where the file is: a cloud file, a file
/// compressed by Windows, a deduplicated file. Every other tag, links and mount points
/// among them, can lead somewhere else.
fn holds_own_data(tag: u32) -> bool {
    const IO_REPARSE_TAG_CLOUD_MASK: u32 = 0x0000_F000;
    const IO_REPARSE_TAG_CLOUD: u32 = 0x9000_001A;
    const IO_REPARSE_TAG_WOF: u32 = 0x8000_0017;
    const IO_REPARSE_TAG_DEDUP: u32 = 0x8000_0013;
    tag & !IO_REPARSE_TAG_CLOUD_MASK == IO_REPARSE_TAG_CLOUD || tag == IO_REPARSE_TAG_WOF || tag == IO_REPARSE_TAG_DEDUP
}

/// The reparse tag of an open file, or None when it has none or it cannot be read.
fn reparse_tag(file: &File) -> Option<u32> {
    use std::os::windows::io::AsRawHandle;
    #[repr(C)]
    #[derive(Default)]
    struct FileAttributeTagInfo {
        file_attributes: u32,
        reparse_tag: u32,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetFileInformationByHandleEx(file: *mut core::ffi::c_void, class: i32, info: *mut core::ffi::c_void, size: u32) -> i32;
    }
    const FILE_ATTRIBUTE_TAG_INFO_CLASS: i32 = 9;
    let mut info = FileAttributeTagInfo::default();
    let ok = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FILE_ATTRIBUTE_TAG_INFO_CLASS,
            &mut info as *mut FileAttributeTagInfo as *mut core::ffi::c_void,
            std::mem::size_of::<FileAttributeTagInfo>() as u32,
        )
    };
    (ok != 0 && info.reparse_tag != 0).then_some(info.reparse_tag)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// A folder of its own, removed when dropped.
    struct Scratch(PathBuf);

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn scratch() -> Scratch {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "pfp-hold-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Scratch(dir)
    }

    #[test]
    fn a_held_file_cannot_be_changed_moved_or_deleted() {
        let s = scratch();
        let path = s.0.join("held.bin");
        std::fs::write(&path, b"held").unwrap();
        let held = hold(&path).unwrap();
        assert!(std::fs::OpenOptions::new().write(true).open(&path).is_err());
        assert!(std::fs::rename(&path, s.0.join("moved.bin")).is_err());
        assert!(std::fs::remove_file(&path).is_err());
        // Reading is still shared.
        assert_eq!(std::fs::read(&path).unwrap(), b"held");
        drop(held);
        assert!(std::fs::remove_file(&path).is_ok());
    }

    #[test]
    fn a_file_open_for_writing_is_not_held() {
        let s = scratch();
        let path = s.0.join("held.bin");
        std::fs::write(&path, b"held").unwrap();
        let writer = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        assert!(hold(&path).is_err());
        drop(writer);
        assert!(hold(&path).is_ok());
    }

    #[test]
    fn a_link_is_not_held() {
        let s = scratch();
        let path = s.0.join("held.bin");
        std::fs::write(&path, b"held").unwrap();
        let link = s.0.join("link.bin");
        // Making a link needs Developer Mode or elevation; without either there is nothing to test.
        if std::os::windows::fs::symlink_file(&path, &link).is_err() {
            return;
        }
        assert!(hold(&link).is_err());
    }

    #[test]
    fn a_cloud_compressed_or_deduplicated_file_keeps_its_data_and_a_link_does_not() {
        // OneDrive, Proton Photos and other Cloud Files placeholders, with any of the 16 cloud flags.
        assert!(holds_own_data(0x9000_001A));
        assert!(holds_own_data(0x9000_301A));
        assert!(holds_own_data(0x9000_F01A));
        assert!(holds_own_data(0x8000_0017));
        assert!(holds_own_data(0x8000_0013));
        // Symbolic link, mount point, app execution alias.
        assert!(!holds_own_data(0xA000_000C));
        assert!(!holds_own_data(0xA000_0003));
        assert!(!holds_own_data(0x8000_001B));
        assert!(!holds_own_data(0));
    }

    /// A real Cloud Files placeholder that holds its data, named by `PFP_HOLD_CLOUD_FILE`:
    /// held, and read whole through the hold. Run by hand on a downloaded cloud file. Whether
    /// the reparse point shows depends on the process's placeholder mode, so it is only printed.
    #[test]
    #[ignore]
    fn a_downloaded_cloud_file_is_held_and_read_whole() {
        use std::io::Read;
        let path = PathBuf::from(std::env::var_os("PFP_HOLD_CLOUD_FILE").expect("PFP_HOLD_CLOUD_FILE"));
        let tag = {
            use std::os::windows::fs::OpenOptionsExt;
            let f = std::fs::OpenOptions::new().read(true).custom_flags(0x0020_0000).open(&path).unwrap();
            reparse_tag(&f)
        };
        println!("reparse tag {tag:#x?}");
        let mut held = hold(&path).unwrap();
        let mut bytes = Vec::new();
        held.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes.len() as u64, std::fs::metadata(&path).unwrap().len());
        println!("held and read {} bytes", bytes.len());
    }

    /// The loader's own open asks for read and execute, which the hold shares, so a held
    /// program still starts.
    #[test]
    fn a_held_program_still_launches() {
        let s = scratch();
        let path = s.0.join("held.exe");
        let system = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap();
        std::fs::copy(system.join("System32").join("cmd.exe"), &path).unwrap();
        let held = hold(&path).unwrap();
        let status = std::process::Command::new(&path).args(["/c", "exit", "7"]).status().unwrap();
        assert_eq!(status.code(), Some(7));
        drop(held);
    }

    /// The installer holds the executable it is running from, which is mapped as this
    /// very process's image.
    #[test]
    fn a_running_program_can_hold_its_own_file() {
        let exe = std::env::current_exe().unwrap();
        assert!(hold(&exe).is_ok());
    }
}
