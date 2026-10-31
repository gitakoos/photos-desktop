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

// Photos for Proton installer. A small Tauri app that carries the whole app
// (the app + sidecar.exe + sidecar/) as an embedded zip and, on the user's
// confirmation, extracts it to a chosen folder, creates shortcuts, and registers
// an uninstaller in Add/Remove Programs. Run over an install that is already there
// it offers to upgrade instead: the same payload, laid over the old one, leaving
// the app's data where it is. Run with `--uninstall` it reverses all of that (and
// removes the app's data).

use std::fs;
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use tauri::Manager;

// The app defines what its data directory holds, so it owns the number describing
// it. Compile the app's own declaration rather than keep a copy here: two copies
// would eventually disagree, and this number decides whether an upgrade keeps the
// user's sign-in or clears it.
#[path = "../../../app/src-tauri/src/data_format.rs"]
mod data_format;
use data_format::{DATA_FORMAT, FORMAT_STAMP};

// The file associations, compiled from the app's own source for the same reason. The
// checkbox below can only ever switch them ON, and the app's Settings screen is the
// only thing that can switch them back off, so the two ends have to agree exactly on
// which types are claimed and under which name. A copy kept here would drift, and the
// drift would show up as an installer registering something Settings could not take
// back. The identity constants live there too, with the registration that is built out
// of them.
// Public because a module written for both ends will always hold something one end
// does not call: the installer never asks whether the registration is COMPLETE, which
// is a question only the app's two-state switch has to answer. Private, that half would
// read as dead code here.
#[path = "../../../app/src-tauri/src/file_assoc.rs"]
pub mod file_assoc;
use file_assoc::{APP_EXE, APP_NAME, LEGACY_APP_EXE, PACK_ID};

// Compiled from the app's source for the same reason as the associations: uninstalling
// has to take the Run entry away, and the name it is stored under has to be the exact
// one the app wrote. Public because the installer only ever calls the removal half.
#[path = "../../../app/src-tauri/src/autostart.rs"]
pub mod autostart;

const VERSION: &str = "1.2.0";
const PUBLISHER: &str = "Akoos";
const DATA_DIR_NAME: &str = "eu.akoos.photos.desktop"; // where the app keeps its vault/caches

// The app itself, zipped at build time by build-setup.ps1.
static PAYLOAD: &[u8] = include_bytes!("../payload/payload.zip");

/// Set at build time for an update installer, whose payload holds only the files that
/// changed since this version: it may update exactly that version, and install nothing.
const PATCH_FROM: Option<&str> = option_env!("PFP_PATCH_FROM");

/// Whether this installer may lay its payload over an install of `installed` (none for
/// a fresh install). A full installer always may; an update installer only over the
/// version it was made from, since over any other the files it leaves out are not the
/// ones that version needs.
fn patch_allows(patch_from: Option<&str>, installed: Option<&str>) -> Result<(), String> {
    match (patch_from, installed) {
        (None, _) => Ok(()),
        (Some(from), Some(version)) if version == from => Ok(()),
        (Some(from), _) => Err(format!(
            "This file only updates version {from}. Download Photos-for-Proton-Setup.exe instead."
        )),
    }
}

#[cfg(test)]
mod patch_tests {
    use super::patch_allows;

    #[test]
    fn a_full_installer_installs_and_updates_anything() {
        assert!(patch_allows(None, None).is_ok());
        assert!(patch_allows(None, Some("1.0.0")).is_ok());
    }

    #[test]
    fn an_update_installer_updates_only_its_own_version() {
        assert!(patch_allows(Some("1.1.0"), Some("1.1.0")).is_ok());
        assert!(patch_allows(Some("1.1.0"), Some("1.0.0")).is_err());
        assert!(patch_allows(Some("1.1.0"), None).is_err());
    }
}

fn local_app_data() -> PathBuf {
    PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_default())
}
fn desktop_dir() -> PathBuf {
    PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default()).join("Desktop")
}
fn start_menu_dir() -> PathBuf {
    PathBuf::from(std::env::var("APPDATA").unwrap_or_default())
        .join("Microsoft")
        .join("Windows")
        .join("Start Menu")
        .join("Programs")
}
fn data_dir() -> PathBuf {
    local_app_data().join(DATA_DIR_NAME)
}

/// The app's data directory inside an install: its sign-in, settings and caches.
/// Must match the app's own `secure_store::install_data_dir`, which puts it beside
/// the app so that one folder holds everything.
fn install_data_dir(install: &Path) -> PathBuf {
    install.join("data")
}

/// Uninstall when explicitly asked (`--uninstall`, as the Add/Remove-Programs
/// entry passes) OR when this executable IS the installed `uninstall.exe`, so a
/// plain double-click on it uninstalls instead of starting a fresh install.
/// Pure decision (unit-tested): uninstall if `--uninstall` is present OR this exe
/// is the installed `uninstall.exe` (a plain double-click on it).
fn wants_uninstall(args: &[String], exe_name: Option<&str>) -> bool {
    args.iter().any(|a| a == "--uninstall")
        || exe_name
            .map(|n| n.eq_ignore_ascii_case("uninstall.exe"))
            .unwrap_or(false)
}

fn is_uninstall() -> bool {
    let args: Vec<String> = std::env::args().collect();
    let exe = std::env::current_exe().ok();
    let name = exe.as_ref().and_then(|p| p.file_name()).and_then(|n| n.to_str());
    wants_uninstall(&args, name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uninstall_when_flag_present() {
        assert!(wants_uninstall(&["--uninstall".to_string()], Some("Setup.exe")));
    }

    #[test]
    fn uninstall_when_named_uninstall_exe_case_insensitive() {
        assert!(wants_uninstall(&[], Some("uninstall.exe")));
        assert!(wants_uninstall(&[], Some("UNINSTALL.EXE")));
    }

    #[test]
    fn install_by_default() {
        assert!(!wants_uninstall(&[], Some("Photos-for-Proton-Setup.exe")));
        assert!(!wants_uninstall(&["--silent".to_string()], Some("setup.exe")));
        assert!(!wants_uninstall(&[], None));
    }

    /// A throwaway install folder, laid out the way a real one is: the app's exe with
    /// the runtime under `resources\`, which is what tells the app to keep its data in
    /// `<install>\data`, and a data directory holding what an upgrade must not lose.
    /// Each test gets its own, as they run in parallel.
    ///
    /// `exe` is which name it was laid down under, so the same layout can stand in for
    /// an install made by this build or by one from before the executable was named.
    fn fake_install_named(name: &str, exe: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pfp-setup-test-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("resources")).unwrap();
        fs::write(dir.join("resources").join("sidecar.exe"), "old runtime").unwrap();
        fs::write(dir.join(exe), "old app").unwrap();
        let data = dir.join("data");
        fs::create_dir_all(data.join("thumbs")).unwrap();
        fs::write(data.join("key.bin"), "sealed data key").unwrap();
        fs::write(data.join("session.enc"), "the sign-in").unwrap();
        fs::write(data.join("thumbs").join("a.bin"), "a cached thumbnail").unwrap();
        dir
    }

    /// An install made by this build.
    fn fake_install(name: &str) -> PathBuf {
        fake_install_named(name, APP_EXE)
    }

    /// The blocker this guard exists for. `--uninstall` is honoured on any executable
    /// name and a double-click on anything called `uninstall.exe` uninstalls too, so
    /// the folder is just as easily a Downloads folder holding the downloaded
    /// installer, or a Desktop with a copy of the uninstaller sitting on it.
    #[test]
    fn only_a_folder_carrying_an_install_is_removed() {
        let dir = fake_install("guard");
        assert!(check_installation(&dir, None).is_ok());

        // A copy of the uninstaller, and the installer beside it, are not an install.
        let loose = dir.join("downloads");
        fs::create_dir_all(&loose).unwrap();
        fs::write(loose.join("uninstall.exe"), "a copy").unwrap();
        fs::write(loose.join("Photos-for-Proton-Setup.exe"), "the download").unwrap();
        fs::write(loose.join("taxes.pdf"), "someone's own file").unwrap();
        assert!(check_installation(&loose, None).is_err());

        // Neither is a folder carrying one half of the payload's layout.
        let half = dir.join("half");
        fs::create_dir_all(&half).unwrap();
        fs::write(half.join(APP_EXE), "the name alone").unwrap();
        assert!(check_installation(&half, None).is_err());

        let _ = fs::remove_dir_all(&dir);
    }

    /// An install laid down before the executable was named is still an install, and
    /// it is the one that most needs to stay removable: refuse it and no uninstaller
    /// will touch that folder again, from Add/Remove Programs or anywhere else.
    #[test]
    fn an_install_under_the_old_executable_name_is_still_one() {
        let old = fake_install_named("legacy-guard", LEGACY_APP_EXE);
        assert!(check_installation(&old, None).is_ok());
        let _ = fs::remove_dir_all(&old);
    }

    /// Upgrading over an install from before the rename leaves two executables in the
    /// folder, and the shortcuts still name the old one. It goes, but only once its
    /// replacement is there to go to.
    #[test]
    fn the_superseded_executable_goes_only_once_its_replacement_is_there() {
        let dir = fake_install_named("supersede", LEGACY_APP_EXE);

        // Nothing has replaced it yet, so an extraction that failed part-way must not
        // be finished off by removing the app that still runs.
        drop_superseded_exe(&dir);
        assert!(
            dir.join(LEGACY_APP_EXE).is_file(),
            "the only executable in the folder must survive"
        );

        // Now the payload has landed beside it, and the old one has somewhere to go.
        fs::write(dir.join(APP_EXE), "the new app").unwrap();
        drop_superseded_exe(&dir);
        assert!(!dir.join(LEGACY_APP_EXE).exists(), "the superseded exe should be gone");
        assert!(dir.join(APP_EXE).is_file(), "its replacement stays");

        // A folder that never carried the old name is untouched by any of this.
        drop_superseded_exe(&dir);
        assert!(dir.join(APP_EXE).is_file());

        let _ = fs::remove_dir_all(&dir);
    }

    /// A folder carrying the layout while the app is installed elsewhere is a copy of
    /// an install, and removing it would take the real one's shortcuts, its
    /// Add/Remove-Programs entry and the Explorer registration with it.
    #[test]
    fn a_copy_of_an_install_that_lives_elsewhere_is_refused() {
        let real = fake_install("registered");
        let copy = fake_install("copy");

        assert!(check_installation(&copy, Some(real.as_path())).is_err());
        assert!(check_installation(&real, Some(real.as_path())).is_ok());
        // An entry naming a folder that is gone says nothing about this one: an
        // uninstall that failed after removing the entry has to stay repeatable.
        assert!(check_installation(&copy, Some(Path::new("Z:\\gone"))).is_ok());

        let _ = fs::remove_dir_all(&real);
        let _ = fs::remove_dir_all(&copy);
    }

    /// The case this whole path exists for. Every install made before stamping carries
    /// no stamp, so reading that as "unknown, therefore reset" would take the sign-in
    /// and the caches off every existing user the first time they upgrade.
    #[test]
    fn unstamped_data_is_kept_and_stamped_silently() {
        let dir = fake_install("unstamped");
        let data = install_data_dir(&dir);
        assert!(!data.join(FORMAT_STAMP).exists(), "the fixture must start unstamped");

        assert!(!carry_data(&data), "an unstamped install must never be reset");

        assert_eq!(fs::read_to_string(data.join("session.enc")).unwrap(), "the sign-in");
        assert_eq!(fs::read_to_string(data.join("key.bin")).unwrap(), "sealed data key");
        assert_eq!(fs::read_to_string(data.join("thumbs").join("a.bin")).unwrap(), "a cached thumbnail");
        // Silently: it is now stamped, and nothing was said about it.
        assert_eq!(fs::read_to_string(data.join(FORMAT_STAMP)).unwrap(), DATA_FORMAT.to_string());
        assert!(!data.join("sidecar.log").exists(), "keeping the data is not worth a word");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn data_stamped_with_this_format_is_kept() {
        let dir = fake_install("current");
        let data = install_data_dir(&dir);
        fs::write(data.join(FORMAT_STAMP), DATA_FORMAT.to_string()).unwrap();

        assert!(!carry_data(&data));

        assert_eq!(fs::read_to_string(data.join("session.enc")).unwrap(), "the sign-in");
        let _ = fs::remove_dir_all(&dir);
    }

    /// A stamp too damaged to read a number out of says nothing about the format, so
    /// it is not grounds for taking anyone's sign-in away.
    #[test]
    fn unreadable_stamp_is_kept() {
        let dir = fake_install("garbled");
        let data = install_data_dir(&dir);
        fs::write(data.join(FORMAT_STAMP), "\u{0}\u{0}not a number").unwrap();

        assert!(!carry_data(&data));

        assert_eq!(fs::read_to_string(data.join("session.enc")).unwrap(), "the sign-in");
        assert_eq!(fs::read_to_string(data.join(FORMAT_STAMP)).unwrap(), DATA_FORMAT.to_string());
        let _ = fs::remove_dir_all(&dir);
    }

    /// The one case that may clear anything, and even then it is on the record.
    #[test]
    fn another_format_resets_the_data_and_says_so() {
        let dir = fake_install("stale");
        let data = install_data_dir(&dir);
        fs::write(data.join(FORMAT_STAMP), (DATA_FORMAT + 1).to_string()).unwrap();

        assert!(carry_data(&data), "a stamp naming another format must report a reset");

        assert!(!data.join("session.enc").exists(), "a sign-in this build cannot read must go");
        assert!(!data.join("thumbs").exists());
        assert_eq!(fs::read_to_string(data.join(FORMAT_STAMP)).unwrap(), DATA_FORMAT.to_string());
        // Never silently, and never at the user's expense: the reason is on record,
        // with nothing in it that points back at them.
        let log = fs::read_to_string(data.join("sidecar.log")).unwrap();
        assert!(log.contains("data reset"), "{log}");
        assert!(!log.contains(&dir.display().to_string()), "the log must not carry a path: {log}");
        let _ = fs::remove_dir_all(&dir);
    }

    /// What an upgrade does to the folder, run against a real install layout with the
    /// real payload: the app is replaced, and the data directory is left where it is.
    /// These are the only two steps of `upgrade_impl` that reach into the folder's
    /// contents; closing the app, refreshing the uninstaller and its Add/Remove-
    /// Programs entry, and relaunching never touch `data`.
    #[test]
    fn upgrade_lays_the_payload_over_the_data() {
        let dir = fake_install("upgrade");
        let data = install_data_dir(&dir);

        lay_payload(&dir).unwrap();
        let reset = carry_data(&data);
        // Nothing of the swap's own working space is left in the folder.
        assert!(!dir.join(UPGRADE_STAGING).exists());
        assert!(!dir.join(UPGRADE_PREVIOUS).exists());

        // The app was replaced by the one this installer carries...
        assert!(
            fs::metadata(dir.join(APP_EXE)).unwrap().len() > 1_000_000,
            "the payload's executable should have replaced the stub"
        );
        assert!(
            fs::metadata(dir.join("resources").join("sidecar.exe")).unwrap().len() > 1_000_000,
            "the payload's runtime should have replaced the stub"
        );
        assert!(dir.join("resources").join("sidecar").is_dir());
        // ...and the sign-in and the caches came through it untouched.
        assert!(!reset);
        assert_eq!(fs::read_to_string(data.join("key.bin")).unwrap(), "sealed data key");
        assert_eq!(fs::read_to_string(data.join("session.enc")).unwrap(), "the sign-in");
        assert_eq!(fs::read_to_string(data.join("thumbs").join("a.bin")).unwrap(), "a cached thumbnail");
        let _ = fs::remove_dir_all(&dir);
    }

    /// A swap that cannot finish puts every file back, so the install is never left
    /// holding some of each version, and the staged payload is intact for a retry.
    #[test]
    fn a_failed_swap_leaves_the_old_version_whole() {
        let root = std::env::temp_dir().join(format!("pfp-setup-test-{}-swap", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let (install, staging, previous) = (root.join("install"), root.join("staging"), root.join("previous"));
        fs::create_dir_all(&install).unwrap();
        fs::create_dir_all(staging.join("blocked")).unwrap();
        fs::write(install.join("a.txt"), "old a").unwrap();
        // A plain file where the new version needs a folder: the move under it fails.
        fs::write(install.join("blocked"), "in the way").unwrap();
        fs::write(staging.join("a.txt"), "new a").unwrap();
        fs::write(staging.join("blocked").join("z.txt"), "new z").unwrap();

        assert!(swap_in(&staging, &install, &previous).is_err());
        assert_eq!(fs::read_to_string(install.join("a.txt")).unwrap(), "old a");
        assert_eq!(fs::read_to_string(staging.join("a.txt")).unwrap(), "new a");
        assert_eq!(fs::read_to_string(staging.join("blocked").join("z.txt")).unwrap(), "new z");

        // Clear the way and it goes through, parking what it replaced.
        fs::remove_file(install.join("blocked")).unwrap();
        swap_in(&staging, &install, &previous).unwrap();
        assert_eq!(fs::read_to_string(install.join("a.txt")).unwrap(), "new a");
        assert_eq!(fs::read_to_string(install.join("blocked").join("z.txt")).unwrap(), "new z");
        assert_eq!(fs::read_to_string(previous.join("a.txt")).unwrap(), "old a");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn only_images_inside_the_install_folder_are_its_processes() {
        let install = Path::new(r"C:\Users\x\AppData\Local\Photos for Proton");
        assert!(image_is_under(r"C:\Users\x\AppData\Local\Photos for Proton\photosforproton.exe", install));
        assert!(image_is_under(r"c:\users\x\appdata\local\photos for proton\resources\sidecar.exe", install));
        assert!(image_is_under(r"\\?\C:\Users\x\AppData\Local\Photos for Proton\app.exe", install));
        // A sibling sharing the prefix is someone else's.
        assert!(!image_is_under(r"C:\Users\x\AppData\Local\Photos for Proton Beta\app.exe", install));
        assert!(!image_is_under(r"C:\Windows\explorer.exe", install));
    }

    #[test]
    fn the_tree_follows_children_but_not_a_recycled_parent_id() {
        // 10 is the app; 11 its WebView2 host; 12 a renderer of that host. 20 names 10 as
        // its parent too, but was started before 10 existed: an older process whose
        // parent id was recycled, which must never be killed with the app.
        let parents = [(10, 1), (11, 10), (12, 11), (20, 10), (30, 1)];
        let born = |pid: u32| match pid {
            10 => Some(100),
            11 => Some(110),
            12 => Some(120),
            20 => Some(50),
            30 => Some(10),
            _ => None,
        };
        let mut tree = process_tree(&[10], &parents, &born);
        tree.sort();
        assert_eq!(tree, vec![10, 11, 12]);
    }
}

fn is_update() -> bool {
    std::env::args().any(|a| a == "--update")
}

#[tauri::command]
fn mode() -> String {
    if is_uninstall() {
        "uninstall".into()
    } else if is_update() {
        "update".into()
    } else {
        "install".into()
    }
}

/// Where an update started by the running app stands: "running", "done", or
/// "failed: <reason>". The work runs on its own from `run()`, so it happens even if
/// the window never draws; the window only shows it.
static UPDATE_STATE: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());

#[tauri::command]
fn update_state() -> String {
    UPDATE_STATE.lock().unwrap().clone()
}

fn default_dir_impl() -> String {
    local_app_data().join(APP_NAME).to_string_lossy().into_owned()
}

#[tauri::command]
fn default_dir() -> String {
    default_dir_impl()
}

#[cfg(windows)]
fn read_install_location() -> Option<String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let key = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(format!(
            "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{PACK_ID}"
        ))
        .ok()?;
    let loc: String = key.get_value("InstallLocation").ok()?;
    (!loc.is_empty()).then_some(loc)
}
#[cfg(not(windows))]
fn read_install_location() -> Option<String> {
    None
}

/// The version the installed app was laid down as, as the registry records it.
#[cfg(windows)]
fn read_installed_version() -> Option<String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let key = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(format!(
            "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{PACK_ID}"
        ))
        .ok()?;
    key.get_value("DisplayVersion").ok()
}
#[cfg(not(windows))]
fn read_installed_version() -> Option<String> {
    None
}

/// The directory of an existing installation (present in the registry AND still
/// on disk), so the installer can offer to upgrade it, or to remove it, instead of
/// laying a second copy down beside it.
#[tauri::command]
fn existing_install() -> Option<String> {
    read_install_location().filter(|p| Path::new(p).exists())
}

/// Reveal the window once the UI has painted; it starts hidden so the user never
/// sees the empty transparent frame flash while the WebView loads.
#[tauri::command]
fn show_window(window: tauri::Window) {
    let _ = window.show();
}

fn extract_payload(dest: &Path) -> Result<(), String> {
    let mut archive =
        zip::ZipArchive::new(Cursor::new(PAYLOAD)).map_err(|e| format!("open payload: {e}"))?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let Some(rel) = entry.enclosed_name() else {
            continue; // skip unsafe paths
        };
        let out = dest.join(&rel);
        if entry.is_dir() {
            fs::create_dir_all(&out).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = out.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            // The payload-relative name, never the full path: this message reaches the
            // installer's error screen, where an absolute path would carry the account
            // name onto something people screenshot into public issue trackers.
            let mut f = fs::File::create(&out).map_err(|e| format!("write {}: {e}", rel.display()))?;
            std::io::copy(&mut entry, &mut f).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn make_shortcut(lnk: &Path, target: &Path) -> Result<(), String> {
    if let Some(parent) = lnk.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let sl = mslnk::ShellLink::new(target).map_err(|e| format!("shortcut: {e}"))?;
    sl.create_lnk(lnk).map_err(|e| format!("shortcut: {e}"))
}

#[cfg(windows)]
fn write_uninstall_entry(install: &Path, uninstaller: &Path, icon: &Path) -> Result<(), String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let path = format!("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{PACK_ID}");
    let (key, _) = hkcu.create_subkey(&path).map_err(|e| e.to_string())?;
    let s = |v: &Path| v.to_string_lossy().into_owned();
    key.set_value("DisplayName", &APP_NAME).map_err(|e| e.to_string())?;
    key.set_value("DisplayVersion", &VERSION).map_err(|e| e.to_string())?;
    key.set_value("Publisher", &PUBLISHER).map_err(|e| e.to_string())?;
    key.set_value("DisplayIcon", &s(icon)).map_err(|e| e.to_string())?;
    key.set_value("InstallLocation", &s(install)).map_err(|e| e.to_string())?;
    key.set_value(
        "UninstallString",
        &format!("\"{}\" --uninstall", uninstaller.display()),
    )
    .map_err(|e| e.to_string())?;
    key.set_value("NoModify", &1u32).map_err(|e| e.to_string())?;
    key.set_value("NoRepair", &1u32).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(not(windows))]
fn write_uninstall_entry(_: &Path, _: &Path, _: &Path) -> Result<(), String> {
    Ok(())
}

/// Append a line to the log the app itself writes, which lives in the data
/// directory. Keep every message to bare facts: this file is what a user is asked
/// to send when something goes wrong, so no path, no name, nothing that identifies
/// them may be written here.
fn note(data: &Path, message: &str) {
    if let Ok(mut file) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(data.join("sidecar.log"))
    {
        let _ = writeln!(file, "[setup] {message}");
    }
}

/// The format an existing data directory declares, if it declares one this build
/// can make a number out of.
fn stamped_format(data: &Path) -> Option<u32> {
    fs::read_to_string(data.join(FORMAT_STAMP)).ok()?.trim().parse().ok()
}

/// Settle an existing data directory as this build takes the folder over, and stamp
/// it with the format this build reads. Returns true if the data had to be cleared.
///
/// Only a stamp that is present AND names another format is grounds for clearing
/// anything. Everything else is kept:
///   - No stamp at all is the normal state of every install made before stamping
///     existed, and there has only ever been one format, so an absent stamp means
///     THIS format and is simply written in. Reading it as "unknown, so reset" would
///     take the sign-in and the caches off every existing user on their first
///     upgrade, which is the very thing keeping the folder is for.
///   - A stamp too damaged to read a number out of says nothing about the format, so
///     it is not treated as a claim that the data is unreadable.
fn carry_data(data: &Path) -> bool {
    let stale = stamped_format(data).filter(|found| *found != DATA_FORMAT);
    if stale.is_some() {
        // The build that wrote this declared a format this one does not read, so the
        // sealed session and the caches behind it cannot be opened. They go, and the
        // app starts at sign-in rather than failing later in a way nobody can place.
        let _ = fs::remove_dir_all(data);
    }
    let _ = fs::create_dir_all(data);
    let _ = fs::write(data.join(FORMAT_STAMP), DATA_FORMAT.to_string());
    if let Some(found) = stale {
        // Never silently. The line lands in the log the app goes on appending to,
        // which is what gets read when a sign-in has disappeared; the installer also
        // reports the reset back to its own UI, which tells the user outright.
        note(
            data,
            &format!("data reset: it declares format {found}, this build reads {DATA_FORMAT}"),
        );
    }
    stale.is_some()
}

/// Runs one of the installer's long steps on a worker thread. A plain (non-async) Tauri
/// command runs on the window's own thread, so an install, upgrade or uninstall that
/// took a while froze the window outright — Windows marked it "Not responding" while
/// the work went on, which reads exactly like a hang. Off that thread, the window keeps
/// drawing its progress the whole time.
async fn off_ui<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| format!("the installer stopped unexpectedly: {e}"))?
}

#[tauri::command]
async fn install(
    dir: String,
    desktop: bool,
    start_menu: bool,
    network_drive: bool,
    file_types: bool,
) -> Result<(), String> {
    off_ui(move || install_impl(dir, desktop, start_menu, network_drive, file_types)).await
}

fn install_impl(
    dir: String,
    desktop: bool,
    start_menu: bool,
    network_drive: bool,
    file_types: bool,
) -> Result<(), String> {
    patch_allows(PATCH_FROM, None)?;
    let target = PathBuf::from(&dir);
    // Which step failed, not where: the chosen folder sits under the user's profile,
    // so naming it here would put the account name on the error screen.
    fs::create_dir_all(&target).map_err(|e| format!("create the install folder: {e}"))?;
    extract_payload(&target)?;
    // A fresh install has no data to carry, and stamping it now means an absent
    // stamp can only ever mean an install from before stamping. The same rule still
    // applies rather than a blind stamp, though: a folder whose registry entry went
    // missing is reached as a fresh install while its old data is still sitting
    // there, and claiming that data is this format would be a lie.
    carry_data(&install_data_dir(&target));

    // Copy ourselves in as the uninstaller.
    let self_exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let uninstaller = target.join("uninstall.exe");
    fs::copy(&self_exe, &uninstaller).map_err(|e| format!("copy uninstaller: {e}"))?;

    let app_exe = target.join(APP_EXE);
    if desktop {
        make_shortcut(&desktop_dir().join(format!("{APP_NAME}.lnk")), &app_exe)?;
    }
    if start_menu {
        make_shortcut(&start_menu_dir().join(format!("{APP_NAME}.lnk")), &app_exe)?;
    }
    write_uninstall_entry(&target, &uninstaller, &app_exe)?;
    set_show_in_explorer_pref(network_drive);
    // Reported rather than swallowed: this one was asked for outright, so a user who
    // switched it on should hear that it did not happen instead of finding out later.
    if file_types {
        file_assoc::register(&app_exe)?;
    }
    Ok(())
}

/// Take away the executable an older install was laid down under.
///
/// An install made before the app's exe had a name of its own ends up holding two of
/// them, because the payload is laid over the folder and never takes anything out of
/// it. The old one still runs, and the shortcuts and startup entry written back then
/// still name it, so leaving it there means an upgrade changes nothing the user can
/// see: they keep launching the version they had.
///
/// The condition is the whole of the safety here. The old executable goes only once
/// the one replacing it is confirmed in place, so an extraction that half-succeeded
/// cannot be finished off by taking away the app that still works.
fn drop_superseded_exe(install: &Path) {
    let current = install.join(APP_EXE);
    let legacy = install.join(LEGACY_APP_EXE);
    if current.is_file() && legacy.is_file() {
        let _ = fs::remove_file(&legacy);
    }
}

/// Where an upgrade unpacks the new payload, and where it parks the files that payload
/// replaces until every one of them is in. Both live inside the install, so every move
/// between them is a same-volume rename.
const UPGRADE_STAGING: &str = ".pfp-upgrade";
const UPGRADE_PREVIOUS: &str = ".pfp-previous";

/// Every file under `dir`, relative to it, in a stable order.
fn files_under(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut out = Vec::new();
    let mut stack = vec![PathBuf::new()];
    while let Some(rel) = stack.pop() {
        for entry in fs::read_dir(dir.join(&rel)).map_err(|e| format!("read the new version: {e}"))? {
            let entry = entry.map_err(|e| e.to_string())?;
            let child = rel.join(entry.file_name());
            if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
                stack.push(child);
            } else {
                out.push(child);
            }
        }
    }
    out.sort();
    Ok(out)
}

/// Move every file of `staging` into place under `install`, parking each file it
/// replaces under `previous`. All or nothing: a move that fails puts back everything
/// done so far — the new files return to `staging`, the parked ones to where they
/// were — so the install is never left half one version and half the other, and the
/// swap can simply be tried again.
fn swap_in(staging: &Path, install: &Path, previous: &Path) -> Result<(), String> {
    let files = files_under(staging)?;
    let mut done: Vec<(&PathBuf, bool)> = Vec::new();
    let mut moved = || -> Result<(), String> {
        for rel in &files {
            let target = install.join(rel);
            let parked = previous.join(rel);
            if let Some(parent) = target.parent() {
                let _ = fs::create_dir_all(parent);
            }
            let had = target.is_file();
            if had {
                if let Some(parent) = parked.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                // The payload-relative name only: this reaches the error screen.
                fs::rename(&target, &parked).map_err(|e| format!("replace {}: {e}", rel.display()))?;
            }
            if let Err(e) = fs::rename(staging.join(rel), &target) {
                if had {
                    let _ = fs::rename(&parked, &target);
                }
                return Err(format!("replace {}: {e}", rel.display()));
            }
            done.push((rel, had));
        }
        Ok(())
    };
    let result = moved();
    if result.is_err() {
        for (rel, had) in done.into_iter().rev() {
            let target = install.join(rel);
            let _ = fs::rename(&target, staging.join(rel));
            if had {
                let _ = fs::rename(previous.join(rel), &target);
            }
        }
    }
    result
}

/// Put this installer's payload in place over an install, keeping the app down for as
/// short a time as possible and never leaving it half-replaced.
///
/// It used to close the app first and then unpack the whole payload over the folder,
/// so the app was gone for the length of the unpacking, and a file that stayed locked
/// part-way through left the folder holding some of each version. Now the payload is
/// unpacked beside the install while the app may still be running, which is the slow
/// part; the app is closed only for the swap, which is one rename per file; and the
/// swap is all or nothing (see `swap_in`), retried while anything still holds a file.
fn lay_payload(install: &Path) -> Result<(), String> {
    let staging = install.join(UPGRADE_STAGING);
    let previous = install.join(UPGRADE_PREVIOUS);
    // Whatever an earlier attempt left behind is not this upgrade's.
    let _ = fs::remove_dir_all(&staging);
    let _ = fs::remove_dir_all(&previous);
    if let Err(e) = extract_payload(&staging) {
        let _ = fs::remove_dir_all(&staging);
        return Err(e);
    }

    kill_under_dir(install);
    let mut swapped = swap_in(&staging, install, &previous);
    for _ in 0..5 {
        if swapped.is_ok() {
            break;
        }
        // Something reopened a file (the app relaunched by hand, an antivirus scan):
        // close what runs from the folder again and give the scan a moment.
        std::thread::sleep(std::time::Duration::from_millis(500));
        kill_under_dir(install);
        swapped = swap_in(&staging, install, &previous);
    }
    let _ = fs::remove_dir_all(&staging);
    let _ = fs::remove_dir_all(&previous);
    swapped
}

/// Update an existing install in place: lay this (newer) exe's payload over its
/// files. Shortcuts, data and prefs are kept — nothing is deleted, the payload is
/// simply overwritten, so `<install>\data` comes through the upgrade untouched and
/// the user stays signed in with their thumbnails still cached.
///
/// Two callers share this, and the only difference between them is who is holding
/// the files and who starts the app again afterwards:
///   - `<downloaded-setup>.exe --update`, launched by the running app's own updater.
///     The app quits on its way out and expects to be brought back up, so
///     `relaunch` is set.
///   - the Upgrade button, when the installer is run by hand over an install that
///     is already there. Nothing asked the app to quit, so it may well still be
///     running and holding its files; the installer stays on screen afterwards and
///     offers Launch itself.
/// Neither can assume the folder is free, so both close whatever is under it first,
/// exactly as the uninstaller does.
///
/// Returns true if the app's data had to be reset (see `carry_data`).
#[cfg(windows)]
fn upgrade_impl(install: &Path, relaunch: bool) -> Result<bool, String> {
    patch_allows(PATCH_FROM, read_installed_version().as_deref())?;
    lay_payload(install)?;
    // The data survived the overwrite by never being touched; all that is left is
    // whether this build can still read it.
    let reset = carry_data(&install_data_dir(install));
    let app_exe = install.join(APP_EXE);

    drop_superseded_exe(install);

    // The four places the old name outlived itself. The shortcuts and the Run entry
    // are refreshed rather than created: an upgrade may not hand someone a desktop
    // icon, or a program that starts with Windows, that they did not ask for.
    for lnk in [
        desktop_dir().join(format!("{APP_NAME}.lnk")),
        start_menu_dir().join(format!("{APP_NAME}.lnk")),
    ] {
        if lnk.is_file() {
            let _ = make_shortcut(&lnk, &app_exe);
        }
    }
    autostart::repoint(&app_exe);

    // Refresh the uninstaller (this newer exe) and the Add/Remove-Programs entry.
    let self_exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let uninstaller = install.join("uninstall.exe");
    let _ = fs::copy(&self_exe, &uninstaller);
    let _ = write_uninstall_entry(install, &uninstaller, &app_exe);
    // Refresh the file associations of an install that already carries them, so a
    // version that opens a type the last one could not starts being offered for it.
    // Never more than a refresh: switching them on here would give the user something
    // they were asked about and did not choose. The question is whether they opted in,
    // NOT whether the registration is currently complete, because the install this
    // exists for is exactly the one whose list is short.
    if file_assoc::opted_in() {
        let _ = file_assoc::register(&app_exe);
    }
    if relaunch {
        std::process::Command::new(&app_exe)
            .current_dir(install)
            .spawn()
            .map_err(|e| format!("relaunch: {e}"))?;
    }
    Ok(reset)
}
#[cfg(not(windows))]
fn upgrade_impl(_: &Path, _: bool) -> Result<bool, String> {
    Err("upgrade is Windows-only".into())
}

/// The install to act on, as the registry records it. Both upgrade callers are
/// pointed at the app this way, which is also how the installer knew to offer the
/// upgrade in the first place.
fn registered_install() -> Result<PathBuf, String> {
    read_install_location()
        .map(PathBuf::from)
        .ok_or_else(|| "no existing installation to update".to_string())
}

/// Upgrade the install the user already has, from the installer's own welcome
/// screen. The app is not started again here: the installer is still on screen and
/// offers Launch, the same way it does after a fresh install.
#[tauri::command]
async fn upgrade() -> Result<bool, String> {
    off_ui(|| upgrade_impl(&registered_install()?, false)).await
}

#[tauri::command]
fn launch(dir: String) -> Result<(), String> {
    let exe = PathBuf::from(dir).join(APP_EXE);
    std::process::Command::new(exe)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(windows)]
fn remove_uninstall_entry() {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let _ = hkcu.delete_subkey_all(format!(
        "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{PACK_ID}"
    ));
}
#[cfg(not(windows))]
fn remove_uninstall_entry() {}

/// The Explorer sync root: `%USERPROFILE%\Proton Photos` (must match the app's
/// `cloud_mount::sync_root_path`).
#[cfg(windows)]
fn sync_root_path() -> std::path::PathBuf {
    std::path::PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default()).join("Proton Photos")
}

/// Settle every file in the sync root into something that stands on its own,
/// BEFORE the app is closed and the registration is removed.
///
/// This has to run while the app is still alive, because a placeholder outlives
/// its provider badly: with the sync root still registered but nothing answering
/// for it, Explorer will not even delete the file, reporting that the cloud
/// provider is not running. That is what stranded undeletable files after an
/// uninstall. Each file is resolved by what it actually holds:
///   - cloud-only (RECALL_ON_DATA_ACCESS): a name with no data behind it and no
///     use without the app, so it goes.
///   - fully downloaded: reverted to an ordinary file and KEPT, so every photo the
///     user chose to keep stays right where they expect to find it.
///   - already an ordinary file, or anything that refuses to revert: left alone.
///     Never delete something that might be holding the only copy.
#[cfg(windows)]
fn detach_sync_root() {
    let root = sync_root_path();
    if !root.is_dir() {
        return;
    }
    let mut stack = vec![root];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            match entry.file_type() {
                Ok(t) if t.is_dir() => stack.push(path),
                Ok(t) if t.is_file() => detach_one(&path),
                _ => {}
            }
        }
    }
}

/// A path's attributes, read from its directory entry WITHOUT opening the file.
///
/// The app crate carries the same rule and the reason is sharper here: to the Cloud
/// Filter driver an open that is not flagged no-recall counts as reaching for the
/// data, so `std::fs::metadata` cannot be trusted against a cloud-only placeholder.
/// This walk crosses the whole sync root while the app is deliberately still alive
/// to serve hydration, and it reads the recall flag to decide what to do with each
/// file. Getting it wrong would download the user's entire library on their way out,
/// and then keep every file because nothing would read as cloud-only any more.
/// `GetFileAttributesExW` reads the directory entry and never opens the file.
#[cfg(windows)]
fn file_attributes(path: &Path) -> Option<u32> {
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
    Some(data.dwFileAttributes)
}

#[cfg(windows)]
fn detach_one(path: &Path) {
    use cloud_filter::placeholder::OpenOptions;
    const RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;

    let Some(attrs) = file_attributes(path) else {
        return;
    };
    if attrs & RECALL_ON_DATA_ACCESS != 0 {
        let _ = fs::remove_file(path); // cloud-only: nothing to lose
        return;
    }
    // It holds data, so it is safe to open: there is nothing to recall. Turn a
    // placeholder back into a plain file; leave anything else exactly as it is.
    if let Ok(ph) = OpenOptions::new().write_access().open(path) {
        if ph.info().ok().flatten().is_some() {
            let _ = fs::File::try_from(ph);
        }
    }
}

#[cfg(not(windows))]
fn detach_sync_root() {}

/// Remove the Explorer "Proton Photos" cloud-provider (sync root) registration so
/// no ghost nav-pane entry is left behind. The proper API unregister also notifies
/// the shell to drop the entry — a raw registry delete does not, which is why it
/// lingered. The folder and the user's downloaded files are intentionally kept.
#[cfg(windows)]
fn remove_sync_root_registration() {
    // Proper unregister on a fresh COM-STA thread (the main thread's apartment may
    // differ); join so it finishes before we return.
    let _ = std::thread::spawn(|| {
        use cloud_filter::root::{SecurityId, SyncRootIdBuilder};
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        }
        if let Ok(sid) = SecurityId::current_user() {
            let id = SyncRootIdBuilder::new("ProtonPhotos").user_security_id(sid).build();
            if id.is_registered().unwrap_or(false) {
                let _ = id.unregister();
            }
        }
    })
    .join();

    // Fallback: delete any leftover SyncRootManager\ProtonPhotos!* keys directly.
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let path = "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\SyncRootManager";
    if let Ok(mgr) = hkcu.open_subkey_with_flags(path, KEY_READ | KEY_WRITE) {
        let ours: Vec<String> = mgr
            .enum_keys()
            .filter_map(|k| k.ok())
            .filter(|k| k.starts_with("ProtonPhotos!"))
            .collect();
        for name in ours {
            let _ = mgr.delete_subkey_all(&name);
        }
    }
}
#[cfg(not(windows))]
fn remove_sync_root_registration() {}

/// Write the "show in File Explorer" preference the app reads at startup (a shared
/// HKCU key with the app's Settings toggle).
#[cfg(windows)]
fn set_show_in_explorer_pref(enabled: bool) {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    if let Ok((key, _)) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(app_prefs_key()) {
        let _ = key.set_value("ShowInExplorer", &u32::from(enabled));
    }
}
#[cfg(not(windows))]
fn set_show_in_explorer_pref(_: bool) {}

/// The app's own preferences, shared with its Settings screen. Named once, so the
/// uninstall cannot end up clearing a different key from the one the install wrote.
#[cfg(windows)]
fn app_prefs_key() -> String {
    format!("Software\\{PACK_ID}")
}

/// The value that tells a running app it is being uninstalled. Must match the app's
/// `cloud_mount::UNINSTALLING_VALUE`.
#[cfg(windows)]
const UNINSTALLING_VALUE: &str = "Uninstalling";

/// Tell the still-running app to stand down before the sync root is settled under it.
///
/// The settling deletes every cloud-only placeholder, and to the app's folder watcher a
/// placeholder vanishing from `Photos\` is the user deleting that photo in Explorer —
/// which, with Explorer edits on (the default), moves it to the Proton trash. A whole
/// library vanishing at once also overflowed the watcher, which answered by filling the
/// folder again while the uninstaller was emptying it. With this set, the app lets each
/// deletion through and acts on none of them. The key goes with the rest of the prefs
/// further down, once the app is closed.
#[cfg(windows)]
fn mark_uninstalling() {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    if let Ok((key, _)) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(app_prefs_key()) {
        let _ = key.set_value(UNINSTALLING_VALUE, &1u32);
    }
}
#[cfg(not(windows))]
fn mark_uninstalling() {}

#[cfg(windows)]
fn remove_app_prefs() {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let _ = RegKey::predef(HKEY_CURRENT_USER).delete_subkey_all(app_prefs_key());
}
#[cfg(not(windows))]
fn remove_app_prefs() {}

// PowerShell run by the uninstaller once it has exited. A template (not `format!`)
// so the many literal `{ }` of PowerShell stay out of Rust's brace-escaping; `__DIR__`,
// `__SELF__` and `__PID__` are substituted below. Paths are single-quote-escaped
// first, so they can never break out of the PowerShell string literal, and the match
// uses a trailing separator (`__DIR__\`) so a sibling folder with the same prefix is
// not caught.

/// Wait for the uninstaller to exit, kill any straggler under the folder (tree and
/// all), then remove the folder, retrying past the brief WebView2 file locks.
#[cfg(windows)]
const CLEANUP_TEMPLATE: &str = r#"
$log = Join-Path $env:TEMP 'pfp-uninstall.log'
function L($m) { try { Add-Content -LiteralPath $log -Value ((Get-Date -Format 'HH:mm:ss') + ' ' + $m) } catch {} }
L 'start dir=[__DIR__] self=[__SELF__] pid=__PID__'
try { Wait-Process -Id __PID__ -Timeout 60 -ErrorAction SilentlyContinue } catch {}
L 'uninstaller exited'
if ('__SELF__' -ne '') {
  for ($i = 0; $i -lt 40; $i++) {
    Remove-Item -LiteralPath '__SELF__' -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path -LiteralPath '__SELF__')) { L ('moved exe removed after ' + $i); break }
    Start-Sleep -Milliseconds 300
  }
}
if (Test-Path -LiteralPath '__DIR__') {
  L 'folder still present; killing stragglers then removing'
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('__DIR__\', 'OrdinalIgnoreCase') } |
    ForEach-Object { & taskkill /F /T /PID $_.ProcessId 2>$null }
  for ($i = 0; $i -lt 40; $i++) {
    Remove-Item -LiteralPath '__DIR__' -Recurse -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path -LiteralPath '__DIR__')) { L ('folder removed after ' + $i); break }
    Start-Sleep -Milliseconds 300
  }
} else { L 'folder already gone (removed synchronously)' }
if (Test-Path -LiteralPath '__DIR__') { L 'STILL PRESENT:'; Get-ChildItem -LiteralPath '__DIR__' -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object { L ('  left ' + $_.FullName) } }
L 'cleanup finished'
Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
"#;

/// Whether `image` (a process's full executable path) lives under `install`. Matched
/// with a trailing separator, so a sibling folder sharing the prefix is not caught, and
/// without regard to case, as Windows paths are. Pure decision (unit-tested).
fn image_is_under(image: &str, install: &Path) -> bool {
    let mut prefix = install.display().to_string().to_lowercase();
    // A `\\?\` verbatim prefix on either side would hide an otherwise equal path.
    if let Some(rest) = prefix.strip_prefix(r"\\?\") {
        prefix = rest.to_string();
    }
    if !prefix.ends_with('\\') {
        prefix.push('\\');
    }
    let image = image.to_lowercase();
    image.strip_prefix(r"\\?\").unwrap_or(&image).starts_with(&prefix)
}

/// The processes `roots` started, and theirs, down the whole tree. A parent id can be
/// a recycled one, so a child counts only if it was created after the parent it names
/// (`created` answers a process's creation time, None when it cannot be read). Pure
/// over its inputs (unit-tested).
fn process_tree(
    roots: &[u32],
    parents: &[(u32, u32)],
    created: &dyn Fn(u32) -> Option<u64>,
) -> Vec<u32> {
    let mut out: Vec<u32> = roots.to_vec();
    let mut i = 0;
    while i < out.len() {
        let parent = out[i];
        let parent_born = created(parent);
        for &(pid, ppid) in parents {
            if ppid != parent || pid == parent || out.contains(&pid) {
                continue;
            }
            let younger = match (parent_born, created(pid)) {
                (Some(p), Some(c)) => c >= p,
                _ => false,
            };
            if younger {
                out.push(pid);
            }
        }
        i += 1;
    }
    out
}

/// Close the running app right now, and wait until it is really gone: every process
/// whose image lives under the install folder, with its whole tree, which is what frees
/// the folder — the WebView2 helpers run from the Edge runtime, not from the install,
/// so a per-image kill would leave them holding files in it. This installer itself is
/// never touched.
///
/// Native, where it used to start PowerShell and query WMI: that alone took seconds on
/// an ordinary machine, ran twice or more on every upgrade, and was followed by a fixed
/// sleep that guessed at how long the handles took to go. Each process is now waited on
/// directly, so the step takes as long as the app takes to die and no longer.
#[cfg(windows)]
fn kill_under_dir(install: &Path) {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, TerminateProcess, WaitForSingleObject,
        PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
    };

    /// How long the kill waits, in all, for the processes it ended to be gone.
    const EXIT_WAIT_MS: u32 = 8_000;
    let me = std::process::id();

    // Every process and its parent, from one snapshot.
    let mut parents: Vec<(u32, u32)> = Vec::new();
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return;
        };
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        if Process32FirstW(snap, &mut entry).is_ok() {
            loop {
                parents.push((entry.th32ProcessID, entry.th32ParentProcessID));
                if Process32NextW(snap, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
    }

    let open = |pid: u32, rights| unsafe { OpenProcess(rights, false, pid).ok() };
    let image_of = |pid: u32| -> Option<String> {
        let handle = open(pid, PROCESS_QUERY_LIMITED_INFORMATION)?;
        let mut buf = [0u16; 32_768];
        let mut len = buf.len() as u32;
        let ok = unsafe { QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len) };
        unsafe {
            let _ = CloseHandle(handle);
        }
        ok.ok()?;
        Some(String::from_utf16_lossy(&buf[..len as usize]))
    };
    let created = |pid: u32| -> Option<u64> {
        let handle = open(pid, PROCESS_QUERY_LIMITED_INFORMATION)?;
        let (mut born, mut a, mut b, mut c) =
            (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
        let ok = unsafe { GetProcessTimes(handle, &mut born, &mut a, &mut b, &mut c) };
        unsafe {
            let _ = CloseHandle(handle);
        }
        ok.ok()?;
        Some(((born.dwHighDateTime as u64) << 32) | born.dwLowDateTime as u64)
    };

    let roots: Vec<u32> = parents
        .iter()
        .map(|&(pid, _)| pid)
        .filter(|&pid| pid != me && pid != 0)
        .filter(|&pid| image_of(pid).is_some_and(|image| image_is_under(&image, install)))
        .collect();
    if roots.is_empty() {
        return;
    }

    // Terminate the whole tree, keeping a handle to each so its exit can be awaited.
    let doomed: Vec<HANDLE> = process_tree(&roots, &parents, &created)
        .into_iter()
        .filter(|&pid| pid != me)
        .filter_map(|pid| {
            let handle = open(pid, PROCESS_TERMINATE | PROCESS_SYNCHRONIZE)?;
            unsafe {
                let _ = TerminateProcess(handle, 1);
            }
            Some(handle)
        })
        .collect();
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(EXIT_WAIT_MS as u64);
    for handle in doomed {
        let left = deadline.saturating_duration_since(std::time::Instant::now()).as_millis() as u32;
        unsafe {
            let _ = WaitForSingleObject(handle, left);
            let _ = CloseHandle(handle);
        }
    }
}
#[cfg(not(windows))]
fn kill_under_dir(_: &Path) {}

/// The uninstaller runs from `<install>\uninstall.exe`, so it cannot delete its
/// own directory while running. Hand that off to a detached process that waits
/// for us to exit, then removes the folder.
/// Best-effort detached step AFTER the folder has already been removed
/// synchronously: delete our own exe once we exit (it was moved to `moved_self`
/// outside the folder), and, only if a locked straggler kept the folder, retry
/// removing it. Writes a diagnostic log to the Desktop.
#[cfg(windows)]
fn spawn_detached_cleanup(install: &Path, moved_self: Option<&Path>) {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    let dir = install.display().to_string().replace('\'', "''");
    let self_str = moved_self
        .map(|p| p.display().to_string().replace('\'', "''"))
        .unwrap_or_default();
    let script = CLEANUP_TEMPLATE
        .replace("__DIR__", &dir)
        .replace("__SELF__", &self_str)
        .replace("__PID__", &std::process::id().to_string());
    let temp = std::env::temp_dir();
    let ps1 = temp.join(format!("pfp-cleanup-{}.ps1", std::process::id()));
    if std::fs::write(&ps1, script).is_err() {
        return;
    }
    // Break away from the uninstaller's job object (a Programs-list launch may put
    // it in a kill-on-close job that would kill this child on our exit); fall back
    // to a plain detached spawn where breakaway is not permitted.
    let ps1_path = ps1.clone();
    let spawn = |flags: u32| {
        std::process::Command::new("powershell")
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File"])
            .arg(&ps1_path)
            .current_dir(&temp)
            .creation_flags(flags)
            .spawn()
    };
    let _ = spawn(DETACHED_PROCESS | CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB)
        .or_else(|_| spawn(DETACHED_PROCESS | CREATE_NO_WINDOW));
}
#[cfg(not(windows))]
fn spawn_detached_cleanup(_: &Path, _: Option<&Path>) {}

/// Tauri creates `%LOCALAPPDATA%\<identifier>` on startup even though the installer
/// keeps nothing there (its WebView2 profile is redirected to TEMP). Drop that
/// folder on exit if it is empty, so no stray `eu.akoos.photos.setup` is left.
#[cfg(windows)]
fn remove_stray_data_dir(handle: &tauri::AppHandle) {
    if let Ok(dir) = handle.path().app_local_data_dir() {
        let empty = std::fs::read_dir(&dir).map(|mut r| r.next().is_none()).unwrap_or(false);
        if empty {
            let _ = std::fs::remove_dir(&dir);
        }
    }
}

fn self_install_dir() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    exe.parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "no parent dir".to_string())
}

/// Uninstall the copy this exe lives in (the installed `uninstall.exe`).
#[tauri::command]
async fn uninstall() -> Result<(), String> {
    off_ui(|| uninstall_impl(&self_install_dir()?)).await
}

/// Uninstall an existing install located via the registry — used when the
/// INSTALLER is launched while the app is already installed.
#[tauri::command]
async fn uninstall_existing() -> Result<(), String> {
    off_ui(|| {
        let loc = read_install_location().ok_or_else(|| "no existing installation found".to_string())?;
        uninstall_impl(Path::new(&loc))
    })
    .await
}

/// Whether two paths name the same directory. Canonicalised, so path-form
/// differences (verbatim prefix, short names, a trailing separator) don't matter.
fn same_dir(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// May this folder be removed? Pure decision (unit-tested), given the folder and
/// what the registry records as the installed location.
///
/// Nothing else establishes that the folder is an installation at all. `--uninstall`
/// is honoured on any executable name and a plain double-click on anything called
/// `uninstall.exe` uninstalls too, so the folder handed to `uninstall_impl` is
/// simply wherever that exe happens to sit: a Downloads folder, a Desktop. What
/// follows takes the whole contents of it, and not by way of the recycle bin.
///
/// Two things are asked of it, and both have to hold:
///   - it carries what an install lays down: the app's executable with the runtime
///     beneath it. Either name alone is common enough to turn up by accident, and
///     `uninstall.exe` proves nothing at all, since a copy of it is exactly what
///     gets double-clicked somewhere it does not belong.
///
///     Either executable name counts, because an install made before the rename is
///     still an install, and it is the one most in need of being removable. Insisting
///     on the current name would strand exactly those folders: no uninstaller would
///     agree to touch them, from Add/Remove Programs or anywhere else.
///   - the registry does not record the install as living somewhere else. A folder
///     carrying the layout while the app is installed elsewhere is a copy of one,
///     and removing it would still take the real install's shortcuts, its
///     Add/Remove-Programs entry and the Explorer registration with it. A missing
///     entry, or one naming a folder that is gone, is not held against this folder:
///     an uninstall that failed after removing the entry has to stay repeatable.
fn check_installation(dir: &Path, registered: Option<&Path>) -> Result<(), &'static str> {
    let carries_app = dir.join(APP_EXE).is_file() || dir.join(LEGACY_APP_EXE).is_file();
    if !carries_app || !dir.join("resources").join("sidecar.exe").is_file() {
        return Err("This folder is not a Photos for Proton installation, so nothing was removed.");
    }
    match registered {
        Some(other) if other.exists() && !same_dir(other, dir) => {
            Err("This is a copy, not the installed app, so nothing was removed.")
        }
        _ => Ok(()),
    }
}

/// Delete everything inside the install folder EXCEPT the running uninstaller's own
/// exe (a process cannot delete its own image while running). Retries briefly for
/// files a just-killed process is still releasing. This removes the bulk — the app,
/// the sidecar, and all the encrypted data/thumbnails — synchronously, so removing
/// the user's data never depends on the detached post-exit cleanup succeeding.
fn delete_contents_except_self(install: &Path) {
    let self_name = std::env::current_exe().ok().and_then(|p| p.file_name().map(|n| n.to_owned()));
    for _ in 0..12 {
        let Ok(entries) = fs::read_dir(install) else {
            return; // folder already gone
        };
        let mut remaining = 0;
        for entry in entries.flatten() {
            if Some(entry.file_name()) == self_name {
                continue; // our own running image
            }
            let path = entry.path();
            let removed = if path.is_dir() {
                fs::remove_dir_all(&path)
            } else {
                fs::remove_file(&path)
            };
            if removed.is_err() {
                remaining += 1;
            }
        }
        if remaining == 0 {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
    }
}

/// Move the running uninstaller's own exe out of the install folder to TEMP, so the
/// folder can then be removed while we keep running. Windows permits renaming a
/// running executable on the same volume. Returns the new path, or None if our exe
/// is not in this folder (the "installer launched from Downloads" uninstall path).
fn move_self_out(install: &Path) -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let parent = exe.parent()?;
    if !same_dir(parent, install) {
        return None;
    }
    let dest = std::env::temp_dir().join(format!("pfp-uninstall-old-{}.exe", std::process::id()));
    fs::rename(&exe, &dest).ok().map(|_| dest)
}

fn uninstall_impl(install: &Path) -> Result<(), String> {
    // Before anything at all is touched, and there is a great deal of it: the sync
    // root walk deletes placeholders, the kill takes down whatever runs from the
    // folder, and the folder's contents go without passing through the recycle bin.
    check_installation(install, read_install_location().map(PathBuf::from).as_deref())?;
    // FIRST, while the app is still running and can still answer for its own
    // placeholders: resolve the sync root. After the kill below there is no provider
    // left, and a placeholder without one cannot even be deleted, which is what used
    // to strand undeletable files in the folder after an uninstall. The app is told
    // first, so it serves those deletions without reading them as the user's.
    mark_uninstalling();
    detach_sync_root();
    // Close the running app (its WebView2 children hold files in the folder). The
    // kill waits for each process to be gone, so their handles are released here.
    kill_under_dir(install);
    // Shortcuts.
    let _ = fs::remove_file(desktop_dir().join(format!("{APP_NAME}.lnk")));
    let _ = fs::remove_file(start_menu_dir().join(format!("{APP_NAME}.lnk")));
    // Starting with Windows. Left behind, it points at an exe that is about to stop
    // existing, and every login after this one opens an error about it.
    autostart::remove();
    // Add/Remove Programs entry.
    remove_uninstall_entry();
    // The app's own preferences. Left behind, they silently pre-configure whatever
    // is installed next, with settings from a version nobody remembers choosing.
    remove_app_prefs();
    // The "Open with" entries and the ProgId behind them. Left in place they would go
    // on offering this app for the user's photos, pointing at an exe that is gone.
    file_assoc::unregister();
    // The Explorer "Proton Photos" nav-pane registration (the folder + the user's
    // downloaded files are kept, as OneDrive does on uninstall).
    remove_sync_root_registration();
    // Legacy data location (pre one-folder builds).
    let _ = fs::remove_dir_all(data_dir());
    // Remove the bulk NOW, synchronously: the app, the sidecar, and all the
    // encrypted data/thumbnails go immediately, so it never depends on the detached
    // cleanup. Then move our own running exe out of the folder (Windows allows
    // renaming a running exe on the same volume) and drop the now-empty folder, so
    // the whole folder is gone synchronously rather than via a fragile post-exit step.
    delete_contents_except_self(install);
    let moved = move_self_out(install);
    let _ = fs::remove_dir(install);
    // Best-effort: delete the moved exe once we exit, and retry the folder only if a
    // locked straggler kept it. Low stakes now — the data is already gone.
    spawn_detached_cleanup(install, moved.as_deref());
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Keep the installer's own WebView2 profile out of %LOCALAPPDATA% so it does
    // not leave an `eu.akoos.photos.setup` folder behind; the installer is
    // short-lived, so a temp folder is fine.
    #[cfg(windows)]
    {
        let webview = std::env::temp_dir().join("pfp-setup-webview");
        let _ = std::fs::create_dir_all(&webview);
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &webview);
    }

    // Headless mode for scripted installs / uninstalls (and automated testing):
    //   setup.exe --silent            install to the default location + shortcuts
    //   uninstall.exe --uninstall --silent   remove everything, no prompt
    let args: Vec<String> = std::env::args().collect();
    // The running app's updater: it has already quit, so bring it back up when the
    // payload is in place. The window below shows this while it runs.
    if is_update() {
        *UPDATE_STATE.lock().unwrap() = "running".into();
        std::thread::spawn(|| {
            let result = registered_install().and_then(|d| {
                // Refused before a file was touched: the app that quit for this comes
                // back as it was.
                if let Err(e) = patch_allows(PATCH_FROM, read_installed_version().as_deref()) {
                    let _ = std::process::Command::new(d.join(APP_EXE)).current_dir(&d).spawn();
                    return Err(e);
                }
                upgrade_impl(&d, true)
            });
            let ok = result.is_ok();
            *UPDATE_STATE.lock().unwrap() = match result {
                Ok(_) => "done".into(),
                Err(e) => format!("failed: {e}"),
            };
            // The window closes itself once it has said so; this is for one that never
            // drew, so a finished update never leaves an installer behind.
            if ok {
                std::thread::sleep(std::time::Duration::from_secs(8));
                std::process::exit(0);
            }
        });
    }
    if args.iter().any(|a| a == "--silent") {
        let result = if is_uninstall() {
            self_install_dir().and_then(|d| uninstall_impl(&d))
        } else {
            // File associations stay off, as they do on the options screen: they are
            // the one choice here that changes how the machine opens someone else's
            // files, and a scripted install has nobody to ask.
            install_impl(default_dir_impl(), true, true, true, false)
        };
        if let Err(e) = result {
            eprintln!("setup error: {e}");
            std::process::exit(1);
        }
        return;
    }

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Safety net: the window starts hidden and the frontend reveals it
            // once painted. If that never happens (a load failure), show it anyway
            // after a moment so the installer is never invisible.
            // An update only says what it is doing, so it gets a small window of its own.
            if is_update() {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.set_size(tauri::LogicalSize::new(440.0, 300.0));
                    let _ = w.center();
                }
            }
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(4));
                if let Some(w) = handle.get_webview_window("main") {
                    let _ = w.show();
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            mode,
            default_dir,
            install,
            upgrade,
            launch,
            uninstall,
            uninstall_existing,
            existing_install,
            show_window,
            update_state
        ])
        .build(tauri::generate_context!())
        .expect("error while running the installer");

    app.run(|_handle, event| {
        // Clean up the empty identifier folder Tauri leaves in %LOCALAPPDATA% once
        // the installer exits, so nothing is scattered outside the install folder.
        if let tauri::RunEvent::Exit = event {
            #[cfg(windows)]
            remove_stray_data_dir(_handle);
        }
    });
}
