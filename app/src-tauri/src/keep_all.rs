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

//! What the Explorer folder keeps on this PC by itself: nothing, the photos that arrive from
//! now on, or every photo of the timeline.
//!
//! The choice and what it has done belong to the signed-in account. They are sealed files in
//! the app directory that sign-out deletes with the rest of the account's state, so the next
//! account starts with nothing kept and nothing to let go of.
//!
//! Downloads run on a thread of their own, outside the fill's lock, one photo at a time on the
//! sidecar's background lane, so the window, the viewer and Explorer edits never wait on them.
//! A copy is let go of only on Drive's own answer that its photo went to the trash or was
//! hidden, never because it was missing from a listing.

// The rules below are the Windows worker's; elsewhere only the tests use them.
#![cfg_attr(not(windows), allow(dead_code))]

use std::collections::{HashMap, HashSet};

/// What the folder keeps on this PC by itself.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    Off,
    /// Photos added to the library after this was chosen.
    New,
    /// Every photo of the timeline.
    All,
}

impl Mode {
    pub fn parse(text: &str) -> Option<Mode> {
        match text.trim() {
            "off" => Some(Mode::Off),
            "new" => Some(Mode::New),
            "all" => Some(Mode::All),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Off => "off",
            Mode::New => "new",
            Mode::All => "all",
        }
    }
}

/// Free space a download always leaves on the drive.
pub const SPACE_FLOOR: u64 = 5 * 1024 * 1024 * 1024;

/// Whether one more file of `size` fits: the file itself, its staged copy in the temp folder
/// while it transfers, and the floor left over.
pub fn space_ok(free: u64, size: u64) -> bool {
    free >= SPACE_FLOOR.saturating_add(size.saturating_mul(2))
}

/// What a connection's cost says about a large background download, as Microsoft's guidance for
/// metered networks reads it: a capped or per-byte plan, roaming, a data limit reached or near,
/// or Windows asking apps to hold background data, all hold it. A cost Windows does not know
/// counts as unmetered, or a desktop it cannot read would never download.
pub fn metered(costed: bool, roaming: bool, over_limit: bool, near_limit: bool, background_restricted: bool) -> bool {
    costed || roaming || over_limit || near_limit || background_restricted
}

/// Whether the machine is saving power: running on its battery (`ACLineStatus` 0), or with
/// Battery Saver on (`SystemStatusFlag` 1). An unknown line status (255) is taken as mains,
/// which is what a desktop with no battery reports it as.
pub fn saving_power(ac_line_status: u8, system_status_flag: u8) -> bool {
    ac_line_status == 0 || system_status_flag == 1
}

/// How many kept copies one fill may let go of because their photos went to the trash before
/// it stops and asks. Drive's answer is per photo, so this is only a backstop against a mistake
/// no one has thought of yet.
pub fn release_cap(kept: usize) -> usize {
    (kept / 10).max(25)
}

/// The photos a pass downloads, in the order given: the ones whose timeline copy is cloud-only
/// right now, without what the user freed up and what is waiting to go to the trash.
pub fn pass_targets<'a>(
    candidates: impl IntoIterator<Item = &'a str>,
    cloud_only: impl Fn(&str) -> bool,
    freed: &HashSet<String>,
    untrashed: &HashSet<String>,
) -> Vec<String> {
    candidates
        .into_iter()
        .filter(|uid| !freed.contains(*uid) && !untrashed.contains(*uid) && cloud_only(uid))
        .map(str::to_string)
        .collect()
}

/// Whether the pass downloads a photo: its timeline copy holds no data here, and for new photos
/// only, no other copy does either. A new photo put into an album folder in Explorer is on this
/// PC already, so a second copy in `Photos\` would only take the space twice.
pub fn needs_download(mode: Mode, timeline_cloud_only: bool, any_copy_local: bool) -> bool {
    timeline_cloud_only && !(mode == Mode::New && any_copy_local)
}

/// The arrivals a fill found that the user did not free in this session.
pub fn fresh_arrivals(uids: &[String], freed_now: &HashSet<String>) -> Vec<String> {
    uids.iter().filter(|uid| !freed_now.contains(*uid)).cloned().collect()
}

/// Takes the photos the user freed off the pass's lists, so it does not download them again.
/// Every photo kept: they join the freed list and leave the kept one. New photos only: they
/// leave the arrivals still waiting. Returns which lists changed, as (freed, kept, pending).
pub fn after_free(
    mode: Mode,
    uids: &[String],
    freed: &mut HashSet<String>,
    kept: &mut HashSet<String>,
    pending: &mut HashSet<String>,
) -> (bool, bool, bool) {
    match mode {
        Mode::All => {
            let freed_before = freed.len();
            freed.extend(uids.iter().cloned());
            let kept_before = kept.len();
            for uid in uids {
                kept.remove(uid);
            }
            (freed.len() != freed_before, kept.len() != kept_before, false)
        }
        Mode::New => {
            let before = pending.len();
            for uid in uids {
                pending.remove(uid);
            }
            (false, false, pending.len() != before)
        }
        Mode::Off => (false, false, false),
    }
}

/// Which copy of a photo was freed: its own in `Photos\`, or one in an album or another folder
/// beside the timeline.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FreedCopy {
    Timeline,
    Album,
}

/// The kind of copy at `rel`, given the photo's timeline copy.
pub fn freed_copy(rel: &str, timeline: Option<&str>) -> FreedCopy {
    if timeline.is_some_and(|t| t.eq_ignore_ascii_case(rel)) {
        FreedCopy::Timeline
    } else {
        FreedCopy::Album
    }
}

/// Whether freeing this copy takes its photo off the pass's lists. The timeline copy is the
/// photo itself. Another copy counts only for new photos only, where downloading the photo
/// into `Photos\` would bring back what was just freed; a pass that keeps every photo keeps
/// the timeline copy as before.
pub fn free_counts(mode: Mode, copy: FreedCopy) -> bool {
    copy == FreedCopy::Timeline || mode == Mode::New
}

/// What the provider does with a dehydration Windows asks it about.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum OsFree {
    /// The app's own Free up, which records what it freed itself.
    Pass,
    /// Freed by Windows: allowed, and recorded like the app's Free up.
    Record,
    Refuse,
}

/// While every photo is kept, only the user frees a copy, with the app's Free up or Explorer's
/// "Free up space" (`unpinned`), never Windows by itself. Anything freed otherwise is recorded,
/// so the pass does not download it again whether it is running, paused or off. A copy the
/// folder's index does not list (`listed`), such as the one left of a photo deleted from Drive
/// for good, may be the only one there is, and nothing but the app frees it.
pub fn os_free(mode: Mode, ours: bool, listed: bool, unpinned: bool) -> OsFree {
    if ours {
        OsFree::Pass
    } else if !listed || (mode == Mode::All && !unpinned) {
        OsFree::Refuse
    } else {
        OsFree::Record
    }
}

/// What to do with the copies whose photos left the listing, from Drive's answer for each.
#[derive(Default, Debug, PartialEq)]
pub struct Release {
    /// Copies to let go of now.
    pub let_go: Vec<String>,
    /// Copies held back for the user to decide, because too many went at once.
    pub held: Vec<String>,
    /// Photos deleted for good: their copy is the only one left, so it stays as the user's own.
    pub forget: Vec<String>,
}

/// Decides from each photo's fate ("trashed", "gone", "hidden", "present", "unknown").
///
/// "hidden" is the sidecar's answer for a hidden photo Drive still has: its copy goes whatever
/// the mode and whoever downloaded it, because a copy in the plain folder is outside the lock
/// that guards it, and the photo is still behind that lock. A hidden photo in the trash or
/// deleted for good is answered "trashed" or "gone" and decided as any photo, so the only copy
/// left of one stays as the user's own. A trashed one goes only while every
/// photo is kept and only when this mode downloaded it: the photo is still in the Proton trash,
/// so nothing is lost, and restoring it brings it back. Anything else stays.
pub fn release_decision(
    candidates: &[String],
    fates: &HashMap<String, String>,
    kept: &HashSet<String>,
    mode: Mode,
) -> Release {
    let mut out = Release::default();
    let mut trashed = Vec::new();
    for uid in candidates {
        match fates.get(uid).map(String::as_str) {
            Some("hidden") => out.let_go.push(uid.clone()),
            Some("trashed") if mode == Mode::All && kept.contains(uid) => trashed.push(uid.clone()),
            Some("gone") if kept.contains(uid) => out.forget.push(uid.clone()),
            _ => {}
        }
    }
    if trashed.len() > release_cap(kept.len()) {
        out.held = trashed;
    } else {
        out.let_go.extend(trashed);
    }
    out
}

/// The full uid of a downloaded copy in `Photos\` that matches a hidden photo, for Drive to be
/// asked about it before the copy goes. `tail` is the end of the uid the copy carries, `hidden`
/// the matching entry of the hidden list (a full uid, or a bare link id), and `listed` the uids
/// of this fill, which share the volume of the user's photos. None when it cannot be told, and
/// the copy then stays.
pub fn hidden_copy_uid<'a>(tail: &str, hidden: &str, listed: impl IntoIterator<Item = &'a str>) -> Option<String> {
    if hidden.contains('~') {
        return Some(hidden.to_string());
    }
    let (volume_end, link) = tail.rsplit_once('~')?;
    if link.is_empty() || volume_end.is_empty() || link != hidden {
        return None;
    }
    listed
        .into_iter()
        .filter_map(|u| u.rsplit_once('~').map(|(volume, _)| volume))
        .find(|volume| volume.ends_with(volume_end))
        .map(|volume| format!("{volume}~{link}"))
}

/// What a photo deleted in Explorer whose delete did not reach the Proton trash needs next.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Untrashed {
    /// Nothing more: it is in the trash or gone, or back in the library after the trash was
    /// asked for it once more, which is a restore and stands.
    Done,
    /// Ask the trash for it once more.
    Ask,
    /// Drive did not answer for it: asked about again on the next round.
    Wait,
}

/// Decides from Drive's answer for the photo ("trashed", "gone", "hidden", "present",
/// "unknown") and whether the trash was asked again for it once already.
pub fn untrashed_step(fate: Option<&str>, asked: bool) -> Untrashed {
    match fate {
        Some("trashed" | "gone") => Untrashed::Done,
        Some("present" | "hidden") if asked => Untrashed::Done,
        Some("present" | "hidden") => Untrashed::Ask,
        _ => Untrashed::Wait,
    }
}

/// The photos `trashPhotos` answered as now in the trash: its answer is one entry per photo.
pub fn trashed_uids(answer: &serde_json::Value) -> HashSet<String> {
    answer
        .as_array()
        .map(|results| {
            results
                .iter()
                .filter(|r| r.get("ok").and_then(|v| v.as_bool()) == Some(true))
                .filter_map(|r| r.get("uid").and_then(|v| v.as_str()).map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// The marker on a line of the untrashed list for a photo the trash has not been asked about
/// again yet.
const NOT_ASKED: &str = " new";

/// The untrashed list, uid to whether the trash was asked again for it once already. A bare uid
/// was asked, which is also what the builds before wrote, after asking the trash again on every
/// round.
pub fn parse_untrashed(text: &str) -> HashMap<String, bool> {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(|l| match l.strip_suffix(NOT_ASKED) {
            Some(uid) => (uid.trim().to_string(), false),
            None => (l.to_string(), true),
        })
        .filter(|(uid, _)| !uid.is_empty())
        .collect()
}

pub fn join_untrashed(list: &HashMap<String, bool>) -> String {
    let mut lines: Vec<String> =
        list.iter().map(|(uid, asked)| if *asked { uid.clone() } else { format!("{uid}{NOT_ASKED}") }).collect();
    lines.sort_unstable();
    lines.join("\n")
}

/// One uid per line, blank lines skipped.
pub fn parse_list(text: &str) -> HashSet<String> {
    text.lines().map(str::trim).filter(|l| !l.is_empty()).map(String::from).collect()
}

fn join_list(set: &HashSet<String>) -> String {
    let mut lines: Vec<&str> = set.iter().map(String::as_str).collect();
    lines.sort_unstable();
    lines.join("\n")
}

/// What the Settings page shows of the pass.
#[derive(Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeepStatus {
    pub mode: String,
    pub running: bool,
    pub paused: bool,
    pub done: u64,
    pub total: u64,
    /// Why the pass stands still: "space", "metered", "battery", "hidden", or none.
    pub waiting: Option<&'static str>,
    /// Copies held back because too many photos went to the trash at once.
    pub held: usize,
}

/// Whether the machine is saving power and whether the connection is metered, the two things
/// these downloads wait on, for the face scan to slow down on as well.
pub fn power_state() -> serde_json::Value {
    #[cfg(windows)]
    let (saving, metered) = (win::on_battery(), win::on_metered_network());
    #[cfg(not(windows))]
    let (saving, metered) = (false, false);
    serde_json::json!({ "saving": saving, "metered": metered })
}

#[cfg(windows)]
pub use win::*;

#[cfg(windows)]
mod win {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::{Condvar, Mutex, OnceLock};
    use std::time::Duration;
    use tauri::{AppHandle, Emitter};

    const MODE_FILE: &str = "mount_mode.txt";
    const KEPT_FILE: &str = "mount_kept.txt";
    const FREED_FILE: &str = "mount_freed.txt";
    const PENDING_FILE: &str = "mount_pending.txt";
    const HELD_FILE: &str = "mount_held.txt";
    const UNTRASHED_FILE: &str = "mount_untrashed.txt";

    /// How often the folder is filled again while the app sits in the tray.
    const FILL_EVERY: Duration = Duration::from_secs(15 * 60);
    /// Downloaded copies between two signals to the grid that more are on this PC.
    const BADGE_EVERY: u64 = 50;

    #[derive(Default)]
    struct State {
        loaded: bool,
        mode: Option<Mode>,
        kept: HashSet<String>,
        freed: HashSet<String>,
        pending: HashSet<String>,
        held: HashSet<String>,
        /// Photos deleted in Explorer whose delete did not reach the trash, to whether the trash
        /// was asked again for them once already.
        untrashed: HashMap<String, bool>,
        /// Photos the user freed in this session, kept in memory only. A fill that was already
        /// listing when the user freed space can name one of them as new after the free up ran.
        freed_now: HashSet<String>,
    }

    fn state() -> &'static Mutex<State> {
        static S: OnceLock<Mutex<State>> = OnceLock::new();
        S.get_or_init(|| Mutex::new(State::default()))
    }

    /// Bumped by sign-out, so a pass of the account before stops at its next photo.
    static GENERATION: AtomicU64 = AtomicU64::new(0);
    static PAUSED: AtomicBool = AtomicBool::new(false);
    static RUNNING: AtomicBool = AtomicBool::new(false);
    static DONE: AtomicU64 = AtomicU64::new(0);
    static TOTAL: AtomicU64 = AtomicU64::new(0);
    static WAITING: Mutex<Option<&'static str>> = Mutex::new(None);

    /// The photos the pass is downloading right now, so the download takes the background lane.
    fn in_flight() -> &'static Mutex<HashSet<String>> {
        static F: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
        F.get_or_init(|| Mutex::new(HashSet::new()))
    }

    fn wake() -> &'static (Mutex<bool>, Condvar) {
        static W: OnceLock<(Mutex<bool>, Condvar)> = OnceLock::new();
        W.get_or_init(|| (Mutex::new(false), Condvar::new()))
    }

    fn read_list(app: &AppHandle, file: &str) -> HashSet<String> {
        crate::secure_store::read_sealed(app, file).ok().flatten().map(|t| parse_list(&t)).unwrap_or_default()
    }

    fn write_list(app: &AppHandle, file: &str, set: &HashSet<String>) {
        let _ = crate::secure_store::write_sealed(app, file, &join_list(set));
    }

    /// Reads the account's files the first time they are needed after start or sign-out.
    fn loaded(app: &AppHandle) -> std::sync::MutexGuard<'static, State> {
        let mut st = state().lock().unwrap();
        if !st.loaded {
            st.mode = crate::secure_store::read_sealed(app, MODE_FILE).ok().flatten().and_then(|t| Mode::parse(&t));
            if st.mode.is_none() {
                // The switch of the builds before was one value for the whole Windows account.
                // It becomes this account's choice once, and is then removed, so an account
                // signing in later starts with nothing kept.
                if crate::cloud_mount::take_legacy_auto_download() {
                    st.mode = Some(Mode::New);
                    let _ = crate::secure_store::write_sealed(app, MODE_FILE, Mode::New.as_str());
                }
            }
            st.kept = read_list(app, KEPT_FILE);
            st.freed = read_list(app, FREED_FILE);
            st.pending = read_list(app, PENDING_FILE);
            st.held = read_list(app, HELD_FILE);
            st.untrashed = crate::secure_store::read_sealed(app, UNTRASHED_FILE)
                .ok()
                .flatten()
                .map(|t| parse_untrashed(&t))
                .unwrap_or_default();
            st.loaded = true;
        }
        st
    }

    pub fn mode(app: &AppHandle) -> Mode {
        loaded(app).mode.unwrap_or(Mode::Off)
    }

    pub fn set_mode(app: &AppHandle, next: Mode) {
        {
            let mut st = loaded(app);
            st.mode = Some(next);
            let _ = crate::secure_store::write_sealed(app, MODE_FILE, next.as_str());
            if next != Mode::New {
                st.pending.clear();
                write_list(app, PENDING_FILE, &st.pending);
            }
        }
        PAUSED.store(false, Ordering::SeqCst);
        nudge();
    }

    /// Forgets the account that signed out, and stops its pass at the next photo.
    pub fn forget() {
        GENERATION.fetch_add(1, Ordering::SeqCst);
        *state().lock().unwrap() = State::default();
        in_flight().lock().unwrap().clear();
        PAUSED.store(false, Ordering::SeqCst);
        *WAITING.lock().unwrap() = None;
    }

    /// Stops a pass that is running at its next photo, without forgetting anything.
    pub fn interrupt() {
        GENERATION.fetch_add(1, Ordering::SeqCst);
    }

    /// Photos that arrived since the last fill, for "New photos only".
    pub fn add_arrivals(app: &AppHandle, uids: &[String]) {
        if uids.is_empty() || mode(app) != Mode::New {
            return;
        }
        let mut st = loaded(app);
        let fresh = fresh_arrivals(uids, &st.freed_now);
        if fresh.is_empty() {
            return;
        }
        st.pending.extend(fresh);
        write_list(app, PENDING_FILE, &st.pending);
    }

    /// The user freed these: the pass leaves them in the cloud from now on.
    pub fn note_freed(app: &AppHandle, uids: &[String]) {
        if uids.is_empty() {
            return;
        }
        let mut st = loaded(app);
        let st = &mut *st;
        st.freed_now.extend(uids.iter().cloned());
        let mode = st.mode.unwrap_or(Mode::Off);
        let (freed, kept, pending) = after_free(mode, uids, &mut st.freed, &mut st.kept, &mut st.pending);
        if freed {
            write_list(app, FREED_FILE, &st.freed);
        }
        if kept {
            write_list(app, KEPT_FILE, &st.kept);
        }
        if pending {
            write_list(app, PENDING_FILE, &st.pending);
        }
    }

    /// An album's copies were freed: the arrivals among its photos are not downloaded into
    /// `Photos\` either. The photo's own timeline copy is not touched by that, so a pass that
    /// keeps every photo keeps it as before.
    pub fn note_album_freed(app: &AppHandle, uids: &[String]) {
        note_copy_freed(app, uids, FreedCopy::Album);
    }

    /// Copies of one kind that were freed, recorded the way the app's Free up records them.
    pub fn note_copy_freed(app: &AppHandle, uids: &[String], copy: FreedCopy) {
        if uids.is_empty() || !free_counts(mode(app), copy) {
            return;
        }
        note_freed(app, uids);
    }

    /// The user downloaded these again, so the pass may keep them.
    pub fn note_unfreed(app: &AppHandle, uids: &[String]) {
        let mut st = loaded(app);
        let before = st.freed.len();
        for uid in uids {
            st.freed.remove(uid);
        }
        if st.freed.len() != before {
            write_list(app, FREED_FILE, &st.freed);
        }
    }

    /// Everything was freed up: keeping every photo would only download it all again.
    pub fn freed_everything(app: &AppHandle, uids: &[String]) {
        if mode(app) == Mode::All {
            set_mode(app, Mode::New);
        }
        // The arrivals still waiting were freed with the rest.
        let mut st = loaded(app);
        st.freed_now.extend(uids.iter().cloned());
        if !st.pending.is_empty() {
            st.pending.clear();
            write_list(app, PENDING_FILE, &st.pending);
        }
    }

    /// A delete in Explorer that did not reach the Proton trash: the photo is not downloaded
    /// again, and the trash is asked once more on the next round.
    pub fn note_untrashed(app: &AppHandle, uid: &str) {
        let mut st = loaded(app);
        if st.untrashed.insert(uid.to_string(), false) != Some(false) {
            write_untrashed(app, &st.untrashed);
        }
    }

    fn write_untrashed(app: &AppHandle, list: &HashMap<String, bool>) {
        let _ = crate::secure_store::write_sealed(app, UNTRASHED_FILE, &join_untrashed(list));
    }

    pub fn kept(app: &AppHandle) -> HashSet<String> {
        loaded(app).kept.clone()
    }

    /// Applies one fill's decision: the copies let go of, held back or left as the user's own.
    pub fn settle(app: &AppHandle, released: &[String], held: &[String], forget: &[String]) {
        let mut st = loaded(app);
        for uid in released.iter().chain(forget) {
            st.kept.remove(uid);
        }
        st.held.extend(held.iter().cloned());
        write_list(app, KEPT_FILE, &st.kept);
        write_list(app, HELD_FILE, &st.held);
    }

    pub fn held(app: &AppHandle) -> Vec<String> {
        loaded(app).held.iter().cloned().collect()
    }

    /// The user answered about the held copies: they were let go of, or stay as their own.
    pub fn clear_held(app: &AppHandle, uids: &[String]) {
        let mut st = loaded(app);
        for uid in uids {
            st.held.remove(uid);
            st.kept.remove(uid);
        }
        write_list(app, HELD_FILE, &st.held);
        write_list(app, KEPT_FILE, &st.kept);
    }

    /// Whether this download belongs to the pass, so it takes the background lane.
    pub fn in_pass(uid: &str) -> bool {
        in_flight().lock().unwrap().contains(uid)
    }

    pub fn status(app: &AppHandle) -> KeepStatus {
        let st = loaded(app);
        KeepStatus {
            mode: st.mode.unwrap_or(Mode::Off).as_str().to_string(),
            running: RUNNING.load(Ordering::SeqCst),
            paused: PAUSED.load(Ordering::SeqCst),
            done: DONE.load(Ordering::SeqCst),
            total: TOTAL.load(Ordering::SeqCst),
            waiting: *WAITING.lock().unwrap(),
            held: st.held.len(),
        }
    }

    fn publish(app: &AppHandle) {
        let _ = app.emit("keep-progress", status(app));
    }

    pub fn set_paused(app: &AppHandle, paused: bool) {
        PAUSED.store(paused, Ordering::SeqCst);
        if !paused {
            nudge();
        }
        publish(app);
    }

    /// Asks the worker for a round soon.
    pub fn nudge() {
        let (lock, cv) = wake();
        *lock.lock().unwrap() = true;
        cv.notify_one();
    }

    /// Starts the worker: a round after every fill and every nudge, and a fill of its own every
    /// quarter of an hour, so photos arrive while the window is closed to the tray.
    pub fn start(app: AppHandle) {
        static STARTED: AtomicBool = AtomicBool::new(false);
        if STARTED.swap(true, Ordering::SeqCst) {
            return;
        }
        std::thread::spawn(move || {
            let mut last_fill = std::time::Instant::now();
            loop {
                let woken = {
                    let (lock, cv) = wake();
                    let guard = lock.lock().unwrap();
                    let (mut guard, _) = cv.wait_timeout_while(guard, Duration::from_secs(60), |woken| !*woken).unwrap();
                    std::mem::replace(&mut *guard, false)
                };
                if last_fill.elapsed() >= FILL_EVERY {
                    last_fill = std::time::Instant::now();
                    // A fill nudges the worker itself when it ends.
                    crate::cloud_mount::timed_fill(&app);
                    continue;
                }
                // Looking over the whole timeline is a directory-entry read per photo, so a
                // quiet minute only checks again while something holds the pass: the drive
                // filling up, a metered connection, the battery, or the hidden list.
                let held = WAITING.lock().unwrap().is_some();
                if woken || held {
                    round(&app);
                }
            }
        });
    }

    /// Why a download cannot start now, if anything: a nearly full drive, a metered connection
    /// or running on battery.
    fn hold_reason(size: u64) -> Option<&'static str> {
        if crate::cloud_mount::free_space().is_some_and(|free| !space_ok(free, size)) {
            return Some("space");
        }
        if on_metered_network() {
            return Some("metered");
        }
        if on_battery() {
            return Some("battery");
        }
        None
    }

    pub(super) fn on_battery() -> bool {
        use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
        let mut status = SYSTEM_POWER_STATUS::default();
        unsafe { GetSystemPowerStatus(&mut status) }.is_ok() && saving_power(status.ACLineStatus, status.SystemStatusFlag)
    }

    pub(super) fn on_metered_network() -> bool {
        use windows::Networking::Connectivity::{NetworkCostType, NetworkInformation};
        let Ok(profile) = NetworkInformation::GetInternetConnectionProfile() else { return false };
        let Ok(cost) = profile.GetConnectionCost() else { return false };
        let kind = cost.NetworkCostType().unwrap_or(NetworkCostType::Unrestricted);
        metered(
            matches!(kind, NetworkCostType::Fixed | NetworkCostType::Variable),
            cost.Roaming().unwrap_or(false),
            cost.OverDataLimit().unwrap_or(false),
            cost.ApproachingDataLimit().unwrap_or(false),
            cost.BackgroundDataUsageRestricted().unwrap_or(false),
        )
    }

    fn set_waiting(app: &AppHandle, why: Option<&'static str>) {
        let changed = {
            let mut w = WAITING.lock().unwrap();
            let changed = *w != why;
            *w = why;
            changed
        };
        if changed {
            publish(app);
        }
    }

    /// One round: ask the trash again for what Explorer could not put there, then download.
    fn round(app: &AppHandle) {
        if !crate::cloud_mount::show_in_explorer_enabled()
            || crate::cloud_mount::detaching()
            || !crate::cloud_mount::sync_root_available()
        {
            return;
        }
        let generation = GENERATION.load(Ordering::SeqCst);
        retry_untrashed(app);
        let mode = mode(app);
        if mode == Mode::Off || PAUSED.load(Ordering::SeqCst) {
            set_waiting(app, None);
            return;
        }
        if mode == Mode::All {
            // A photo hidden on another device reads as an ordinary one until its hide arrives.
            let ready = crate::sidecar_rpc(app, "keepReady", serde_json::json!({}))
                .ok()
                .and_then(|r| r.get("hidden").and_then(|v| v.as_bool()))
                .unwrap_or(false);
            if !ready {
                set_waiting(app, Some("hidden"));
                return;
            }
        }
        let candidates: Vec<String> = match mode {
            Mode::All => crate::cloud_mount::timeline_uids(),
            _ => loaded(app).pending.iter().cloned().collect(),
        };
        let downloads = |uid: &str| {
            let local_elsewhere = mode == Mode::New && crate::cloud_mount::any_copy_local(uid);
            needs_download(mode, crate::cloud_mount::is_cloud_only(uid), local_elsewhere)
        };
        let targets = {
            let st = loaded(app);
            let untrashed: HashSet<String> = st.untrashed.keys().cloned().collect();
            pass_targets(candidates.iter().map(String::as_str), downloads, &st.freed, &untrashed)
        };
        if mode == Mode::New {
            // An arrival that is local already, or gone from the folder, needs nothing more.
            let mut st = loaded(app);
            let wanted: HashSet<&str> = targets.iter().map(String::as_str).collect();
            let before = st.pending.len();
            st.pending.retain(|uid| wanted.contains(uid.as_str()));
            if st.pending.len() != before {
                write_list(app, PENDING_FILE, &st.pending);
            }
        }
        if targets.is_empty() {
            set_waiting(app, None);
            return;
        }
        RUNNING.store(true, Ordering::SeqCst);
        DONE.store(0, Ordering::SeqCst);
        TOTAL.store(targets.len() as u64, Ordering::SeqCst);
        set_waiting(app, None);
        publish(app);
        crate::note(app, &format!("[keep] pass of {} photos ({})", targets.len(), mode.as_str()));
        let mut kept_now = 0u64;
        for uid in &targets {
            let stop = GENERATION.load(Ordering::SeqCst) != generation
                || PAUSED.load(Ordering::SeqCst)
                || self::mode(app) != mode
                || crate::cloud_mount::detaching()
                || !crate::cloud_mount::show_in_explorer_enabled()
                || !crate::cloud_mount::sync_root_available();
            if stop {
                break;
            }
            let size = crate::cloud_mount::cloud_size_of(uid).unwrap_or(0);
            if let Some(why) = hold_reason(size) {
                set_waiting(app, Some(why));
                break;
            }
            in_flight().lock().unwrap().insert(uid.clone());
            let ok = crate::cloud_mount::hydrate_cloud_only(uid);
            in_flight().lock().unwrap().remove(uid);
            if GENERATION.load(Ordering::SeqCst) != generation {
                break;
            }
            if ok {
                kept_now += 1;
                let mut st = loaded(app);
                st.kept.insert(uid.clone());
                st.pending.remove(uid);
                if kept_now % 25 == 0 {
                    write_list(app, KEPT_FILE, &st.kept);
                    write_list(app, PENDING_FILE, &st.pending);
                }
            }
            let done = DONE.fetch_add(1, Ordering::SeqCst) + 1;
            if done % BADGE_EVERY == 0 {
                crate::cloud_mount::bump_hydrated_version();
            }
            if done % 10 == 0 {
                publish(app);
            }
        }
        if GENERATION.load(Ordering::SeqCst) == generation {
            let st = loaded(app);
            write_list(app, KEPT_FILE, &st.kept);
            write_list(app, PENDING_FILE, &st.pending);
        }
        RUNNING.store(false, Ordering::SeqCst);
        crate::cloud_mount::bump_hydrated_version();
        crate::note(app, &format!("[keep] pass ended, {kept_now} kept"));
        publish(app);
    }

    /// Asks Drive about each photo deleted in Explorer whose delete did not reach the trash,
    /// and asks the trash once more for the ones still in the library. A photo back in the
    /// library after that one more try was restored, and is not deleted again.
    fn retry_untrashed(app: &AppHandle) {
        let list: Vec<(String, bool)> = loaded(app).untrashed.iter().map(|(u, a)| (u.clone(), *a)).collect();
        if list.is_empty() {
            return;
        }
        let uids: Vec<&String> = list.iter().map(|(uid, _)| uid).collect();
        let Ok(answer) = crate::sidecar_rpc(app, "mountFates", serde_json::json!({ "uids": uids })) else {
            return;
        };
        let fates: HashMap<String, String> = serde_json::from_value(answer).unwrap_or_default();
        let mut done: Vec<(String, bool)> = Vec::new();
        let mut ask: Vec<String> = Vec::new();
        for (uid, asked) in &list {
            match untrashed_step(fates.get(uid).map(String::as_str), *asked) {
                Untrashed::Done => done.push((uid.clone(), *asked)),
                Untrashed::Ask => ask.push(uid.clone()),
                Untrashed::Wait => {}
            }
        }
        let mut asked_now: Vec<String> = Vec::new();
        let mut reached = 0usize;
        if !ask.is_empty() {
            if let Ok(answer) = crate::sidecar_rpc(app, "trashPhotos", serde_json::json!({ "uids": ask })) {
                let took = trashed_uids(&answer);
                for uid in ask {
                    if took.contains(&uid) {
                        reached += 1;
                        done.push((uid, false));
                    } else {
                        asked_now.push(uid);
                    }
                }
            }
        }
        if done.is_empty() && asked_now.is_empty() {
            return;
        }
        let mut st = loaded(app);
        // A photo deleted in Explorer again meanwhile is a new delete, and stays as it was noted.
        for (uid, asked) in &done {
            if st.untrashed.get(uid) == Some(asked) {
                st.untrashed.remove(uid);
            }
        }
        for uid in &asked_now {
            if st.untrashed.get(uid) == Some(&false) {
                st.untrashed.insert(uid.clone(), true);
            }
        }
        write_untrashed(app, &st.untrashed);
        drop(st);
        if reached > 0 {
            crate::note(app, &format!("[keep] {reached} photos deleted in Explorer reached the trash"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(items: &[&str]) -> HashSet<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    fn fates(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(u, f)| (u.to_string(), f.to_string())).collect()
    }

    fn uids(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn the_power_state_answers_both_flags() {
        let state = power_state();
        assert!(state["saving"].is_boolean());
        assert!(state["metered"].is_boolean());
    }

    #[test]
    fn a_costed_or_limited_connection_holds_the_downloads() {
        assert!(!metered(false, false, false, false, false));
        assert!(metered(true, false, false, false, false));
        assert!(metered(false, true, false, false, false));
        assert!(metered(false, false, true, false, false));
        assert!(metered(false, false, false, true, false));
        assert!(metered(false, false, false, false, true));
    }

    #[test]
    fn the_battery_or_battery_saver_holds_the_downloads() {
        assert!(!saving_power(1, 0));
        assert!(!saving_power(255, 0));
        assert!(saving_power(0, 0));
        assert!(saving_power(1, 1));
    }

    #[test]
    fn modes_round_trip_and_reject_anything_else() {
        for mode in [Mode::Off, Mode::New, Mode::All] {
            assert_eq!(Mode::parse(mode.as_str()), Some(mode));
        }
        assert_eq!(Mode::parse(" all\n"), Some(Mode::All));
        assert_eq!(Mode::parse("everything"), None);
        assert_eq!(Mode::parse(""), None);
    }

    #[test]
    fn the_pass_skips_what_is_local_freed_or_waiting_for_the_trash() {
        let local = set(&["b"]);
        let targets = pass_targets(["a", "b", "c", "d"], |uid| !local.contains(uid), &set(&["c"]), &set(&["d"]));
        assert_eq!(targets, uids(&["a"]));
    }

    #[test]
    fn freeing_new_photos_takes_them_off_the_waiting_arrivals() {
        let (mut freed, mut kept, mut pending) = (set(&[]), set(&["k"]), set(&["a", "b", "c"]));
        let changed = after_free(Mode::New, &uids(&["a", "c", "x"]), &mut freed, &mut kept, &mut pending);
        assert_eq!(changed, (false, false, true));
        assert_eq!(pending, set(&["b"]));
        assert!(freed.is_empty());
        assert_eq!(kept, set(&["k"]));
    }

    #[test]
    fn freeing_with_every_photo_kept_moves_them_to_the_freed_list() {
        let (mut freed, mut kept, mut pending) = (set(&["f"]), set(&["a", "k"]), set(&[]));
        let changed = after_free(Mode::All, &uids(&["a", "b"]), &mut freed, &mut kept, &mut pending);
        assert_eq!(changed, (true, true, false));
        assert_eq!(freed, set(&["f", "a", "b"]));
        assert_eq!(kept, set(&["k"]));
    }

    #[test]
    fn freeing_with_nothing_kept_changes_no_list() {
        let (mut freed, mut kept, mut pending) = (set(&[]), set(&["k"]), set(&["a"]));
        let changed = after_free(Mode::Off, &uids(&["a", "k"]), &mut freed, &mut kept, &mut pending);
        assert_eq!(changed, (false, false, false));
        assert_eq!(pending, set(&["a"]));
        assert_eq!(kept, set(&["k"]));
    }

    #[test]
    fn freeing_photos_not_on_any_list_changes_nothing() {
        let (mut freed, mut kept, mut pending) = (set(&[]), set(&[]), set(&["a"]));
        assert_eq!(after_free(Mode::New, &uids(&["z"]), &mut freed, &mut kept, &mut pending), (false, false, false));
    }

    #[test]
    fn a_photo_freed_while_a_fill_ran_is_not_an_arrival() {
        let arrivals = fresh_arrivals(&uids(&["a", "b", "c"]), &set(&["b"]));
        assert_eq!(arrivals, uids(&["a", "c"]));
        assert!(fresh_arrivals(&uids(&["b"]), &set(&["b"])).is_empty());
    }

    #[test]
    fn a_new_photo_with_a_local_album_copy_is_not_downloaded_again() {
        assert!(needs_download(Mode::New, true, false));
        assert!(!needs_download(Mode::New, true, true));
        assert!(!needs_download(Mode::New, false, true));
        // Keeping every photo still fills the timeline copy itself.
        assert!(needs_download(Mode::All, true, true));
        assert!(!needs_download(Mode::All, false, true));
    }

    #[test]
    fn windows_frees_by_itself_only_while_not_every_photo_is_kept() {
        assert_eq!(os_free(Mode::All, false, true, false), OsFree::Refuse);
        assert_eq!(os_free(Mode::New, false, true, false), OsFree::Record);
        assert_eq!(os_free(Mode::Off, false, true, false), OsFree::Record);
        for mode in [Mode::Off, Mode::New, Mode::All] {
            assert_eq!(os_free(mode, true, true, false), OsFree::Pass);
            assert_eq!(os_free(mode, true, true, true), OsFree::Pass);
        }
    }

    #[test]
    fn a_copy_the_index_does_not_list_is_freed_only_by_the_app() {
        for mode in [Mode::Off, Mode::New, Mode::All] {
            assert_eq!(os_free(mode, false, false, false), OsFree::Refuse);
            assert_eq!(os_free(mode, false, false, true), OsFree::Refuse);
            assert_eq!(os_free(mode, true, false, true), OsFree::Pass);
        }
    }

    #[test]
    fn explorers_free_up_space_frees_even_with_every_photo_kept() {
        for mode in [Mode::Off, Mode::New, Mode::All] {
            assert_eq!(os_free(mode, false, true, true), OsFree::Record);
        }
    }

    #[test]
    fn a_photo_freed_with_every_photo_kept_stays_in_the_cloud() {
        let (mut freed, mut kept, mut pending) = (set(&[]), set(&["a", "b"]), set(&[]));
        assert!(free_counts(Mode::All, freed_copy("Photos\\a.jpg", Some("Photos\\a.jpg"))));
        after_free(Mode::All, &uids(&["a"]), &mut freed, &mut kept, &mut pending);
        let targets = pass_targets(["a", "b"], |_| true, &freed, &set(&[]));
        assert_eq!(targets, uids(&["b"]));
    }

    #[test]
    fn only_the_timeline_copy_is_the_photo_itself() {
        let timeline = Some("Photos\\IMG_1.jpg");
        assert_eq!(freed_copy("Photos\\IMG_1.jpg", timeline), FreedCopy::Timeline);
        assert_eq!(freed_copy("photos\\img_1.JPG", timeline), FreedCopy::Timeline);
        assert_eq!(freed_copy("Albums\\Summer\\IMG_1.jpg", timeline), FreedCopy::Album);
        assert_eq!(freed_copy("Photos\\Favorites\\IMG_1.jpg", timeline), FreedCopy::Album);
        assert_eq!(freed_copy("Albums\\Summer\\IMG_1.jpg", None), FreedCopy::Album);
    }

    #[test]
    fn an_album_copy_freed_counts_only_for_new_photos() {
        for mode in [Mode::Off, Mode::New, Mode::All] {
            assert!(free_counts(mode, FreedCopy::Timeline));
        }
        assert!(free_counts(Mode::New, FreedCopy::Album));
        assert!(!free_counts(Mode::All, FreedCopy::Album));
        assert!(!free_counts(Mode::Off, FreedCopy::Album));
    }

    #[test]
    fn a_new_photo_windows_freed_is_not_downloaded_when_the_pass_resumes() {
        // The pass was paused, so nothing trimmed the arrivals before Windows freed one.
        let (mut freed, mut kept, mut pending) = (set(&[]), set(&[]), set(&["a", "b"]));
        assert_eq!(os_free(Mode::New, false, true, false), OsFree::Record);
        assert!(free_counts(Mode::New, freed_copy("Albums\\Trip\\a.jpg", Some("Photos\\a.jpg"))));
        after_free(Mode::New, &uids(&["a"]), &mut freed, &mut kept, &mut pending);
        let candidates: Vec<&str> = pending.iter().map(String::as_str).collect();
        let targets = pass_targets(candidates, |_| true, &freed, &set(&[]));
        assert_eq!(targets, uids(&["b"]));
    }

    #[test]
    fn a_photo_missing_from_the_listing_alone_is_never_let_go_of() {
        let kept = set(&["a", "b"]);
        let out = release_decision(&uids(&["a", "b"]), &fates(&[("a", "unknown"), ("b", "present")]), &kept, Mode::All);
        assert_eq!(out, Release::default());
    }

    #[test]
    fn a_trashed_photo_is_let_go_of_only_while_every_photo_is_kept_and_only_if_kept_by_it() {
        let kept = set(&["a"]);
        let f = fates(&[("a", "trashed"), ("b", "trashed")]);
        assert_eq!(release_decision(&uids(&["a", "b"]), &f, &kept, Mode::All).let_go, uids(&["a"]));
        assert!(release_decision(&uids(&["a"]), &f, &kept, Mode::New).let_go.is_empty());
        assert!(release_decision(&uids(&["a"]), &f, &kept, Mode::Off).let_go.is_empty());
    }

    #[test]
    fn a_hidden_photo_still_on_drive_leaves_the_plain_folder_in_every_mode() {
        // "hidden" is answered only once Drive said the photo is still there.
        let f = fates(&[("h", "hidden")]);
        for mode in [Mode::Off, Mode::New, Mode::All] {
            assert_eq!(release_decision(&uids(&["h"]), &f, &HashSet::new(), mode).let_go, uids(&["h"]));
        }
    }

    #[test]
    fn a_hidden_photo_deleted_for_good_keeps_its_only_copy() {
        // Hidden and gone is answered "gone": the copy stays, kept or downloaded by hand alike.
        let f = fates(&[("h", "gone")]);
        for mode in [Mode::Off, Mode::New, Mode::All] {
            let kept = release_decision(&uids(&["h"]), &f, &set(&["h"]), mode);
            assert!(kept.let_go.is_empty());
            assert_eq!(kept.forget, uids(&["h"]));
            let by_hand = release_decision(&uids(&["h"]), &f, &HashSet::new(), mode);
            assert_eq!(by_hand, Release::default());
        }
    }

    #[test]
    fn a_hidden_photo_drive_did_not_answer_for_keeps_its_copy() {
        let f = fates(&[("h", "unknown")]);
        for mode in [Mode::Off, Mode::New, Mode::All] {
            assert_eq!(release_decision(&uids(&["h"]), &f, &set(&["h"]), mode), Release::default());
            assert_eq!(release_decision(&uids(&["h"]), &HashMap::new(), &set(&["h"]), mode), Release::default());
        }
    }

    #[test]
    fn a_hidden_photo_in_the_trash_goes_only_by_the_trash_rule() {
        let f = fates(&[("h", "trashed")]);
        assert!(release_decision(&uids(&["h"]), &f, &HashSet::new(), Mode::All).let_go.is_empty());
        assert!(release_decision(&uids(&["h"]), &f, &set(&["h"]), Mode::New).let_go.is_empty());
        assert_eq!(release_decision(&uids(&["h"]), &f, &set(&["h"]), Mode::All).let_go, uids(&["h"]));
    }

    #[test]
    fn a_hidden_copy_is_named_by_its_full_uid_for_drive() {
        let listed = ["VOLUMEabcdef==~link1", "VOLUMEabcdef==~link2"];
        // An album photo is hidden by its full uid.
        assert_eq!(hidden_copy_uid("Eabcdef==~x", "VOL~x", listed).as_deref(), Some("VOL~x"));
        // A photo hidden on its own is a bare link id: the volume comes from the listing.
        assert_eq!(hidden_copy_uid("abcdef==~hid9", "hid9", listed).as_deref(), Some("VOLUMEabcdef==~hid9"));
        // A volume nothing listed ends with, or a tail without one, tells nothing: the copy stays.
        assert_eq!(hidden_copy_uid("zzzz==~hid9", "hid9", listed), None);
        assert_eq!(hidden_copy_uid("hid9", "hid9", listed), None);
        assert_eq!(hidden_copy_uid("abcdef==~other", "hid9", listed), None);
        assert_eq!(hidden_copy_uid("abcdef==~hid9", "hid9", std::iter::empty()), None);
    }

    #[test]
    fn a_photo_deleted_for_good_keeps_its_copy_as_the_users_own() {
        let out = release_decision(&uids(&["g"]), &fates(&[("g", "gone")]), &set(&["g"]), Mode::All);
        assert!(out.let_go.is_empty());
        assert_eq!(out.forget, uids(&["g"]));
    }

    #[test]
    fn too_many_trashed_at_once_are_held_for_the_user() {
        let all: Vec<String> = (0..100).map(|i| format!("p{i}")).collect();
        let kept: HashSet<String> = all.iter().cloned().collect();
        let mut f: HashMap<String, String> = all.iter().take(30).map(|u| (u.clone(), "trashed".to_string())).collect();
        f.insert("p99".into(), "hidden".into());
        let candidates: Vec<String> = all.iter().take(30).cloned().chain(["p99".to_string()]).collect();
        let out = release_decision(&candidates, &f, &kept, Mode::All);
        assert_eq!(out.held.len(), 30);
        // Hidden is a privacy matter, so it never waits behind the cap.
        assert_eq!(out.let_go, uids(&["p99"]));
    }

    #[test]
    fn the_cap_scales_with_the_library_and_never_drops_below_25() {
        assert_eq!(release_cap(0), 25);
        assert_eq!(release_cap(100), 25);
        assert_eq!(release_cap(10_000), 1_000);
    }

    #[test]
    fn a_download_leaves_the_floor_and_room_for_its_staged_copy() {
        let mb = 1024 * 1024;
        assert!(space_ok(SPACE_FLOOR + 20 * mb, 10 * mb));
        assert!(!space_ok(SPACE_FLOOR + 19 * mb, 10 * mb));
        assert!(!space_ok(0, 0));
        assert!(space_ok(SPACE_FLOOR, 0));
    }

    #[test]
    fn lists_read_back_what_was_written() {
        let original = set(&["b~x", "a~y"]);
        assert_eq!(parse_list(&join_list(&original)), original);
        assert_eq!(parse_list("\n a \n\n"), set(&["a"]));
    }

    #[test]
    fn the_trash_is_asked_once_more_and_a_restore_after_that_stands() {
        assert_eq!(untrashed_step(Some("present"), false), Untrashed::Ask);
        assert_eq!(untrashed_step(Some("hidden"), false), Untrashed::Ask);
        assert_eq!(untrashed_step(Some("present"), true), Untrashed::Done);
        assert_eq!(untrashed_step(Some("hidden"), true), Untrashed::Done);
        for asked in [false, true] {
            assert_eq!(untrashed_step(Some("trashed"), asked), Untrashed::Done);
            assert_eq!(untrashed_step(Some("gone"), asked), Untrashed::Done);
            assert_eq!(untrashed_step(Some("unknown"), asked), Untrashed::Wait);
            assert_eq!(untrashed_step(None, asked), Untrashed::Wait);
        }
    }

    #[test]
    fn the_trash_answer_is_read_per_photo() {
        let answer = serde_json::json!([
            { "uid": "a", "ok": true },
            { "uid": "b", "ok": false, "error": "no" },
            { "ok": true },
            { "uid": "c" },
        ]);
        assert_eq!(trashed_uids(&answer), set(&["a"]));
        // The shape the earlier reading expected is no answer at all.
        assert!(trashed_uids(&serde_json::json!({ "ok": true })).is_empty());
        assert!(trashed_uids(&serde_json::json!([])).is_empty());
    }

    #[test]
    fn the_untrashed_list_keeps_whether_the_trash_was_asked() {
        let list: HashMap<String, bool> = [("v~a".to_string(), false), ("v~b".to_string(), true)].into_iter().collect();
        let text = join_untrashed(&list);
        assert_eq!(text, "v~a new\nv~b");
        assert_eq!(parse_untrashed(&text), list);
        // What the builds before wrote: bare uids, each asked on every round already.
        let legacy = parse_untrashed("v~c\n\n v~d \n");
        assert_eq!(legacy.get("v~c"), Some(&true));
        assert_eq!(legacy.get("v~d"), Some(&true));
        assert_eq!(legacy.len(), 2);
    }
}
