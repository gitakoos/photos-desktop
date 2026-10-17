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

//! Starting with Windows, as one HKCU Run entry.
//!
//! The Run key rather than a Startup-folder shortcut or a scheduled task: it is the
//! one of the three that needs no elevation, no file left in a folder the user browses,
//! and no separate object to keep in step with the install. Per user (HKCU), because
//! the whole app is per user, and a machine-wide entry would start it for accounts that
//! never installed it.
//!
//! The entry launches with `--background`, which is the only reason this is worth
//! having: a login that opened the window every time would be a worse deal than not
//! starting at all. Uninstalling takes the entry with it, which is why the removal half
//! is `pub` and compiled into the installer too. A Run entry outliving its exe is a
//! login-time error dialog for something the user believes they removed.

#[cfg(windows)]
const RUN_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";

/// Matches the app's display name, so the entry is recognisable in Task Manager's
/// startup list rather than reading as something the user did not install.
#[cfg(windows)]
pub const RUN_VALUE: &str = "Photos for Proton";

/// The flag the Run entry passes, and the one the app looks for to stay in the tray.
pub const BACKGROUND_FLAG: &str = "--background";

/// The command line a Run entry should hold for `exe`.
///
/// Quoted whether or not the path needs it: the default install folder does not
/// contain a space, but a user-chosen one can, and an unquoted path with a space is
/// read by Windows as a different program with arguments.
#[cfg(windows)]
pub fn run_command(exe: &std::path::Path) -> String {
    format!("\"{}\" {}", exe.display(), BACKGROUND_FLAG)
}

/// Whether the app is set to start with Windows.
#[cfg(windows)]
pub fn enabled() -> bool {
    winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
        .open_subkey(RUN_KEY)
        .and_then(|k| k.get_value::<String, _>(RUN_VALUE))
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false)
}
/// Whether the app is set to start at sign-in: what was last asked of the portal and
/// granted. The entry itself is written on the host, where the sandbox cannot read it.
#[cfg(not(windows))]
pub fn enabled() -> bool {
    linux::flag("autostart").unwrap_or(false)
}

/// Linux: whether closing the window leaves the app running, so the file-manager drive
/// keeps working. On unless turned off. (Windows always goes to the tray.)
#[cfg(not(windows))]
pub fn keep_running() -> bool {
    linux::flag("background").unwrap_or(true)
}

/// Turn running on after the window closes on or off. Turning it on tells the desktop,
/// through the same portal, that the app may run with no window.
#[cfg(not(windows))]
pub fn set_keep_running(on: bool) -> Result<(), String> {
    if on {
        let (background, _) = linux::request_background(enabled())?;
        if !background {
            return Err("the desktop did not allow running in the background".into());
        }
    }
    linux::set_flag("background", on)
}

/// Tell the desktop, through the portal, that the app may run with no window, and give it
/// the line it shows under the app among its background apps (GNOME's Background Apps).
/// Blocking; nothing depends on the answer.
#[cfg(not(windows))]
pub fn declare_background(status: &str) {
    let _ = linux::request_background(enabled());
    let _ = linux::set_status(status);
}

/// Write or remove the entry. Always writes the running exe's own path, so a
/// reinstall into a different folder corrects itself the next time this is touched.
#[cfg(windows)]
pub fn set(on: bool) -> Result<(), String> {
    let key = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
        .create_subkey(RUN_KEY)
        .map_err(|e| e.to_string())?
        .0;
    if !on {
        // Absent already is the state being asked for, not a failure.
        return match key.delete_value(RUN_VALUE) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        };
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    key.set_value(RUN_VALUE, &run_command(&exe))
        .map_err(|e| e.to_string())
}
/// Ask the desktop to start the app at sign-in, or to stop. Blocking: the desktop may
/// ask the user first.
#[cfg(not(windows))]
pub fn set(on: bool) -> Result<(), String> {
    let (_, granted) = linux::request_background(on)?;
    if on && !granted {
        return Err("the desktop did not allow starting at sign-in".into());
    }
    linux::set_flag("autostart", on)
}

/// Running in the background and starting at sign-in on Linux, through the XDG
/// Background portal.
///
/// A Flatpak cannot write `~/.config/autostart` itself, and should not: the portal is
/// the desktop's own way in, it writes the entry (as `flatpak run` of this app) and takes
/// it away again, and a desktop that wants the user's say asks them. The app starts with
/// its window, not hidden: there is no tray to wait in, and the vault needs unlocking
/// before anything works anyway.
#[cfg(not(windows))]
mod linux {
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

    use dbus::arg::{PropMap, RefArg, Variant};
    use dbus::blocking::Connection;
    use dbus::message::MessageType;

    /// Where a flag is kept, in the app's own config directory.
    fn flag_path(name: &str) -> Option<PathBuf> {
        let base = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))?;
        Some(base.join("photosforproton").join(name))
    }

    /// A stored on/off answer, or `None` when it was never set.
    pub fn flag(name: &str) -> Option<bool> {
        let text = std::fs::read_to_string(flag_path(name)?).ok()?;
        Some(text.trim() == "1")
    }

    pub fn set_flag(name: &str, on: bool) -> Result<(), String> {
        let Some(path) = flag_path(name) else { return Ok(()) };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        std::fs::write(path, if on { "1" } else { "0" }).map_err(|e| e.to_string())
    }

    /// The portal's status line for this app, shown under it among the background apps;
    /// at most 96 characters, as the portal takes.
    pub fn set_status(message: &str) -> Result<(), String> {
        let conn = Connection::new_session().map_err(|e| e.to_string())?;
        let proxy = conn.with_proxy(
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            Duration::from_secs(5),
        );
        let mut options: PropMap = HashMap::new();
        let message: String = message.chars().take(96).collect();
        options.insert("message".into(), Variant(Box::new(message)));
        proxy
            .method_call::<(), _, _, _>("org.freedesktop.portal.Background", "SetStatus", (options,))
            .map_err(|e| e.to_string())
    }

    /// The portal's answer to `RequestBackground`: whether the app may run with no
    /// window, and whether it starts at sign-in, as the desktop now has them.
    pub fn request_background(autostart: bool) -> Result<(bool, bool), String> {
        let on = autostart;
        let conn = Connection::new_session().map_err(|e| e.to_string())?;
        // The request's object path is predictable from our bus name and a token of our
        // choosing, so its Response can be listened for before the call is even made.
        static REQUESTS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = REQUESTS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let token = format!("pfp_background_{}_{n}", std::process::id());
        let sender = conn.unique_name().to_string().trim_start_matches(':').replace('.', "_");
        let request = format!("/org/freedesktop/portal/desktop/request/{sender}/{token}");
        conn.add_match_no_cb(&format!(
            "type='signal',interface='org.freedesktop.portal.Request',member='Response',path='{request}'"
        ))
        .map_err(|e| e.to_string())?;

        let mut options: PropMap = HashMap::new();
        let mut put = |key: &str, value: Box<dyn RefArg>| {
            options.insert(key.to_string(), Variant(value));
        };
        put("handle_token", Box::new(token.clone()));
        put("reason", Box::new("Keep Proton Photos in Files working, and start at sign-in if chosen".to_string()));
        put("autostart", Box::new(on));
        put("commandline", Box::new(vec!["photosforproton".to_string()]));
        put("dbus-activatable", Box::new(false));

        let proxy = conn.with_proxy(
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            Duration::from_secs(10),
        );
        let _: (dbus::Path<'static>,) = proxy
            .method_call("org.freedesktop.portal.Background", "RequestBackground", ("", options))
            .map_err(|e| e.to_string())?;

        // A desktop that asks the user waits on them, so this waits a while too.
        let deadline = Instant::now() + Duration::from_secs(120);
        while Instant::now() < deadline {
            let Some(msg) = conn
                .channel()
                .blocking_pop_message(Duration::from_millis(500))
                .map_err(|e| e.to_string())?
            else {
                continue;
            };
            let ours = msg.msg_type() == MessageType::Signal
                && msg.member().is_some_and(|m| &*m == "Response")
                && msg.path().is_some_and(|p| &*p == request.as_str());
            if !ours {
                continue;
            }
            let (response, results): (u32, PropMap) = msg.read2().map_err(|e| e.to_string())?;
            // 0 is success; 1 the user said no; 2 anything else.
            if response != 0 {
                return Ok((false, false));
            }
            let answer = |key: &str, asked: bool| {
                dbus::arg::prop_cast::<bool>(&results, key).copied().unwrap_or(asked)
            };
            return Ok((answer("background", true), answer("autostart", on)));
        }
        Err("the desktop did not answer".into())
    }
}

/// Point an existing entry at `exe` if it names anything else.
///
/// Only ever corrects an entry that is already there: an install whose executable
/// moved or was renamed must keep starting with Windows, but one that was never asked
/// to start must not begin to. The installer calls this during an upgrade, where the
/// running process is the installer and so cannot ask itself where the app now lives.
#[cfg(windows)]
pub fn repoint(exe: &std::path::Path) {
    if !enabled() {
        return;
    }
    let want = run_command(exe);
    let key = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER).open_subkey_with_flags(
        RUN_KEY,
        winreg::enums::KEY_READ | winreg::enums::KEY_WRITE,
    );
    if let Ok(key) = key {
        let have: String = key.get_value(RUN_VALUE).unwrap_or_default();
        if have != want {
            let _ = key.set_value(RUN_VALUE, &want);
        }
    }
}

/// The same correction, for the app itself, which does know where it is.
#[cfg(windows)]
pub fn refresh() {
    if let Ok(exe) = std::env::current_exe() {
        repoint(&exe);
    }
}

/// Take the entry away. Called by the uninstaller, where there is no app left to run.
#[cfg(windows)]
pub fn remove() {
    if let Ok(key) = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
        .open_subkey_with_flags(RUN_KEY, winreg::enums::KEY_WRITE)
    {
        let _ = key.delete_value(RUN_VALUE);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The quoting is the whole point of building the string in one place: a path with
    /// a space in it is the case that silently starts the wrong thing.
    #[test]
    #[cfg(windows)]
    fn run_command_quotes_the_path() {
        let cmd = run_command(std::path::Path::new("C:\\Program Files\\PfP\\photosforproton.exe"));
        assert_eq!(cmd, "\"C:\\Program Files\\PfP\\photosforproton.exe\" --background");
        assert!(cmd.starts_with('"'));
        assert!(cmd.ends_with(BACKGROUND_FLAG));
    }

    /// The flag the entry writes and the flag the app tests for are the same constant,
    /// so a rename cannot leave the two ends disagreeing silently.
    #[test]
    fn background_flag_is_a_flag() {
        assert!(BACKGROUND_FLAG.starts_with("--"));
        assert!(!BACKGROUND_FLAG.contains(' '));
    }
}
