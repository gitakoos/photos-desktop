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

//! Brings downloaded copies that are out of sync back in sync, once they are shown to be the
//! cloud file: a copy left by an earlier install, or one a program held open right after its
//! download. Each is hashed and compared with the SHA-1 its cloud revision records. A copy
//! whose revision records none, or whose hash differs, stays out of sync, and so is never
//! freed without its bytes being compared again.
//!
//! The fill hands over every such copy it meets. One thread works through them in the
//! background (Windows' background mode, which lowers its disk and processor priority), a batch
//! of digests at a time. Nothing is written down: what is done shows on the files themselves,
//! in sync, and the next fill hands over again whatever is still out of sync, after a restart
//! too. What was found changed is remembered for the session, by the file's size and time, so
//! it is not hashed again until it changes.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex, OnceLock};

use super::identity::{self, Checked};

/// Digests asked for in one call.
const BATCH: usize = 40;

/// A file's size and last write time, as its directory entry gives them.
pub(super) type Stamp = (u64, i64);

/// What the cloud says a photo's current revision holds.
#[derive(Debug, PartialEq)]
pub(super) enum CloudDigest {
    /// The SHA-1 the revision records, hex.
    Known(String),
    /// Drive answered for the revision, and it records no digest.
    None,
    /// No answer: the lookup failed or skipped this photo.
    Unknown,
}

/// Reads one photo's entry from a `mountDigests` answer: a string is the digest, a null is a
/// revision without one, and anything else, a missing entry included, is no answer.
pub(super) fn digest_in(answer: Option<&serde_json::Value>, uid: &str) -> CloudDigest {
    match answer.and_then(|a| a.get(uid)) {
        Some(serde_json::Value::String(sha1)) => CloudDigest::Known(sha1.clone()),
        Some(serde_json::Value::Null) => CloudDigest::None,
        _ => CloudDigest::Unknown,
    }
}

/// How free-up tells a copy is the cloud file.
#[derive(Debug, PartialEq)]
pub(super) enum FreeCheck {
    /// By its SHA-1 against the revision's.
    Digest(String),
    /// By its bytes against a download: the revision records no digest.
    Download,
    /// Not at all: Drive did not answer, so the copy keeps its bytes.
    LeaveAlone,
}

pub(super) fn free_check(answer: Option<&serde_json::Value>, uid: &str) -> FreeCheck {
    match digest_in(answer, uid) {
        CloudDigest::Known(sha1) => FreeCheck::Digest(sha1),
        CloudDigest::None => FreeCheck::Download,
        CloudDigest::Unknown => FreeCheck::LeaveAlone,
    }
}

#[derive(Default)]
struct State {
    queue: VecDeque<(String, PathBuf, Stamp)>,
    queued: HashSet<String>,
    /// Copies already found changed here or with no digest to check against, by path, with
    /// the photo and the stamp they had then.
    settled: HashMap<String, (String, Stamp)>,
    started: bool,
    /// Bumped by sign-out, so a batch of the account before is dropped.
    generation: u64,
}

fn state() -> &'static (Mutex<State>, Condvar) {
    static STATE: OnceLock<(Mutex<State>, Condvar)> = OnceLock::new();
    STATE.get_or_init(Default::default)
}

fn key(path: &Path) -> String {
    path.to_string_lossy().to_lowercase()
}

/// Whether a copy needs checking now: not already waiting, and not found changed or without a
/// digest earlier in the session while it still has the same photo, size and time.
fn wanted(st: &State, key: &str, uid: &str, stamp: Stamp) -> bool {
    !st.queued.contains(key) && st.settled.get(key).is_none_or(|(was, at)| was != uid || *at != stamp)
}

/// A copy of `uid` at `path` that holds its data but is out of sync, for the checker.
pub(super) fn want(app: &tauri::AppHandle, path: &Path, uid: &str, stamp: Stamp) {
    let (lock, wake) = state();
    let mut st = lock.lock().unwrap_or_else(|p| p.into_inner());
    let k = key(path);
    if !wanted(&st, &k, uid, stamp) {
        return;
    }
    st.queued.insert(k);
    st.queue.push_back((uid.to_string(), path.to_path_buf(), stamp));
    if !st.started {
        st.started = true;
        let app = app.clone();
        std::thread::spawn(move || run(app));
    }
    wake.notify_one();
}

/// Forgets the account that signed out: nothing more of its is checked.
pub(super) fn forget() {
    let (lock, _) = state();
    let mut st = lock.lock().unwrap_or_else(|p| p.into_inner());
    st.queue.clear();
    st.queued.clear();
    st.settled.clear();
    st.generation += 1;
}

fn run(app: tauri::AppHandle) {
    use windows::Win32::System::Threading::{GetCurrentThread, SetThreadPriority, THREAD_MODE_BACKGROUND_BEGIN};
    let _ = unsafe { SetThreadPriority(GetCurrentThread(), THREAD_MODE_BACKGROUND_BEGIN) };
    let (lock, wake) = state();
    loop {
        let (batch, generation) = {
            let mut st = lock.lock().unwrap_or_else(|p| p.into_inner());
            while st.queue.is_empty() {
                st = wake.wait(st).unwrap_or_else(|p| p.into_inner());
            }
            let n = st.queue.len().min(BATCH);
            let batch: Vec<(String, PathBuf, Stamp)> = st.queue.drain(..n).collect();
            (batch, st.generation)
        };
        check_batch(&app, &batch, generation);
        let mut st = lock.lock().unwrap_or_else(|p| p.into_inner());
        for (_, path, _) in &batch {
            st.queued.remove(&key(path));
        }
    }
}

fn check_batch(app: &tauri::AppHandle, batch: &[(String, PathBuf, Stamp)], generation: u64) {
    let usable = || {
        super::show_in_explorer_enabled() && !super::detaching() && super::sync_root_available()
    };
    if !usable() {
        return;
    }
    let uids: Vec<&String> = batch.iter().map(|(uid, _, _)| uid).collect();
    let answer = crate::sidecar_rpc(app, "mountDigests", serde_json::json!({ "uids": uids })).ok();
    let (mut in_sync, mut changed, mut without) = (0usize, 0usize, 0usize);
    for (uid, path, stamp) in batch {
        if !usable() || state().0.lock().unwrap_or_else(|p| p.into_inner()).generation != generation {
            return;
        }
        let settled = match digest_in(answer.as_ref(), uid) {
            CloudDigest::Known(sha1) => match identity::mark_in_sync_if_digest(path, uid, &sha1) {
                Checked::InSync => {
                    in_sync += 1;
                    false
                }
                Checked::Differs => {
                    changed += 1;
                    true
                }
                Checked::NotChecked => false,
            },
            // Nothing to prove it by: it stays out of sync, and only a comparison of its bytes
            // with a download of the cloud file can free it.
            CloudDigest::None => {
                without += 1;
                true
            }
            CloudDigest::Unknown => false,
        };
        if settled {
            let mut st = state().0.lock().unwrap_or_else(|p| p.into_inner());
            if st.generation == generation {
                st.settled.insert(key(path), (uid.clone(), *stamp));
            }
        }
    }
    if in_sync + changed + without > 0 {
        // Counts only, no name or uid.
        crate::note(
            app,
            &format!("[verify] {in_sync} copies match the cloud file, {changed} changed here, {without} without a digest"),
        );
    }
    if in_sync > 0 {
        super::rescan_hydrated();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_digest_answer_tells_a_digest_from_none_and_from_no_answer() {
        let answer = serde_json::json!({ "a": "a9993e364706816aba3e25717850c26c9cd0d89d", "b": null, "c": 5 });
        assert_eq!(
            digest_in(Some(&answer), "a"),
            CloudDigest::Known("a9993e364706816aba3e25717850c26c9cd0d89d".to_string())
        );
        assert_eq!(digest_in(Some(&answer), "b"), CloudDigest::None);
        assert_eq!(digest_in(Some(&answer), "c"), CloudDigest::Unknown);
        assert_eq!(digest_in(Some(&answer), "d"), CloudDigest::Unknown);
        assert_eq!(digest_in(None, "a"), CloudDigest::Unknown);
    }

    #[test]
    fn free_up_uses_the_digest_and_downloads_only_without_one() {
        let answer = serde_json::json!({ "a": "a9993e364706816aba3e25717850c26c9cd0d89d", "b": null });
        assert_eq!(
            free_check(Some(&answer), "a"),
            FreeCheck::Digest("a9993e364706816aba3e25717850c26c9cd0d89d".to_string())
        );
        assert_eq!(free_check(Some(&answer), "b"), FreeCheck::Download);
        assert_eq!(free_check(Some(&answer), "c"), FreeCheck::LeaveAlone);
        assert_eq!(free_check(None, "a"), FreeCheck::LeaveAlone);
    }

    #[test]
    fn a_copy_found_changed_is_checked_again_only_once_it_changes() {
        let mut st = State::default();
        assert!(wanted(&st, "p", "v~a", (5, 1)));
        st.queued.insert("p".into());
        assert!(!wanted(&st, "p", "v~a", (5, 1)), "already waiting");
        st.queued.clear();
        st.settled.insert("p".into(), ("v~a".into(), (5, 1)));
        assert!(!wanted(&st, "p", "v~a", (5, 1)));
        assert!(wanted(&st, "p", "v~a", (5, 2)), "written to since");
        assert!(wanted(&st, "p", "v~a", (6, 1)));
        assert!(wanted(&st, "p", "v~b", (5, 1)), "another photo's now");
    }
}
