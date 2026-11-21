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

// The folders the fill made, taken away once the folder stops being shown in File
// Explorer. Windows takes the cloud-only placeholders with the registration and leaves
// every folder behind, most of them empty. Only the fill's own layout is looked at
// (`Photos`, `Photos\Favorites`, `Albums`, `Albums\<album>`, `Shared`, `Shared\<album>`,
// `Trash`), only a folder with nothing in it at all goes, and the folder itself is
// never removed. A link of any kind (junction, symbolic link, mount point) is neither
// entered nor removed; the only reparse point allowed is the cloud one the fill's own
// folders carry.

use std::path::Path;

const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
/// `IO_REPARSE_TAG_CLOUD` and its sixteen variants (`IO_REPARSE_TAG_CLOUD_1` .. `_F`),
/// which differ only in the bits of `IO_REPARSE_TAG_CLOUD_MASK`.
const IO_REPARSE_TAG_CLOUD: u32 = 0x9000_001A;
const IO_REPARSE_TAG_CLOUD_MASK: u32 = 0x0000_F000;

/// The fill's folders under the root, children before their parents.
const TOP: [&str; 4] = ["Albums", "Shared", "Trash", "Photos"];
const WITH_ALBUMS: [&str; 2] = ["Albums", "Shared"];

/// Whether a directory entry with these attributes and reparse tag may be looked into and
/// removed: a plain folder, or one carrying the Cloud Files tag. Anything else that is a
/// reparse point is a link to somewhere else.
pub(crate) fn plain_or_cloud_folder(attributes: u32, reparse_tag: u32) -> bool {
    if attributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
        return false;
    }
    if attributes & FILE_ATTRIBUTE_REPARSE_POINT == 0 {
        return true;
    }
    reparse_tag & !IO_REPARSE_TAG_CLOUD_MASK == IO_REPARSE_TAG_CLOUD
}

/// The attributes and reparse tag of the entry itself, read from its directory entry
/// (nothing is opened, and a link is not followed).
fn entry_of(path: &Path) -> Option<(u32, u32)> {
    use windows::core::HSTRING;
    use windows::Win32::Storage::FileSystem::{FindClose, FindFirstFileW, WIN32_FIND_DATAW};
    let wide = HSTRING::from(path.as_os_str());
    let mut data = WIN32_FIND_DATAW::default();
    let handle = unsafe { FindFirstFileW(&wide, &mut data) }.ok()?;
    let _ = unsafe { FindClose(handle) };
    let tag = if data.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 { data.dwReserved0 } else { 0 };
    Some((data.dwFileAttributes, tag))
}

fn safe_folder(path: &Path) -> bool {
    entry_of(path).is_some_and(|(attributes, tag)| plain_or_cloud_folder(attributes, tag))
}

/// Nothing at all inside: no file, hidden and system ones included, no folder, no link.
/// A folder that cannot be listed counts as holding something.
fn empty(path: &Path) -> bool {
    std::fs::read_dir(path).is_ok_and(|mut entries| entries.next().is_none())
}

/// The fill's folders that exist under `root`, deepest first.
fn candidates(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    for parent in WITH_ALBUMS {
        if !safe_folder(&root.join(parent)) {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(root.join(parent)) else { continue };
        let mut names: Vec<String> = entries
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        out.extend(names.into_iter().map(|name| format!("{parent}\\{name}")));
    }
    if safe_folder(&root.join("Photos")) {
        out.push("Photos\\Favorites".into());
    }
    out.extend(TOP.iter().map(|s| s.to_string()));
    out
}

/// Removes the fill's folders under `root` that hold nothing, children first, and says
/// which went (paths relative to `root`). Each folder is checked again right before it is
/// removed, and the removal itself refuses a folder that is not empty, so a file dropped
/// in meanwhile keeps its folder.
pub(crate) fn remove_empty_app_folders(root: &Path) -> Vec<String> {
    let mut removed = Vec::new();
    if !root.is_absolute() || !safe_folder(root) {
        return removed;
    }
    for rel in candidates(root) {
        let path = root.join(&rel);
        if !safe_folder(&path) || !empty(&path) {
            continue;
        }
        if std::fs::remove_dir(&path).is_ok() {
            removed.push(rel);
        }
    }
    removed
}

/// What went, for the log: the fill's fixed folders by name, album folders as a count.
pub(crate) fn summary(removed: &[String]) -> String {
    let albums = removed.iter().filter(|r| r.starts_with("Albums\\")).count();
    let shared = removed.iter().filter(|r| r.starts_with("Shared\\")).count();
    let fixed: Vec<&str> = removed.iter().map(String::as_str).filter(|r| !r.contains('\\') || *r == "Photos\\Favorites").collect();
    format!(
        "removed {} empty folders: {albums} album, {shared} shared album, fixed [{}]",
        removed.len(),
        fixed.join(", ")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::Command;

    fn scratch(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("pfp-empty-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn junction(link: &Path, target: &Path) {
        let ok = Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .unwrap()
            .status
            .success();
        assert!(ok, "mklink /J failed");
    }

    #[test]
    fn only_plain_and_cloud_folders_pass() {
        assert!(plain_or_cloud_folder(0x10, 0));
        assert!(plain_or_cloud_folder(0x10 | 0x400, 0x9000_001A));
        assert!(plain_or_cloud_folder(0x10 | 0x400, 0x9000_301A));
        // Junction, symbolic link, a file.
        assert!(!plain_or_cloud_folder(0x10 | 0x400, 0xA000_0003));
        assert!(!plain_or_cloud_folder(0x10 | 0x400, 0xA000_000C));
        assert!(!plain_or_cloud_folder(0x20, 0));
    }

    #[test]
    fn empty_nested_album_folders_go_and_the_root_stays() {
        let root = scratch("nested");
        for rel in ["Photos\\Favorites", "Albums\\Trip", "Albums\\Home", "Shared\\Friends", "Trash"] {
            std::fs::create_dir_all(root.join(rel)).unwrap();
        }
        let removed = remove_empty_app_folders(&root);
        assert_eq!(removed.len(), 8, "{removed:?}");
        assert!(root.is_dir());
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_folder_with_a_user_file_stays_with_its_parents() {
        let root = scratch("userfile");
        std::fs::create_dir_all(root.join("Albums\\Trip")).unwrap();
        std::fs::create_dir_all(root.join("Albums\\Empty")).unwrap();
        std::fs::write(root.join("Albums\\Trip\\mine.jpg"), b"x").unwrap();
        let removed = remove_empty_app_folders(&root);
        assert_eq!(removed, vec!["Albums\\Empty".to_string()]);
        assert!(root.join("Albums\\Trip\\mine.jpg").is_file());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_folder_with_a_hidden_system_file_stays() {
        let root = scratch("hidden");
        std::fs::create_dir_all(root.join("Albums\\Trip")).unwrap();
        let ini = root.join("Albums\\Trip\\desktop.ini");
        std::fs::write(&ini, b"[.ShellClassInfo]").unwrap();
        assert!(Command::new("attrib").args(["+h", "+s"]).arg(&ini).status().unwrap().success());
        let removed = remove_empty_app_folders(&root);
        assert!(removed.is_empty(), "{removed:?}");
        assert!(ini.exists());
        assert!(Command::new("attrib").args(["-h", "-s"]).arg(&ini).status().unwrap().success());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_junction_is_kept_and_not_followed() {
        let root = scratch("junction");
        let outside = scratch("junction-target");
        std::fs::create_dir_all(outside.join("Albums\\Deep")).unwrap();
        std::fs::create_dir_all(outside.join("Empty")).unwrap();
        // A link in an album's place, and one standing in for a whole fixed folder.
        std::fs::create_dir_all(root.join("Albums")).unwrap();
        junction(&root.join("Albums\\Linked"), &outside.join("Empty"));
        junction(&root.join("Shared"), &outside);
        std::fs::create_dir_all(root.join("Trash")).unwrap();
        let removed = remove_empty_app_folders(&root);
        assert_eq!(removed, vec!["Trash".to_string()]);
        assert!(root.join("Albums\\Linked").exists());
        assert!(root.join("Shared").exists());
        assert!(outside.join("Albums\\Deep").is_dir());
        assert!(outside.join("Empty").is_dir());
        // Links go first, with rmdir on the link itself, so nothing behind them is touched.
        std::fs::remove_dir(root.join("Albums\\Linked")).unwrap();
        std::fs::remove_dir(root.join("Shared")).unwrap();
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn a_root_that_is_a_link_is_left_alone() {
        let base = scratch("rootlink");
        let real = base.join("real");
        std::fs::create_dir_all(real.join("Albums\\Trip")).unwrap();
        junction(&base.join("Proton Photos"), &real);
        assert!(remove_empty_app_folders(&base.join("Proton Photos")).is_empty());
        assert!(real.join("Albums\\Trip").is_dir());
        std::fs::remove_dir(base.join("Proton Photos")).unwrap();
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn folders_outside_the_layout_stay() {
        let root = scratch("layout");
        std::fs::create_dir_all(root.join("Mine")).unwrap();
        std::fs::create_dir_all(root.join("Photos\\2024")).unwrap();
        std::fs::create_dir_all(root.join("Albums\\Trip\\Inner")).unwrap();
        let removed = remove_empty_app_folders(&root);
        assert!(removed.is_empty(), "{removed:?}");
        assert!(root.join("Mine").is_dir());
        assert!(root.join("Photos\\2024").is_dir());
        assert!(root.join("Albums\\Trip\\Inner").is_dir());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_summary_names_fixed_folders_only() {
        let removed: Vec<String> =
            ["Albums\\Trip", "Albums\\Home", "Shared\\F", "Photos\\Favorites", "Albums", "Trash"].iter().map(|s| s.to_string()).collect();
        assert_eq!(summary(&removed), "removed 6 empty folders: 2 album, 1 shared album, fixed [Photos\\Favorites, Albums, Trash]");
    }
}
