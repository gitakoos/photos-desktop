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

//! The upload's file and folder picker on Windows, which also reaches a camera or a phone.
//!
//! Plugged in over USB, most cameras and phones show up as a portable device (MTP/PTP):
//! listed under This PC, but with no drive letter, so what is picked there has no path.
//! The dialog plugin reads only a path off the chosen item and reported such a pick as
//! nothing picked at all, so the upload silently did nothing. Here an item that has a
//! path is passed on as it is, and one that has none is copied through the shell into a
//! staging folder first (a picked folder keeps its name, so it still becomes the album),
//! and the copies are what the upload takes.

// The camera and phone picker is Windows'; elsewhere only its stub is called.
#![cfg_attr(not(windows), allow(dead_code, unused_imports))]

use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

/// The staging folder for copies taken off a device, under the temp folder.
const STAGING: &str = "pfp-device";

/// Copies older than this are taken away when a new copy starts: their upload has long
/// finished, or failed with the files kept for a retry that never came.
const STALE_AFTER: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

/// The extensions the upload takes (the sidecar's `IMAGE_TYPES` and `VIDEO_TYPES`), so a
/// camera's sidecar files (.THM, .XML, .LRV) are not copied off the device for nothing.
const MEDIA: &[&str] = &[
    "jpg", "jpeg", "png", "webp", "gif", "avif", "tif", "tiff", "heic", "heif", "dng", "mp4", "mov", "m4v",
    "webm", "mkv", "3gp",
];

#[derive(Clone, Serialize)]
struct CopyProgress {
    copied: usize,
    total: usize,
}

fn staging_root() -> PathBuf {
    std::env::temp_dir().join(STAGING)
}

/// Removes every copy taken off a device. Run at startup, when no upload can be using one.
pub fn clear_staging() {
    let _ = std::fs::remove_dir_all(staging_root());
}

fn clear_stale() {
    let Ok(entries) = std::fs::read_dir(staging_root()) else { return };
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > STALE_AFTER);
        if old {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

fn is_media(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| MEDIA.contains(&e.to_ascii_lowercase().as_str()))
}

/// A device's name for a file or folder, made safe as one path component here.
fn safe_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_control() || r#"<>:"/\|?*"#.contains(c) { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches('.').to_string();
    if trimmed.is_empty() { "_".into() } else { trimmed }
}

/// `name`, or `name (2)`, `name (3)`, ... when `dir` already holds that name.
fn free_name(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    (2..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .unwrap_or(first)
}

/// Opens the picker over `window` and answers the paths to upload: as picked, or the
/// staged copies of what was picked on a device. Empty when the picker was cancelled.
#[cfg(windows)]
#[tauri::command]
pub async fn pick_for_upload(
    app: AppHandle,
    window: tauri::WebviewWindow,
    directory: bool,
    filter_name: String,
) -> Result<Vec<String>, String> {
    let owner = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
    let (tx, rx) = std::sync::mpsc::channel();
    // The dialog and the shell items behind it are apartment-threaded COM objects, so they
    // live on a thread of their own that joins an STA, never on a pooled worker.
    std::thread::spawn(move || {
        let _ = tx.send(win::pick(&app, owner, directory, &filter_name));
    });
    tauri::async_runtime::spawn_blocking(move || rx.recv().unwrap_or_else(|_| Err("the picker stopped".into())))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(not(windows))]
#[tauri::command]
pub async fn pick_for_upload(
    _app: AppHandle,
    _directory: bool,
    _filter_name: String,
) -> Result<Vec<String>, String> {
    Err("not available here".into())
}

#[cfg(windows)]
mod win {
    use super::*;
    use std::io::Write;
    use windows::core::{Interface, HSTRING, PCWSTR, PWSTR};
    use windows::Win32::Foundation::{ERROR_CANCELLED, HWND, PROPERTYKEY};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, IStream, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::Common::COMDLG_FILTERSPEC;
    use windows::Win32::System::SystemServices::SFGAO_FOLDER;
    use windows::Win32::UI::Shell::{
        BHID_EnumItems, BHID_Stream, FileOpenDialog, IEnumShellItems, IFileOpenDialog, IShellItem, IShellItem2,
        FOS_ALLOWMULTISELECT, FOS_FORCEFILESYSTEM, FOS_PICKFOLDERS, SIGDN_FILESYSPATH,
        SIGDN_NORMALDISPLAY,
    };

    /// `System.FileName`: a device's real file name with its extension, which the display
    /// name can leave off.
    const PKEY_FILE_NAME: PROPERTYKEY = PROPERTYKEY {
        fmtid: windows::core::GUID::from_u128(0x41cf5ae0_f75a_4806_bd87_59c7d9248eb9),
        pid: 100,
    };
    /// `System.DateModified`, put on the copy so an undated file keeps the device's date.
    const PKEY_DATE_MODIFIED: PROPERTYKEY = PROPERTYKEY {
        fmtid: windows::core::GUID::from_u128(0xb725f130_47ef_101a_a5f1_02608c9eebac),
        pid: 14,
    };

    pub(super) struct Picked {
        pub(super) path: Option<String>,
        pub(super) item: IShellItem,
    }

    pub(super) fn pick(app: &AppHandle, owner: isize, directory: bool, filter_name: &str) -> Result<Vec<String>, String> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let dialog: IFileOpenDialog =
                CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER).map_err(|e| e.to_string())?;
            // Whatever Windows starts the dialog with stays, except that a device's items
            // must be pickable even though they are not on a file system.
            let mut options = dialog.GetOptions().map_err(|e| e.to_string())?;
            options &= !FOS_FORCEFILESYSTEM;
            options |= if directory { FOS_PICKFOLDERS } else { FOS_ALLOWMULTISELECT };
            dialog.SetOptions(options).map_err(|e| e.to_string())?;
            let name = HSTRING::from(filter_name);
            let spec = HSTRING::from(MEDIA.iter().map(|e| format!("*.{e}")).collect::<Vec<_>>().join(";"));
            if !directory {
                let filters = [COMDLG_FILTERSPEC { pszName: PCWSTR(name.as_ptr()), pszSpec: PCWSTR(spec.as_ptr()) }];
                dialog.SetFileTypes(&filters).map_err(|e| e.to_string())?;
            }
            if let Err(e) = dialog.Show(Some(HWND(owner as *mut _))) {
                if e.code() == ERROR_CANCELLED.to_hresult() {
                    return Ok(Vec::new());
                }
                return Err(e.to_string());
            }
            let results = dialog.GetResults().map_err(|e| e.to_string())?;
            let count = results.GetCount().map_err(|e| e.to_string())?;
            let mut picked = Vec::new();
            for i in 0..count {
                let item = results.GetItemAt(i).map_err(|e| e.to_string())?;
                picked.push(Picked { path: display(&item, SIGDN_FILESYSPATH), item });
            }
            if picked.iter().all(|p| p.path.is_some()) {
                return Ok(picked.into_iter().filter_map(|p| p.path).collect());
            }
            copy_off_device(picked, |copied, total| {
                let _ = app.emit("device-copy", CopyProgress { copied, total });
            })
        }
    }

    pub(super) unsafe fn display(item: &IShellItem, kind: windows::Win32::UI::Shell::SIGDN) -> Option<String> {
        let raw: PWSTR = item.GetDisplayName(kind).ok()?;
        let text = raw.to_string().ok();
        CoTaskMemFree(Some(raw.0 as *const _));
        text
    }

    unsafe fn file_name(item: &IShellItem) -> String {
        let real = item.cast::<IShellItem2>().ok().and_then(|i2| {
            let raw = i2.GetString(&PKEY_FILE_NAME).ok()?;
            let text = raw.to_string().ok();
            CoTaskMemFree(Some(raw.0 as *const _));
            text
        });
        real.or_else(|| display(item, SIGDN_NORMALDISPLAY)).unwrap_or_default()
    }

    unsafe fn is_folder(item: &IShellItem) -> bool {
        item.GetAttributes(SFGAO_FOLDER).is_ok_and(|a| a.0 & SFGAO_FOLDER.0 != 0)
    }

    pub(super) unsafe fn children(folder: &IShellItem) -> Vec<IShellItem> {
        let mut out = Vec::new();
        let Ok(list) = folder.BindToHandler::<_, IEnumShellItems>(None, &BHID_EnumItems) else { return out };
        loop {
            let mut one = [None];
            let mut fetched = 0u32;
            if list.Next(&mut one, Some(&mut fetched)).is_err() || fetched == 0 {
                break;
            }
            if let Some(item) = one[0].take() {
                out.push(item);
            }
        }
        out
    }

    /// One file to bring over: the device's item and where its copy goes.
    struct Job {
        item: IShellItem,
        to: PathBuf,
    }

    /// Lists a device folder's photos and videos, its sub-folders included, as copies under
    /// `into`, making the folders on the way.
    unsafe fn plan_folder(folder: &IShellItem, into: &Path, jobs: &mut Vec<Job>) -> Result<(), String> {
        std::fs::create_dir_all(into).map_err(|e| e.to_string())?;
        for child in children(folder) {
            let name = safe_name(&file_name(&child));
            if is_folder(&child) {
                plan_folder(&child, &into.join(&name), jobs)?;
            } else if is_media(&name) {
                let to = free_name(into, &name);
                // Held now, so a second file of the same name in this folder gets its own.
                std::fs::File::create(&to).map_err(|e| e.to_string())?;
                jobs.push(Job { item: child, to });
            }
        }
        Ok(())
    }

    unsafe fn copy_one(job: &Job) -> Result<(), String> {
        let stream: IStream = job.item.BindToHandler(None, &BHID_Stream).map_err(|e| e.to_string())?;
        let mut file = std::fs::File::create(&job.to).map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; 1 << 20];
        loop {
            let mut read = 0u32;
            stream.Read(buf.as_mut_ptr() as *mut _, buf.len() as u32, Some(&mut read)).ok().map_err(|e| e.to_string())?;
            if read == 0 {
                break;
            }
            file.write_all(&buf[..read as usize]).map_err(|e| e.to_string())?;
        }
        if let Ok(i2) = job.item.cast::<IShellItem2>() {
            if let Ok(ft) = i2.GetFileTime(&PKEY_DATE_MODIFIED) {
                let ticks = ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64;
                // FILETIME counts 100 ns steps from 1601; the Unix epoch is 11644473600 s later.
                if let Some(secs) = (ticks / 10_000_000).checked_sub(11_644_473_600) {
                    let when = std::time::UNIX_EPOCH + std::time::Duration::from_secs(secs);
                    let _ = file.set_modified(when);
                }
            }
        }
        Ok(())
    }

    pub(super) unsafe fn copy_off_device(
        picked: Vec<Picked>,
        progress: impl Fn(usize, usize),
    ) -> Result<Vec<String>, String> {
        clear_stale();
        let millis = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or_default();
        let batch = staging_root().join(millis.to_string());
        let loose_dir = batch.join("files");
        let mut out = Vec::new();
        let mut jobs = Vec::new();
        for p in &picked {
            if let Some(path) = &p.path {
                out.push(path.clone());
            } else if is_folder(&p.item) {
                let dir = free_name(&batch, &safe_name(&file_name(&p.item)));
                plan_folder(&p.item, &dir, &mut jobs)?;
                out.push(dir.to_string_lossy().into_owned());
            } else {
                let name = safe_name(&file_name(&p.item));
                if is_media(&name) {
                    std::fs::create_dir_all(&loose_dir).map_err(|e| e.to_string())?;
                    let to = free_name(&loose_dir, &name);
                    std::fs::File::create(&to).map_err(|e| e.to_string())?;
                    out.push(to.to_string_lossy().into_owned());
                    jobs.push(Job { item: p.item.clone(), to });
                }
            }
        }
        let total = jobs.len();
        progress(0, total);
        for (i, job) in jobs.iter().enumerate() {
            if let Err(e) = copy_one(job) {
                let _ = std::fs::remove_dir_all(&batch);
                progress(total, total);
                return Err(format!("copying from the device failed: {e}"));
            }
            progress(i + 1, total);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_only_what_the_upload_takes() {
        assert!(is_media("IMG_0001.JPG"));
        assert!(is_media("clip.MOV"));
        assert!(!is_media("IMG_0001.THM"));
        assert!(!is_media("README"));
    }

    #[test]
    fn a_device_name_becomes_one_safe_component() {
        assert_eq!(safe_name("DCIM/100CANON"), "DCIM_100CANON");
        assert_eq!(safe_name("a:b*c?"), "a_b_c_");
        assert_eq!(safe_name("  trip.  "), "trip");
        assert_eq!(safe_name(""), "_");
    }

    #[test]
    fn a_taken_name_gets_a_number() {
        let dir = std::env::temp_dir().join(format!("pfp-device-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(free_name(&dir, "a.jpg"), dir.join("a.jpg"));
        std::fs::write(dir.join("a.jpg"), b"x").unwrap();
        assert_eq!(free_name(&dir, "a.jpg"), dir.join("a (2).jpg"));
        std::fs::write(dir.join("a (2).jpg"), b"x").unwrap();
        assert_eq!(free_name(&dir, "a.jpg"), dir.join("a (3).jpg"));
        assert_eq!(free_name(&dir, "noext"), dir.join("noext"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Copies a folder off a real camera or phone: `PFP_MTP_TEST` names the folder under
    /// This PC by its shown names joined with `|` (`Phone|Internal storage|DCIM|Test`), and
    /// the folder holds photos and a non-media file. Run by hand with the device plugged in:
    /// `cargo test --lib -- --ignored`.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn copies_a_device_folder_with_its_name_and_only_its_media() {
        use windows::core::HSTRING;
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
        use windows::Win32::UI::Shell::{IShellItem, SHCreateItemFromParsingName, SIGDN_FILESYSPATH, SIGDN_NORMALDISPLAY};
        let names = std::env::var("PFP_MTP_TEST").expect("PFP_MTP_TEST");
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let this_pc = HSTRING::from("::{20D04FE0-3AEA-1069-A2D8-08002B30309D}");
            let mut item: IShellItem = SHCreateItemFromParsingName(&this_pc, None).unwrap();
            for name in names.split('|') {
                item = win::children(&item)
                    .into_iter()
                    .find(|c| win::display(c, SIGDN_NORMALDISPLAY).as_deref() == Some(name))
                    .unwrap_or_else(|| panic!("no {name}"));
            }
            assert!(win::display(&item, SIGDN_FILESYSPATH).is_none(), "the test folder must be on a device");
            let seen = std::cell::RefCell::new(Vec::new());
            let out = win::copy_off_device(vec![win::Picked { path: None, item }], |c, t| seen.borrow_mut().push((c, t)))
                .unwrap();
            assert_eq!(out.len(), 1);
            let dir = PathBuf::from(&out[0]);
            let mut names: Vec<String> = std::fs::read_dir(&dir)
                .unwrap()
                .flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect();
            names.sort();
            println!("{} -> {:?} {:?}", dir.display(), names, seen.borrow());
            assert!(names.iter().all(|n| is_media(n)), "only photos and videos are copied: {names:?}");
            assert!(!names.is_empty());
            for n in &names {
                assert!(std::fs::metadata(dir.join(n)).unwrap().len() > 0, "{n} is empty");
            }
            // With the device's own files pulled beside the test, the copies must match byte for byte.
            if let Some(originals) = std::env::var_os("PFP_MTP_ORIGINALS") {
                for n in &names {
                    let want = std::fs::read(PathBuf::from(&originals).join(n)).unwrap();
                    assert_eq!(std::fs::read(dir.join(n)).unwrap(), want, "{n} differs");
                }
                println!("byte-identical: {}", names.len());
            }
            assert_eq!(seen.borrow().last().copied(), Some((names.len(), names.len())));
            let _ = std::fs::remove_dir_all(dir.parent().unwrap());
        }
    }
}
