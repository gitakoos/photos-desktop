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

// Which files the app is offered for in Explorer, and the registry entries that say so.
//
// The installer compiles this same file rather than keeping a copy of it, the way it
// already does with `data_format.rs`. One copy matters more here than almost anywhere
// else, because the two ends are not symmetric: the installer can only ever put the
// registration IN, and the app's Settings switch is the only thing that can take it
// back out. Two lists that drifted apart would leave the installer claiming a type
// Settings then had no idea to remove, and two identities that drifted apart would
// leave the switch reading off while the machine carries the entries.
//
// Everything written here lives under `HKCU\Software\Classes`, the per-user half of
// `HKEY_CLASSES_ROOT`, which is what keeps the whole feature clear of administrator
// rights. Nothing goes to HKLM, and nothing claims the DEFAULT handler for a type:
// that choice is sealed behind a hash Windows verifies and belongs to the user.
//
// The two callers know different things, so the API asks each of them only for what it
// has. `register` names the executable outright: the installer passes the app
// inside the folder it has just written, the app passes its own `current_exe()`, and
// neither has to reconstruct the other's answer. `unregister` and `is_registered` take
// nothing at all, because both are keyed by the ProgId and not by a path, so the app
// can switch the association off without knowing where anything was installed.

use std::path::Path;

/// The name Explorer shows the app under, and the name the Start Menu and desktop
/// shortcuts carry.
pub const APP_NAME: &str = "Photos for Proton";

/// The install's stable identity: the Add/Remove-Programs key, the preferences key,
/// and the stem the ProgId below is built from. Declared here, with the registration
/// that depends on it, so an install cannot register under one name and be uninstalled
/// or switched off under another.
pub const PACK_ID: &str = "PhotosForProton";

/// The app's executable, as it sits in the install folder.
///
/// Here beside the other identity constants because the installer writes this name
/// into four separate places that outlive it: two shortcuts, the Run entry, and the
/// association's open command. One of them naming a different file from the rest is
/// not an error anything reports, it is a shortcut that quietly launches nothing.
pub const APP_EXE: &str = "photosforproton.exe";

/// What the executable was called before it had a name worth showing. Still recognised
/// so that an install made by an older build is one this build can upgrade and remove:
/// the folder is identified by what is in it, and for a while that is either name.
pub const LEGACY_APP_EXE: &str = "app.exe";

/// The file types the app is offered for in Explorer's "Open with".
///
/// An association is a promise to put the file on screen, so this follows what the app
/// can actually show: what the webview draws unaided (`sidecar/proton/download.ts`), the
/// video containers its engine plays, and what it hands to Windows' own decoder.
///
/// TIFF is in because Windows decodes it out of the box. HEIC is in although it needs
/// Microsoft's HEIF and HEVC support, which most machines that take such photos already
/// have, and the viewer says so plainly when they do not.
///
/// Left out on purpose: DNG and the camera raw formats, which need the Raw Image
/// Extension and whose owners have a dedicated editor associated anyway; Matroska (the
/// engine has no demuxer for it at all, so it could only ever fail); 3GP (the H.263 and
/// AMR streams those almost always carry are not playable either); and SVG, which the
/// viewer refuses by design as the one image type that carries markup.
const MEDIA_EXTENSIONS: &[&str] = &[
    ".jpg", ".jpeg", ".jpe", ".png", ".apng", ".gif", ".webp", ".avif", ".bmp", ".tif", ".tiff",
    ".heic", ".heif", ".mp4", ".m4v", ".mov", ".webm",
];

/// The name Explorer knows the app by when it offers to open a file with it.
///
/// One id covers every type the app opens. A photo library is a single viewer, and a
/// ProgId per extension would only multiply what has to be taken back out again.
fn prog_id() -> String {
    format!("{PACK_ID}.Media")
}

/// A key under this install's ProgId.
fn prog_id_key(sub: &str) -> String {
    let root = format!("Software\\Classes\\{}", prog_id());
    if sub.is_empty() {
        root
    } else {
        format!("{root}\\{sub}")
    }
}

/// Where an extension lists the ProgIds Explorer may offer for it.
fn open_with_key(ext: &str) -> String {
    format!("Software\\Classes\\{ext}\\OpenWithProgids")
}

/// The verb's command line. Both halves are quoted: the install folder sits under the
/// user's profile, so the path carries whatever their account is called, and a photo
/// they picked can be anywhere with any name in it.
fn open_command(app_exe: &Path) -> String {
    format!("\"{}\" \"%1\"", app_exe.display())
}

/// The app's own icon, which is the first one in its executable.
fn icon_value(app_exe: &Path) -> String {
    format!("{},0", app_exe.display())
}

/// Tell Explorer the associations moved, so the app turns up in "Open with" (or stops
/// turning up) straight away rather than after the next sign-out. The Settings switch
/// depends on this far more than the installer did: a user who flips it expects to find
/// the change in the context menu, not after signing out.
#[cfg(windows)]
fn notify_associations_changed() {
    use windows::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST};
    unsafe { SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None) };
}
#[cfg(not(windows))]
fn notify_associations_changed() {}

/// Offer the app for photos and videos in Explorer's "Open with", at the user's asking.
///
/// The "Open with" list is the whole of what this may claim. Which app opens a file BY
/// DEFAULT is the user's choice and Windows keeps it that way: the choice lives in
/// `UserChoice` behind a hash it verifies, so writing one is both hostile and
/// short-lived, broken by the next servicing update. Nothing here touches it. Someone
/// who wants this app to be the default sets it in Settings, and nowhere else.
///
/// Every write names a key or a value outright, so running this again lands on exactly
/// the same shape: an upgrade, a second install over the first, or the Settings switch
/// flipped on twice all refresh the registration rather than adding a second copy of
/// it. That matters most for the per-extension entries, where the value's NAME is the
/// ProgId, which is what makes a repeat write an overwrite instead of a duplicate.
///
/// `app_exe` is the executable to open the file with. It is asked for rather than
/// worked out here because only the caller can know it: the installer is registering a
/// folder it has just written and may never have run, and the app is registering
/// itself.
#[cfg(windows)]
pub fn register(app_exe: &Path) -> Result<(), String> {
    use winreg::enums::{RegType, HKEY_CURRENT_USER};
    use winreg::{RegKey, RegValue};

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let write = |path: String, name: &str, value: String| -> Result<(), String> {
        let (key, _) = hkcu.create_subkey(&path).map_err(|e| e.to_string())?;
        key.set_value(name, &value).map_err(|e| e.to_string())
    };
    // The name to show the app under, spelled out rather than left to be read off the
    // executable's filename, which carries no spaces and no capitals and would read as
    // an odd thing to be offered.
    // `FriendlyAppName` names the APP; the type keeps its own name, which is why no
    // `FriendlyTypeName` and no default value are written here. Set, they would replace
    // "PNG File" in Explorer's Type column for anyone who made this app their default,
    // and an association is no reason to take a file type's name off them.
    write(prog_id_key(""), "FriendlyAppName", APP_NAME.to_string())?;
    write(prog_id_key("DefaultIcon"), "", icon_value(app_exe))?;
    write(prog_id_key("shell\\open\\command"), "", open_command(app_exe))?;

    // An empty REG_NONE is what Explorer itself writes here; the name carries the
    // meaning, the data is not read.
    let listed = RegValue { vtype: RegType::REG_NONE, bytes: Vec::new() };
    for ext in MEDIA_EXTENSIONS {
        let (key, _) = hkcu.create_subkey(open_with_key(ext)).map_err(|e| e.to_string())?;
        key.set_raw_value(prog_id(), &listed).map_err(|e| e.to_string())?;
    }
    notify_associations_changed();
    Ok(())
}
#[cfg(not(windows))]
pub fn register(_: &Path) -> Result<(), String> {
    Ok(())
}

/// What one boolean is allowed to mean over a registration made of many entries.
///
/// The registration is the ProgId plus one entry per extension, so a single answer has
/// to stand for either ALL of them or ANY of them. The two part company the moment the
/// registry is uneven, which is reachable: a write that failed partway, an entry a user
/// cleaned out by hand, or an install left by a build that claimed a shorter list than
/// this one does.
///
/// It means ALL, because that is the direction whose wrong answer can be seen and
/// undone. Answering "any" would read ON over a registration missing half its types,
/// which is a fault with no symptom and no cure the switch can offer, the switch being
/// on already. Answering "all" reads OFF over that same registration and so understates
/// what the machine carries, but the understatement is visible and switching on IS the
/// repair: `register` writes every key and value the current list names whatever was
/// there before, so an uneven registry is always one toggle away from whole.
#[cfg(windows)]
fn registration_is_complete(prog_id_present: bool, mut listed: impl Iterator<Item = bool>) -> bool {
    prog_id_present && listed.all(|found| found)
}

/// Whether Explorer offers this app for photos and videos, read from the registry
/// itself and true only when the registration is COMPLETE (see above).
///
/// Read every time rather than remembered, because the app is not the only thing that
/// writes these keys: the installer's checkbox does, an install from before the switch
/// existed carries whatever was chosen back then, and they are plain HKCU keys anyone
/// can delete by hand. A stored answer would go on reporting whichever of those it last
/// heard about.
#[cfg(windows)]
pub fn is_registered() -> bool {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let id = prog_id();
    registration_is_complete(
        hkcu.open_subkey(prog_id_key("shell\\open\\command")).is_ok(),
        MEDIA_EXTENSIONS.iter().map(|ext| {
            hkcu.open_subkey(open_with_key(ext))
                .map(|key| key.get_raw_value(&id).is_ok())
                .unwrap_or(false)
        }),
    )
}
#[cfg(not(windows))]
pub fn is_registered() -> bool {
    false
}

/// Whether this machine was ever asked to carry the registration, complete or not.
///
/// A different question from `is_registered`, and the upgrade path is where the
/// difference matters: it refreshes an install that already carries the offer and must
/// never switch one on for a user who declined, so what it needs to know is the user's
/// answer, not the registry's tidiness. Asking for completeness there would refuse to
/// refresh precisely the install a refresh exists for, the one registered by a build
/// that claimed fewer types than this one does.
///
/// The ProgId is the marker for it because `register` writes it before the
/// per-extension entries and `unregister` removes it after them, so it is present
/// whenever any part of the registration is.
#[cfg(windows)]
pub fn opted_in() -> bool {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(prog_id_key("shell\\open\\command"))
        .is_ok()
}
#[cfg(not(windows))]
pub fn opted_in() -> bool {
    false
}

/// A key holding nothing at all: no values (the unnamed default counts), no subkeys.
#[cfg(windows)]
fn key_is_empty(key: &winreg::RegKey) -> bool {
    key.enum_values().next().is_none() && key.enum_keys().next().is_none()
}

/// Take the registration back out.
///
/// A ProgId outliving its registration is worse than never having written one: Explorer
/// goes on offering the app for photos, and after an uninstall the command behind the
/// offer names an exe that is gone. So the ProgId goes, and with it every extension's
/// offer of it.
///
/// A type the user went and made the DEFAULT is the one thing that cannot be tidied
/// directly. Windows sealed that choice with a hash of its own and it is not this
/// app's to rewrite. Removing the ProgId is what settles it: the recorded choice no
/// longer resolves to anything, so Windows falls back to asking which app to use the
/// next time one of those files is opened, which is the same question it asks for a
/// type nothing is registered for.
#[cfg(windows)]
pub fn unregister() {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    for ext in MEDIA_EXTENSIONS {
        let listing = open_with_key(ext);
        // Only ever this ProgId's own value: the same key carries every other app's
        // offer for that type, and none of those are this app's to remove.
        let emptied = match hkcu.open_subkey_with_flags(&listing, KEY_READ | KEY_WRITE) {
            Ok(key) => {
                let _ = key.delete_value(prog_id());
                key_is_empty(&key)
            }
            Err(_) => false,
        };
        if !emptied {
            continue;
        }
        // Nothing left in it, so it is a container this app created. The extension key
        // above it goes the same way and under the same rule, never otherwise: it is
        // also where a per-user default association for that type would be sitting.
        let _ = hkcu.delete_subkey(&listing);
        let ext_key = format!("Software\\Classes\\{ext}");
        if hkcu.open_subkey(&ext_key).map(|k| key_is_empty(&k)).unwrap_or(false) {
            let _ = hkcu.delete_subkey(&ext_key);
        }
    }
    let _ = hkcu.delete_subkey_all(prog_id_key(""));
    notify_associations_changed();
}
#[cfg(not(windows))]
pub fn unregister() {}

#[cfg(test)]
mod tests {
    use super::*;

    /// Explorer matches these key names literally, so `Software\Classes\JPG` is simply
    /// a different key from `Software\Classes\.jpg` and would register nothing.
    #[test]
    fn extensions_are_lowercase_dotted_and_listed_once() {
        let mut seen = std::collections::HashSet::new();
        for ext in MEDIA_EXTENSIONS {
            assert!(ext.starts_with('.') && ext.len() > 1, "{ext} is not an extension");
            assert_eq!(*ext, ext.to_lowercase(), "{ext} is not lowercase");
            assert!(seen.insert(*ext), "{ext} is listed twice");
        }
    }

    /// An association is a promise to put the file on screen, so the list is the
    /// viewer's and not the uploader's, which is the wider of the two. A type the app
    /// can only fail to open would still be offered for it in Explorer, and picking it
    /// would get the user nothing.
    #[test]
    fn only_types_the_viewer_can_show_are_claimed() {
        for shown in [".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".bmp", ".mp4", ".mov"] {
            assert!(MEDIA_EXTENSIONS.contains(&shown), "{shown} should be offered");
        }
        // Reached through Windows' own decoder rather than the webview, so they are as
        // openable as the rest and belong here just the same.
        for decoded in [".tif", ".tiff", ".heic", ".heif"] {
            assert!(MEDIA_EXTENSIONS.contains(&decoded), "{decoded} should be offered");
        }
        // Undrawable, or drawable only for someone who already owns a better tool for
        // it: raw needs an extension Windows does not ship, Matroska has no demuxer,
        // 3GP neither for what it carries. SVG the viewer refuses outright.
        for absent in [".dng", ".cr2", ".nef", ".arw", ".mkv", ".3gp", ".svg"] {
            assert!(!MEDIA_EXTENSIONS.contains(&absent), "{absent} must not be offered");
        }
    }

    /// The ProgId is built off the same name the Add/Remove-Programs entry uses, so an
    /// install cannot register under one identity and be uninstalled under another,
    /// which is exactly how a dead ProgId gets left behind offering a missing app.
    #[test]
    fn the_prog_id_is_built_off_the_pack_id() {
        assert_eq!(prog_id(), format!("{PACK_ID}.Media"));
        // It is read as a key name, so nothing in it may look like a path.
        assert!(!prog_id().contains('\\'), "{}", prog_id());
    }

    /// Every key this writes is under `Software\Classes`, the per-user half of
    /// `HKEY_CLASSES_ROOT`. That is what keeps the registration out of HKLM, which is
    /// what keeps both the installer and the Settings switch from having to ask for
    /// administrator rights.
    #[test]
    fn every_registry_path_stays_in_the_user_hive() {
        assert_eq!(prog_id_key(""), format!("Software\\Classes\\{}", prog_id()));
        assert_eq!(
            prog_id_key("shell\\open\\command"),
            format!("Software\\Classes\\{}\\shell\\open\\command", prog_id())
        );
        assert_eq!(open_with_key(".jpg"), "Software\\Classes\\.jpg\\OpenWithProgids");
        for ext in MEDIA_EXTENSIONS {
            let path = open_with_key(ext);
            assert!(path.starts_with("Software\\Classes\\"), "{path}");
            assert!(!path.to_uppercase().contains("HKEY_LOCAL_MACHINE"), "{path}");
        }
    }

    /// The install folder sits under the user's profile, so the path carries whatever
    /// their account is called, spaces and all. Unquoted, `C:\Users\Ann Lee\...` reaches
    /// the app as two arguments and the photo never opens.
    #[test]
    fn the_verb_quotes_the_exe_and_the_file() {
        let exe = Path::new("C:\\Users\\Ann Lee\\AppData\\Local\\Photos for Proton\\photosforproton.exe");
        assert_eq!(
            open_command(exe),
            "\"C:\\Users\\Ann Lee\\AppData\\Local\\Photos for Proton\\photosforproton.exe\" \"%1\""
        );
        assert_eq!(
            icon_value(exe),
            "C:\\Users\\Ann Lee\\AppData\\Local\\Photos for Proton\\photosforproton.exe,0"
        );
    }

    /// The switch is one two-state control over a dozen and more registry entries, and
    /// this is where that is decided: it reads registered only when EVERY entry the
    /// current list names is there. A registration missing a type has to read as off,
    /// because switching on is the repair for it and a switch already reading on offers
    /// the user nothing to press.
    #[test]
    #[cfg(windows)]
    fn a_registration_missing_a_type_does_not_read_as_registered() {
        let all_listed = || MEDIA_EXTENSIONS.iter().map(|_| true);
        assert!(registration_is_complete(true, all_listed()));

        // One type short, which is what a half-written registration and an install from
        // a build with a shorter list both look like from here.
        let mut one_missing: Vec<bool> = MEDIA_EXTENSIONS.iter().map(|_| true).collect();
        one_missing[0] = false;
        assert!(!registration_is_complete(true, one_missing.into_iter()));

        // The reading "any" would have given: registered, on the strength of a single
        // entry, with every other type quietly opening nothing.
        let mut only_the_first: Vec<bool> = MEDIA_EXTENSIONS.iter().map(|_| false).collect();
        only_the_first[0] = true;
        assert!(!registration_is_complete(true, only_the_first.into_iter()));

        // The ProgId carries the verb that actually opens the file, so every extension
        // entry on the machine is worth nothing without it.
        assert!(!registration_is_complete(false, all_listed()));
    }

    /// The installer writes one exe and the app writes another, so the verb has to
    /// follow whichever it was handed. It reading the same either way is what would
    /// leave a dev build, or a second install, pointing Explorer at a stale exe.
    #[test]
    fn the_verb_follows_the_executable_it_was_given() {
        let installed = Path::new("C:\\Users\\Ann Lee\\AppData\\Local\\Photos for Proton\\photosforproton.exe");
        let elsewhere = Path::new("D:\\builds\\photosforproton.exe");
        assert_ne!(open_command(installed), open_command(elsewhere));
        assert!(open_command(elsewhere).starts_with("\"D:\\builds\\photosforproton.exe\""));
    }
}
