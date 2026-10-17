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

// The neighbours of a file opened from Explorer: the rest of its folder.
//
// A viewer launched over one file has no list behind it, so this builds the one Explorer
// itself would show, using the media types `local_file` already admits and the shell's own
// name order, and hands it back a page at a time.
//
// Two things are deliberate and both are about a folder with fifty thousand files in it.
// The listing is built once on a blocking thread and kept, so paging through it costs
// nothing more; and only a page ever crosses to the webview, so nothing here puts a
// hundred thousand names into the renderer's heap to draw fifteen tiles. The directory is
// sent once per page rather than repeated on every entry for the same reason.
//
// Sizes come from the directory scan itself, never from opening a file. That is what keeps
// this usable inside the Proton Photos folder: to the Cloud Filter driver an open that is
// not marked no-recall is a data access, so a listing that stat-ed each file would
// download the whole album to draw a filmstrip.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

use crate::local_file;

/// The most entries one folder contributes.
///
/// A ceiling rather than an expectation: a camera roll is a few thousand and the number
/// exists so that a directory nobody meant as a photo folder cannot decide how much
/// memory this holds. Each entry is a name, a size and a flag, so the cap is a handful of
/// megabytes at the very top and nothing at all in ordinary use.
const MAX_ENTRIES: usize = 100_000;

/// The most entries one page may carry, whatever the caller asks for.
const MAX_PAGE: usize = 400;

/// The longest edge asked of the shell for a strip thumbnail.
///
/// Small on purpose. The tiles are around sixty pixels, this covers a scaled display with
/// room to spare, and asking for more would push the shell past its cached size and into
/// extracting a fresh picture for every tile that scrolls by.
const THUMB_EDGE: i32 = 160;

/// How many pictures are pulled at once, and with it the memory ceiling: each worker holds
/// one decoded bitmap while it encodes. Extraction is mostly waiting on a decoder, so a
/// handful of threads shortens a cold folder considerably and more would only contend.
const THUMB_WORKERS: usize = 4;

/// One media file in a folder listing.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderEntry {
    name: String,
    size: u64,
    /// Whether this one is a video, so the strip can mark it without asking again.
    video: bool,
}

/// One window onto a folder's media files.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderPage {
    /// The folder they all live in. Joined with each name to make a path, so it crosses
    /// once per page instead of being repeated on every entry.
    dir: String,
    /// How many media files the folder holds in total, which is what the strip and the
    /// contents list size themselves against.
    total: usize,
    /// Where the open file sits in that total, or -1 when it is no longer in the folder
    /// at all (renamed away, deleted, or moved while the viewer was up).
    anchor_index: i64,
    /// The index `entries[0]` stands at.
    offset: usize,
    entries: Vec<FolderEntry>,
}

/// The one folder listing held at a time.
///
/// A viewer looks at a single folder for as long as it is open, so one is enough, and
/// keeping it is what makes paging free. Replaced the moment a different folder is asked
/// for, so nothing is retained after the window that wanted it has gone.
#[derive(Default)]
pub struct FolderListing(Mutex<Option<CachedFolder>>);

struct CachedFolder {
    dir: PathBuf,
    entries: Vec<FolderEntry>,
}

/// Every media file in one directory, in Explorer's order.
///
/// `DirEntry::metadata` rather than `fs::metadata`: on Windows the first answers out of
/// the data the directory scan already returned, and the second opens the file. Opening is
/// what would hydrate a placeholder, so the difference between the two is whether
/// listing the Proton Photos folder downloads it.
fn read_folder(dir: &Path) -> Vec<FolderEntry> {
    let Ok(iter) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<FolderEntry> = Vec::new();
    for entry in iter.flatten() {
        if out.len() >= MAX_ENTRIES {
            break;
        }
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let raw = entry.file_name();
        let name = raw.to_string_lossy();
        let ext = local_file::extension_of(&name);
        let Some((_, mime, _)) = local_file::media_entry(&ext) else {
            continue;
        };
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        out.push(FolderEntry {
            name: name.into_owned(),
            size: meta.len(),
            video: mime.starts_with("video/"),
        });
    }
    sort_like_explorer(out)
}

/// Compare two names the way the shell sorts a folder: case-insensitively, and with a run
/// of digits read as a number, so `IMG_9` comes before `IMG_10` rather than after it.
///
/// Asked of Windows rather than written out here, for the reason the decoders are: this is
/// the comparison Explorer itself sorts a folder with, and a second implementation of it
/// would be a second answer to the same question.
#[cfg(windows)]
fn compare_names(a: &[u16], b: &[u16]) -> std::cmp::Ordering {
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::StrCmpLogicalW;

    let ordering = unsafe { StrCmpLogicalW(PCWSTR(a.as_ptr()), PCWSTR(b.as_ptr())) }.cmp(&0);
    // Two different names the shell calls equal still have to be ordered, and ordered the
    // same way every time: a comparator that says equal for a pair it is asked about twice
    // in different positions is not a sort order, and Rust is entitled to panic on one.
    ordering.then_with(|| a.cmp(b))
}

/// Off Windows there is no shell to ask, and no viewer window either. Plain and
/// case-insensitive, so the listing is still ordered rather than arbitrary.
#[cfg(not(windows))]
fn compare_names(a: &[u16], b: &[u16]) -> std::cmp::Ordering {
    let fold = |s: &[u16]| String::from_utf16_lossy(s).to_lowercase();
    fold(a).cmp(&fold(b)).then_with(|| a.cmp(b))
}

/// A null-terminated UTF-16 copy, which is what the shell's comparison takes.
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Put a folder's entries in Explorer's order.
///
/// Each name is converted to UTF-16 once and carried through the sort rather than
/// converted inside the comparison: a sort makes on the order of n log n of those, and
/// rebuilding two buffers in each one is the difference between a listing and a stall.
fn sort_like_explorer(entries: Vec<FolderEntry>) -> Vec<FolderEntry> {
    let mut keyed: Vec<(Vec<u16>, FolderEntry)> =
        entries.into_iter().map(|e| (wide(&e.name), e)).collect();
    keyed.sort_by(|a, b| compare_names(&a.0, &b.0));
    keyed.into_iter().map(|(_, entry)| entry).collect()
}

/// Where a page of `limit` entries should start so that `anchor` sits inside it.
///
/// Centred where there is room on both sides, and pinned to the end the anchor is near
/// otherwise, so opening the first or the last file in a folder still fills a page.
fn page_start(anchor: usize, total: usize, limit: usize) -> usize {
    if total <= limit {
        return 0;
    }
    anchor.saturating_sub(limit / 2).min(total - limit)
}

/// The media files that share a folder with the one the viewer has open.
///
/// `anchor` is that file. The folder is derived from it here rather than passed, so the
/// renderer never names a directory of its own, and the answer says where the anchor sits
/// in the listing as well as what is around it.
///
/// `offset` of `None` asks for the page the anchor is on, which is what a viewer wants on
/// open; the strip and the contents list pass a real offset as they scroll.
#[tauri::command]
pub async fn list_media_folder(
    app: AppHandle,
    anchor: String,
    offset: Option<usize>,
    limit: usize,
) -> Result<FolderPage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let resolved = local_file::checked_media_path(&app, &anchor)?;
        let dir = resolved
            .parent()
            .ok_or_else(|| "that file is not in a folder".to_string())?
            .to_path_buf();
        let anchor_name = resolved
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();

        let listing = app.state::<FolderListing>();
        let mut held = listing.0.lock().unwrap_or_else(|e| e.into_inner());

        // Rebuilt when the folder is a different one, and when the open file is not in the
        // listing that is held: the second is what a rename looks like from here, and
        // re-reading is both the correct answer and a bounded one, since a name that is
        // still missing afterwards simply reports -1 rather than asking again.
        let stale = match held.as_ref() {
            Some(cached) => {
                cached.dir != dir || !cached.entries.iter().any(|e| e.name == anchor_name)
            }
            None => true,
        };
        if stale {
            let entries = read_folder(&dir);
            crate::note(&app, &format!("[folder] listed {} media files", entries.len()));
            *held = Some(CachedFolder { dir: dir.clone(), entries });
        }

        let cached = held.as_ref().expect("just filled");
        let total = cached.entries.len();
        let anchor_index = cached
            .entries
            .iter()
            .position(|e| e.name == anchor_name)
            .map(|i| i as i64)
            .unwrap_or(-1);

        let limit = limit.clamp(1, MAX_PAGE);
        let start = match offset {
            Some(offset) => offset.min(total),
            None => page_start(anchor_index.max(0) as usize, total, limit),
        };
        let end = start.saturating_add(limit).min(total);

        Ok(FolderPage {
            dir: crate::strip_verbatim(dir).to_string_lossy().into_owned(),
            total,
            anchor_index,
            offset: start,
            entries: cached.entries[start..end].to_vec(),
        })
    })
    .await
    .map_err(|e| format!("listing that folder failed: {e}"))?
}

// ---- Explorer's own picture of a file ----
//
// The same bargain the viewer's decode already makes: whatever the machine can open, this
// can show, and whatever it cannot comes back as nothing rather than as a decoder shipped
// in this app. `SIIGBF_THUMBNAILONLY` is what makes "nothing" honest: without it a file
// Windows cannot decode answers with the generic icon for its type, and a filmstrip of
// those would look deliberate.
//
// Deliberately not folded in with the upload's frame grabber, which asks the shell the
// same question. That one wants one large picture per dropped video and stages it for the
// sidecar to read; this wants a great many small ones that are read back and deleted
// within the call. The one piece worth sharing is the encoder chain, and that is already
// shared: both end in `local_file::encode_jpeg`.

/// Whether this file's bytes are not really here, so reading them would fetch them.
///
/// The one thing a filmstrip must never do. Asking a photo library's worth of files for a
/// picture is fine when the bytes are on the disk; over a folder of placeholders it would
/// download the album to draw tiles nobody asked for, which is the difference between a
/// viewer and a sync. The file the viewer was actually opened with is the exception, and
/// it does not come through here: opening that one is a download the user asked for.
///
/// Both attributes, because the two files-on-demand shapes differ: the app's own mount and
/// OneDrive's "online-only" set RECALL_ON_DATA_ACCESS, and a dehydrated full placeholder
/// sets RECALL_ON_OPEN. The read costs nothing and opens nothing: `fs::metadata` asks for
/// no data access at all, so it is not itself a fetch.
#[cfg(windows)]
fn bytes_are_elsewhere(path: &Path) -> bool {
    use std::os::windows::fs::MetadataExt;
    const RECALL_ON_OPEN: u32 = 0x0004_0000;
    const RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;
    std::fs::metadata(path)
        .map(|m| m.file_attributes() & (RECALL_ON_OPEN | RECALL_ON_DATA_ACCESS) != 0)
        .unwrap_or(true)
}

#[cfg(not(windows))]
fn bytes_are_elsewhere(_path: &Path) -> bool {
    false
}

/// Ask the shell for one file's picture at `edge` pixels and write it out as a JPEG.
#[cfg(windows)]
fn grab_one(
    factory: &windows::Win32::Graphics::Imaging::IWICImagingFactory,
    src: &Path,
    dest: &Path,
    edge: i32,
) -> Result<(), String> {
    use windows::core::{Interface, HSTRING};
    use windows::Win32::Foundation::SIZE;
    use windows::Win32::Graphics::Gdi::{DeleteObject, HPALETTE};
    use windows::Win32::Graphics::Imaging::{IWICBitmapSource, WICBitmapIgnoreAlpha};
    use windows::Win32::UI::Shell::{
        IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_THUMBNAILONLY,
    };

    unsafe {
        let item: IShellItemImageFactory = SHCreateItemFromParsingName(&HSTRING::from(src), None)
            .map_err(|_| "the shell does not recognise this file".to_string())?;

        let bitmap = item
            .GetImage(SIZE { cx: edge, cy: edge }, SIIGBF_THUMBNAILONLY)
            .map_err(|_| "windows has no picture for this file".to_string())?;

        let encoded = (|| {
            // Alpha ignored rather than used: a shell thumbnail is opaque, but some
            // providers hand back a zeroed alpha channel they never meant as transparency,
            // and honouring that would composite the whole tile away to black.
            let source: IWICBitmapSource = factory
                .CreateBitmapFromHBITMAP(bitmap, HPALETTE(std::ptr::null_mut()), WICBitmapIgnoreAlpha)
                .map_err(|_| "that picture could not be read".to_string())?
                .cast()
                .map_err(|_| "that picture could not be read".to_string())?;
            // Not turned upright on the way through, unlike the viewer's own decode: the
            // shell applies orientation itself, so turning it again would lay it on its side.
            local_file::encode_jpeg(factory, &source, dest)
        })();

        let _ = DeleteObject(bitmap.into());
        encoded
    }
}

/// One worker's share, with COM and the imaging factory set up once for the thread.
///
/// The thread is this module's own rather than one borrowed from the runtime's blocking
/// pool, and that is deliberate: a fresh thread has no apartment yet, so it can be put in
/// the single-threaded one that shell extensions expect. A pooled thread may already have
/// been placed in the multi-threaded apartment by an earlier decode, and every thumbnail
/// provider on the machine would then be marshalled across apartments for no reason.
#[cfg(windows)]
fn grab_chunk(jobs: &[(PathBuf, PathBuf)], edge: i32, made: &mut [bool]) {
    use windows::Win32::Foundation::RPC_E_CHANGED_MODE;
    use windows::Win32::Graphics::Imaging::{CLSID_WICImagingFactory, IWICImagingFactory};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };

    let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    if hr.is_err() && hr != RPC_E_CHANGED_MODE {
        return;
    }

    let factory: Result<IWICImagingFactory, _> =
        unsafe { CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER) };
    if let Ok(factory) = factory {
        for ((src, dest), made) in jobs.iter().zip(made.iter_mut()) {
            *made = grab_one(&factory, src, dest, edge).is_ok();
            if !*made {
                // A half-written file would otherwise be read back as a truncated JPEG.
                let _ = std::fs::remove_file(dest);
            }
        }
    }

    // Owned here: this thread is about to end and nothing else will ever run on it.
    if hr.is_ok() {
        unsafe { CoUninitialize() };
    }
}

/// Which jobs produced a file, in the order they were given.
#[cfg(windows)]
fn grab_pictures(jobs: &[(PathBuf, PathBuf)], edge: i32) -> Vec<bool> {
    // `chunks` panics on a zero size, which is what an empty job list would compute.
    if jobs.is_empty() {
        return Vec::new();
    }
    let mut made = vec![false; jobs.len()];
    let chunk = jobs.len().div_ceil(THUMB_WORKERS.min(jobs.len()).max(1));
    std::thread::scope(|scope| {
        for (jobs, made) in jobs.chunks(chunk).zip(made.chunks_mut(chunk)) {
            scope.spawn(move || grab_chunk(jobs, edge, made));
        }
    });
    made
}

#[cfg(not(windows))]
fn grab_pictures(jobs: &[(PathBuf, PathBuf)], _edge: i32) -> Vec<bool> {
    vec![false; jobs.len()]
}

/// Put the answers back in the caller's own order.
///
/// Only the paths that survived vetting were ever asked about, so the answers are a shorter
/// list than the question. Spreading them back over the holes is what keeps entry i of the
/// answer the picture of path i of the question, rather than of the one after it.
fn realign(vetted: &[bool], produced: Vec<Option<String>>) -> Vec<Option<String>> {
    let mut answers = produced.into_iter();
    vetted
        .iter()
        .map(|asked| if *asked { answers.next().flatten() } else { None })
        .collect()
}

/// Explorer's own picture of each of these files, small, as data URLs.
///
/// One call per visible run of tiles rather than one per tile, and only for tiles that are
/// actually on screen: a folder of fifty thousand photos draws fifteen of them at a time
/// and this is asked for fifteen. A file the shell has no picture for comes back as null,
/// which the strip draws as an empty tile rather than as a broken one.
///
/// A data URL rather than a staged file, unlike the viewer's full-resolution decode: these
/// are a few kilobytes each, the caller keeps a bounded number of them, and nothing is left
/// in the temp folder for a sweep to find.
#[tauri::command]
pub async fn local_thumbnails(
    app: AppHandle,
    paths: Vec<String>,
) -> Result<Vec<Option<String>>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let wanted = paths.len();
        if wanted == 0 {
            return Ok(Vec::new());
        }

        let dir = std::env::temp_dir().join("pfp-thumb");
        if std::fs::create_dir_all(&dir).is_err() {
            return Ok(vec![None; wanted]);
        }

        // Vetted the same way every other caller-named path here is, and staged under a
        // name of its own so two viewers cannot write over each other.
        let staged: Vec<Option<(PathBuf, PathBuf)>> = paths
            .iter()
            .map(|path| {
                let src = local_file::checked_media_path(&app, path).ok()?;
                if bytes_are_elsewhere(&src) {
                    return None;
                }
                // The shell parses a path rather than opening one, and it does not
                // understand the verbatim prefix canonicalising leaves behind.
                Some((crate::strip_verbatim(src), dir.join(local_file::staged_name())))
            })
            .collect();

        let jobs: Vec<(PathBuf, PathBuf)> = staged.iter().flatten().cloned().collect();
        let made = grab_pictures(&jobs, THUMB_EDGE);

        // Read back and removed within the call: what the caller keeps is the data URL, and
        // the temp folder is left as it was found.
        let produced: Vec<Option<String>> = made
            .iter()
            .zip(jobs.iter())
            .map(|(ok, (_, dest))| {
                if !*ok {
                    return None;
                }
                let bytes = std::fs::read(dest).ok();
                let _ = std::fs::remove_file(dest);
                bytes.map(|b| {
                    use base64::Engine;
                    let encoded = base64::engine::general_purpose::STANDARD.encode(b);
                    format!("data:image/jpeg;base64,{encoded}")
                })
            })
            .collect();

        let vetted: Vec<bool> = staged.iter().map(Option::is_some).collect();
        let out = realign(&vetted, produced);

        // Counts only. A path or a name here would be somebody's photo library written to
        // a log that gets pasted into bug reports.
        crate::note(
            &app,
            &format!("[folder] thumbnails wanted {wanted} made {}", out.iter().flatten().count()),
        );
        Ok(out)
    })
    .await
    .map_err(|e| format!("reading those thumbnails failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str) -> FolderEntry {
        FolderEntry { name: name.to_string(), size: 0, video: false }
    }

    fn names(entries: Vec<FolderEntry>) -> Vec<String> {
        entries.into_iter().map(|e| e.name).collect()
    }

    // The shell's order and the placeholder check are Windows' own; elsewhere the
    // folder viewer does not exist and these would test the stand-ins.
    #[test]
    #[cfg(windows)]
    fn a_run_of_digits_sorts_as_a_number() {
        // The whole reason for asking the shell: plain text order puts IMG_10 before
        // IMG_9, and a filmstrip in that order does not match the folder behind it.
        let sorted = names(sort_like_explorer(vec![
            entry("IMG_10.jpg"),
            entry("IMG_9.jpg"),
            entry("IMG_100.jpg"),
            entry("IMG_1.jpg"),
        ]));
        assert_eq!(sorted, ["IMG_1.jpg", "IMG_9.jpg", "IMG_10.jpg", "IMG_100.jpg"]);
    }

    #[test]
    fn case_does_not_decide_the_order() {
        let sorted = names(sort_like_explorer(vec![
            entry("beach.jpg"),
            entry("Apple.jpg"),
            entry("apricot.jpg"),
        ]));
        assert_eq!(sorted, ["Apple.jpg", "apricot.jpg", "beach.jpg"]);
    }

    #[test]
    fn two_names_are_never_called_equal() {
        // A comparator that answers equal for two different names is not a sort order,
        // and sorting with one is allowed to panic.
        assert_ne!(compare_names(&wide("a.jpg"), &wide("A.JPG")), std::cmp::Ordering::Equal);
        assert_eq!(compare_names(&wide("a.jpg"), &wide("a.jpg")), std::cmp::Ordering::Equal);
    }

    #[test]
    fn sorting_keeps_every_entry() {
        let sorted = sort_like_explorer(vec![entry("b.jpg"), entry("a.jpg"), entry("c.jpg")]);
        assert_eq!(sorted.len(), 3);
    }

    #[test]
    fn a_page_holds_the_open_file() {
        // Centred in the middle of a folder.
        assert_eq!(page_start(500, 1000, 40), 480);
        // Pinned at the start rather than running off the front.
        assert_eq!(page_start(3, 1000, 40), 0);
        // And at the end rather than off the back, still a full page.
        assert_eq!(page_start(999, 1000, 40), 960);
        // A folder smaller than a page is one page.
        assert_eq!(page_start(2, 5, 40), 0);
        assert_eq!(page_start(0, 0, 40), 0);
    }

    #[test]
    #[cfg(windows)]
    fn only_media_files_are_listed_and_the_order_is_the_shells() {
        let dir = std::env::temp_dir().join(format!("pfp-folder-test-{}", local_file::staged_name()));
        std::fs::create_dir_all(&dir).unwrap();
        for name in ["IMG_2.jpg", "IMG_10.HEIC", "notes.txt", "clip.mp4", "keys.pem"] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        std::fs::create_dir_all(dir.join("subfolder")).unwrap();

        let listed = names(read_folder(&dir));
        std::fs::remove_dir_all(&dir).unwrap();

        // The text file, the key and the subfolder are all absent; the order is natural.
        assert_eq!(listed, ["clip.mp4", "IMG_2.jpg", "IMG_10.HEIC"]);
    }

    #[test]
    fn a_video_is_marked_as_one() {
        let dir = std::env::temp_dir().join(format!("pfp-folder-test-{}", local_file::staged_name()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.jpg"), b"x").unwrap();
        std::fs::write(dir.join("b.mov"), b"xx").unwrap();

        let listed = read_folder(&dir);
        std::fs::remove_dir_all(&dir).unwrap();

        assert_eq!(listed.len(), 2);
        assert!(!listed[0].video && listed[0].size == 1);
        assert!(listed[1].video && listed[1].size == 2);
    }

    #[test]
    fn a_folder_that_is_not_there_lists_nothing() {
        assert!(read_folder(Path::new("C:\\nowhere-at-all\\photos")).is_empty());
    }

    #[test]
    fn a_refused_path_leaves_a_hole_rather_than_shifting_the_rest() {
        // The failure this exists to prevent is silent: every tile after the refused one
        // would show the picture of its neighbour, and look like a working filmstrip.
        let out = realign(
            &[true, false, true],
            vec![Some("first".into()), Some("third".into())],
        );
        assert_eq!(out, vec![Some("first".into()), None, Some("third".into())]);

        // A file the shell had no picture for is a hole in the same way.
        assert_eq!(realign(&[true, true], vec![None, Some("b".into())]), vec![None, Some("b".into())]);
        assert!(realign(&[false, false], vec![]).iter().all(Option::is_none));
        assert!(realign(&[], vec![]).is_empty());
    }

    #[test]
    #[cfg(windows)]
    fn an_ordinary_file_is_not_treated_as_a_placeholder() {
        let dir = std::env::temp_dir().join(format!("pfp-folder-test-{}", local_file::staged_name()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.jpg");
        std::fs::write(&file, b"x").unwrap();

        let here = bytes_are_elsewhere(&file);
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(!here, "a file on the disk would never get a picture");

        // A file that cannot be asked about is left alone rather than fetched.
        assert!(bytes_are_elsewhere(Path::new("C:\\nowhere-at-all\\a.jpg")));
    }
}
