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

// Tauri host: owns the encrypted app store, spawns the Node sidecar (which runs
// the official Proton Drive SDK), and relays newline-delimited JSON-RPC to it,
// one request at a time.

// Public for the same reason as the two below: the installer compiles this file too,
// so that uninstalling takes the Run entry with it.
pub mod autostart;
mod cloud_mount;
mod explorer_rules;
#[cfg(windows)]
mod explorer_sync;
// Public because the installer compiles this same file (see its header), and a
// module the app itself never reads would otherwise read as dead code.
pub mod data_format;
// Public for the same reason: the installer compiles this one too, and the identity
// constants in it are the installer's to read, not the app's.
pub mod file_assoc;
#[cfg(not(windows))]
mod files_drive;
mod notices;
mod local_file;
mod local_folder;
mod photo_edit;
mod secure_store;
mod update_sig;
mod upload_frame;
mod window_place;

use std::collections::BinaryHeap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::webview::WebviewBuilder;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, WebviewUrl};

/// The response router, shared with the reader thread. Each in-flight request registers
/// a one-shot sender under its id; the reader delivers each response line to the matching
/// sender and drops the entry. A response whose waiter is gone — timed out, or on a
/// sidecar since replaced — finds no entry and is discarded. This is what lets more than
/// one request be in flight: the reader matches each answer to its asker by id rather than
/// assuming the next line answers the one call that could have been outstanding.
type Router =
    std::sync::Arc<std::sync::Mutex<std::collections::HashMap<u64, std::sync::mpsc::SyncSender<serde_json::Value>>>>;

struct Sidecar {
    child: Child,
    /// Held (through the sidecar mutex) only for the brief write of one request line; the
    /// wait for a response takes no lock, so requests on the two lanes overlap.
    stdin: ChildStdin,
    next_id: u64,
    /// Where the reader thread `spawn_sidecar` starts delivers each response, keyed by id.
    /// Reading through a channel rather than straight off the pipe is also what makes a
    /// deadline possible: a blocking `read_line` cannot be given one.
    router: Router,
    /// Which spawn this is. A response wait that fails re-locks and drops the sidecar only
    /// when this still matches, so a slow failure never kills a fresh sidecar a concurrent
    /// caller has already put in its place.
    generation: u64,
}

/// Dropping a sidecar means it is finished with, so the process goes too. Nothing
/// else ends it: `Child`'s own drop leaves it running, and for the case this exists
/// for, a sidecar that stopped answering, that would strand a wedged process holding
/// the unlocked session for as long as the app runs.
impl Drop for Sidecar {
    fn drop(&mut self) {
        // Deliberately not waited on: a wedged process must not be able to block
        // whoever is dropping it.
        let _ = self.child.kill();
    }
}

// ---- The sidecar admission gate ----
//
// Every sidecar RPC is serialized through a single channel: exactly one request may
// be in flight, because `do_io` writes one line and reads until the first JSON line
// without matching on a request id, so a second concurrent request would read the
// first's response. That invariant is absolute and this gate never relaxes it.
//
// What the gate adds is ORDER. When the channel is busy and several callers are
// waiting, `std::sync::Mutex` on Windows (an unfair SRWLOCK) would hand the channel
// to an arbitrary waiter next, so an interactive click could sit behind a queued
// background thumbnail batch. The gate instead admits the highest-priority waiter,
// and the oldest within that priority, so a click never waits on a warm.

/// How urgently one RPC should be admitted to the single sidecar channel. The derived
/// `Ord` follows declaration order, so `Interactive` is the greatest and wins the
/// waiter max-heap.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
enum Priority {
    /// Whole-library name/size enumeration for the Explorer mount and the search
    /// index. Below `Background` on purpose, so thumbnail warming always beats it: on
    /// a cold first run every new photo still costs one node decrypt, and putting that
    /// sweep here lets the grid fill from cached thumbnails while the mount enumerates
    /// behind it. Later runs read the enumeration from cache and finish in a blink.
    Enumerate,
    /// Whole-library warming and mount bookkeeping: yields to everything above it.
    Background,
    /// The default for any request not named in `priority_for` (user-driven
    /// mutations, and any newly added method), so nothing is ever accidentally
    /// starved at the bottom.
    UserAction,
    /// The user is blocked on this exact result: opening a photo/video or its
    /// details, Explorer opening a placeholder, and session lifecycle.
    Interactive,
}

/// The method -> priority map. Exhaustive for the methods we know; anything unlisted
/// falls to `UserAction` (never `Background`), so an unrecognised or newly added
/// method is never buried under the warmer.
fn priority_for(method: &str) -> Priority {
    match method {
        // The user is waiting on the answer.
        "getPreview" | "getVideo" | "getNodeDetails" | "hydrateFile" | "startHydrate"
        // Session lifecycle: must never sit behind a warm.
        | "__init" | "ping" | "lock" | "unlock" | "signOut" | "unlockDevice"
        | "startBrowserLogin" | "browserLoginStatus" | "cancelBrowserLogin"
        | "protectSession" | "retryResume" | "cachedAlbumPhotoUids" | "semanticModelStatus"
        | "semanticSearch" | "faceModelStatus" | "faceModelDownload" | "detectFaces" => Priority::Interactive,

        // The viewer's full-resolution upgrade. Deliberately a tier BELOW the preview,
        // even though the user is looking at that photo: the transfer itself runs inside
        // the sidecar and never touches this channel, so these two calls only start it
        // and read its progress, and both return in microseconds. Keeping them here means
        // the preview of a photo the user just stepped to is always admitted first — the
        // preview is what makes the viewer feel instant, the upgrade is the luxury on top.
        // Interactive bursts are finite, so neither call can be starved for long.
        //
        // `readOriginalBytes` is the one call in this group that carries real weight: it
        // hands a whole photo over the channel. It sits in the same tier for the same
        // reason, and it must never be raised — a preview the user is waiting on would
        // then queue behind a multi-megabyte transfer. The sidecar caps what may take
        // this route so the hold stays under the gate's perceptual budget; anything
        // larger is staged as a file and never appears here at all.
        "getOriginal" | "releaseOriginal" | "readOriginalBytes" => Priority::UserAction,

        // Whole-library name/size enumeration: the slowest sweeps, and the only ones
        // that decrypt a node per photo on a cold run. Below warming so a cold first
        // run fills the grid from thumbnails while these enumerate the mount behind it.
        "listForMount" | "getMetadata" | "getLocations" => Priority::Enumerate,

        // Warming and mount bookkeeping: whole-library sweeps that must yield.
        "warmThumbnails" | "listAlbumsForMount" | "listExtrasForMount"
        | "getAlbumPhotoUids" | "heapStats"
        | "whoami" | "getAccountInfo" | "getSharingInfo" | "listInvitations"
        | "checkUpdate" | "downloadUpdate" | "getDriveCollections" => Priority::Background,

        // What a page on screen is drawing: its thumbnails and its lists. These fall
        // through to `UserAction` below, named here so no one moves them back under the
        // warmer, behind which a page stayed empty for as long as a cold batch took.
        "getThumbnails" | "getAlbums" | "getAlbumPhotos" | "getShared" => Priority::UserAction,

        // Everything else: user-driven mutations and any method not named above.
        _ => Priority::UserAction,
    }
}

/// One waiter's place in line: its priority, then its arrival order. `Ord` makes a
/// higher priority greater and, within one priority, an EARLIER arrival greater, so
/// the max-heap's peek is always the highest-priority, longest-waiting caller (FIFO
/// within a priority).
#[derive(Clone, Copy, PartialEq, Eq)]
struct Ticket {
    prio: Priority,
    seq: u64,
}

impl Ord for Ticket {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        // Higher priority first; ties broken by the SMALLER seq (earlier arrival),
        // which must compare as greater so it sits at the top of the max-heap.
        self.prio
            .cmp(&other.prio)
            .then_with(|| other.seq.cmp(&self.seq))
    }
}

impl PartialOrd for Ticket {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

/// The id a cancellable call is known by, minted by the frontend.
///
/// Only a call the frontend explicitly marks this way can ever be dropped: everything
/// else, every mutation included, reaches the sidecar exactly as before.
type CallId = u64;

/// What a call the frontend let go of answers with. It is not a failure and no caller
/// reports it: the one thing that asks for a cancellable call already treats a missing
/// answer the same as a failed one.
const CANCELLED: &str = "rpc cancelled";

/// Which lane a priority runs on. The whole-library sweeps and warming (`Enumerate`,
/// `Background`) share the one background lane; everything the user is waiting on runs on
/// the foreground lane. That split is what stops a viewer's full-resolution upgrade from
/// queueing behind a search-index sweep or a thumbnail warm: they are never in the same
/// line.
fn is_background(prio: Priority) -> bool {
    matches!(prio, Priority::Background | Priority::Enumerate)
}

/// The waiter queues, guarded by the gate's own mutex. That mutex is held only for the
/// brief moments of joining a queue, checking the head, and releasing — never across the
/// RPC itself, so callers can keep queueing while requests are in flight.
struct GateState {
    /// One in-flight slot per lane. At most one foreground and one background call run
    /// at a time, so never more than two overlap. The two lanes only ever touch disjoint
    /// sidecar state (the foreground viewer path holds the `viewing` original and the HD
    /// preview cache; the background sweeps read metadata and fill the grid-thumbnail
    /// cache), so the overlap introduces no race that a single channel would prevent.
    fg_busy: bool,
    bg_busy: bool,
    /// Monotonic arrival counter, for FIFO ordering within a priority.
    next_seq: u64,
    fg_waiters: BinaryHeap<Ticket>,
    bg_waiters: BinaryHeap<Ticket>,
}

/// A two-lane priority admission gate in front of the sidecar channel.
///
/// The invariant: at most one RPC per lane is ever in flight, so at most two overlap.
/// Within a lane the gate decides WHICH queued caller goes next when that lane frees up
/// (the highest priority, oldest within it); it never lets two callers share a lane.
///
/// Starvation within a lane is intentional and bounded: a `Background` waiter yields to
/// every other background caller ahead of it and runs once they drain. Across lanes there
/// is no starvation at all: the foreground lane is entirely independent of the background
/// one, which is the whole reason the split exists.
struct Gate {
    state: Mutex<GateState>,
    admit: Condvar,
}

/// Proof of admission from `acquire`. Releasing the lane is tied to dropping this, so
/// every exit path — an early `?`, an error, a panic — frees it for the next waiter.
struct GatePermit<'a> {
    gate: &'a Gate,
    /// Which lane this permit holds, so its release clears the right one.
    background: bool,
}

impl Drop for GatePermit<'_> {
    fn drop(&mut self) {
        let mut st = self.gate.state.lock().unwrap();
        if self.background {
            st.bg_busy = false;
        } else {
            st.fg_busy = false;
        }
        // notify_all, not notify_one: a single wake could land on a waiter that is not
        // the head of its lane, which would then re-check, see it is not first in line,
        // and go back to sleep while the true head keeps sleeping — a stall. Waking all
        // lets each lane's head win and the rest re-queue.
        self.gate.admit.notify_all();
    }
}

impl Gate {
    fn new() -> Self {
        Gate {
            state: Mutex::new(GateState {
                fg_busy: false,
                bg_busy: false,
                next_seq: 0,
                fg_waiters: BinaryHeap::new(),
                bg_waiters: BinaryHeap::new(),
            }),
            admit: Condvar::new(),
        }
    }

    /// Take a place in line at `prio` and block until this caller's lane is free AND this
    /// caller is the head of that lane. The wait is a predicate loop, as it must be:
    /// `notify_all` wakes every waiter and the OS may wake one spuriously, so a wake is
    /// only a hint to re-check, never permission to proceed. Checking the predicate under
    /// the same mutex that guards the lane is what makes a lost wakeup impossible.
    fn acquire(&self, prio: Priority) -> GatePermit<'_> {
        // A caller with nothing to abandon it can only leave this loop by being
        // admitted, so the `None` arm below is unreachable for it.
        self.acquire_unless(prio, &|| false)
            .expect("a caller that cannot be abandoned is always admitted")
    }

    /// The same, for a caller that may be given up on while it queues.
    ///
    /// `abandoned` is re-read on every wake, under the gate's own mutex, so a caller
    /// that has been let go of leaves the queue at the next wake rather than waiting to
    /// reach the head. `None` means it left: nothing was written to the sidecar and no
    /// lane was ever held, which is the whole point of this. A superseded call costs a
    /// heap pop, not a round trip.
    fn acquire_unless(&self, prio: Priority, abandoned: &dyn Fn() -> bool) -> Option<GatePermit<'_>> {
        let background = is_background(prio);
        let mut st = self.state.lock().unwrap();
        let seq = st.next_seq;
        st.next_seq = st.next_seq.wrapping_add(1);
        let me = Ticket { prio, seq };
        if background {
            st.bg_waiters.push(me);
        } else {
            st.fg_waiters.push(me);
        }
        loop {
            let ready = if background {
                !st.bg_busy && st.bg_waiters.peek() == Some(&me)
            } else {
                !st.fg_busy && st.fg_waiters.peek() == Some(&me)
            };
            if ready {
                break;
            }
            if abandoned() {
                // The seq is unique, so this takes out exactly this caller's ticket.
                if background {
                    st.bg_waiters.retain(|t| *t != me);
                } else {
                    st.fg_waiters.retain(|t| *t != me);
                }
                drop(st);
                // Leaving cannot promote anyone who was not already admissible, so this
                // is belt-and-braces rather than load-bearing.
                self.admit.notify_all();
                return None;
            }
            st = self.admit.wait(st).unwrap();
        }
        if background {
            st.bg_waiters.pop();
            st.bg_busy = true;
        } else {
            st.fg_waiters.pop();
            st.fg_busy = true;
        }
        Some(GatePermit { gate: self, background })
    }

    /// Re-check every waiter's predicate now. Taking the same mutex the wait is
    /// predicated on is what makes the wake impossible to miss: a waiter can only be
    /// between reading its predicate and sleeping on it while it holds that mutex.
    fn wake_all(&self) {
        let _held = self.state.lock().unwrap();
        self.admit.notify_all();
    }

    /// The number of callers currently queued, across both lanes. Test-only: lets a test
    /// line callers up in a known order before releasing the holder.
    #[cfg(test)]
    fn queued(&self) -> usize {
        let st = self.state.lock().unwrap();
        st.fg_waiters.len() + st.bg_waiters.len()
    }
}

/// The sidecar channel behind its two-lane gate. The `Sidecar` itself stays an `Option`
/// (spawned lazily, dropped and respawned after a transport error). It is now reached by
/// more than one caller at once: the write of each request is serialised by its mutex,
/// but the wait for each response holds no lock, so a foreground and a background call
/// overlap. Answers are matched to their askers by id through the sidecar's router.
struct SidecarGate {
    gate: Gate,
    sidecar: Mutex<Option<Sidecar>>,
    /// Bumped on every spawn, so a response wait that fails drops only the sidecar it
    /// actually used, never a fresh one put in place after a shared failure.
    generation: std::sync::atomic::AtomicU64,
    /// Every cancellable call that is queued or in flight, against whether the frontend
    /// has since let go of it.
    ///
    /// An entry exists only between a call arriving and it answering, and a cancel that
    /// names anything else is dropped rather than remembered. That is what bounds this:
    /// it can never hold more than the calls actually outstanding, however many cancels
    /// arrive late.
    pending: Mutex<std::collections::HashMap<CallId, bool>>,
}

/// Keeps one call in `pending` for exactly as long as it is outstanding. Tied to a drop
/// so that every exit path takes its entry with it: an early return, an error, a panic.
struct Tracked<'a> {
    shared: &'a SidecarGate,
    id: CallId,
}

impl Drop for Tracked<'_> {
    fn drop(&mut self) {
        self.shared.pending.lock().unwrap().remove(&self.id);
    }
}

impl SidecarGate {
    fn new() -> Self {
        SidecarGate {
            gate: Gate::new(),
            sidecar: Mutex::new(None),
            generation: std::sync::atomic::AtomicU64::new(0),
            pending: Mutex::new(std::collections::HashMap::new()),
        }
    }

    /// A fresh spawn id. Only the failure paths compare it, so `Relaxed` ordering is
    /// enough: it orders nothing but itself.
    fn next_generation(&self) -> u64 {
        self.generation
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    }

    /// Start following a cancellable call. Idempotent, and deliberately so: the call is
    /// registered on the way in from the frontend AND again once it reaches a pool
    /// thread, and the second must not wipe a cancel that landed between the two.
    fn track(&self, id: CallId) {
        self.pending.lock().unwrap().entry(id).or_insert(false);
    }

    /// Let go of a call. Ignored unless it is still outstanding, which is what keeps a
    /// cancel that lost the race to its own answer from leaving anything behind.
    fn abandon(&self, id: CallId) {
        let found = {
            let mut pending = self.pending.lock().unwrap();
            match pending.get_mut(&id) {
                Some(flag) => {
                    *flag = true;
                    true
                }
                None => false,
            }
        };
        // The `pending` lock is released first, on purpose: the queue's own predicate
        // reads `pending` while holding the gate's mutex, so taking them in that order
        // here too is what keeps the two from ever being taken in opposite orders.
        if found {
            self.gate.wake_all();
        }
    }

    fn is_abandoned(&self, id: CallId) -> bool {
        self.pending.lock().unwrap().get(&id).copied().unwrap_or(false)
    }

    /// How many calls are being followed. Test-only: what makes "a late cancel leaves
    /// nothing behind" something a test can actually assert.
    #[cfg(test)]
    fn tracked(&self) -> usize {
        self.pending.lock().unwrap().len()
    }

    /// Queue for the channel, or `None` for a call the frontend has let go of.
    ///
    /// Checked on the way in, throughout the wait, and once more on admission. The last
    /// of those is what covers a call given up on while it queued: the channel is free
    /// either way at that point, so there is nothing to gain by spending it on an
    /// answer nobody is waiting for.
    fn admit(&self, method: &str, call_id: Option<CallId>) -> Option<GatePermit<'_>> {
        let prio = priority_for(method);
        let Some(id) = call_id else {
            return Some(self.gate.acquire(prio));
        };
        if self.is_abandoned(id) {
            return None;
        }
        let permit = self.gate.acquire_unless(prio, &|| self.is_abandoned(id))?;
        if self.is_abandoned(id) {
            return None; // dropping the permit hands the channel straight on
        }
        Some(permit)
    }

    /// Run one RPC end to end: queue by the method's priority and, once admitted, hold
    /// the channel exclusively while writing the request and reading its response.
    /// A call that waited to be admitted or held the channel long enough to be felt
    /// records both figures, so the cost of the queue stays measurable where it
    /// matters. Only the method name is logged (never params or ids): it is not user
    /// data.
    ///
    /// `call_id` marks a call the frontend may abandon while it queues. Without one the
    /// call is uncancellable and runs exactly as it always has, which is what keeps
    /// every mutation out of reach of this.
    fn rpc(
        &self,
        app: &AppHandle,
        method: String,
        params: serde_json::Value,
        call_id: Option<CallId>,
    ) -> Result<serde_json::Value, String> {
        let _tracked = call_id.map(|id| {
            self.track(id);
            Tracked { shared: self, id }
        });

        let wait_start = Instant::now();
        let permit = self.admit(&method, call_id);
        let wait_ms = wait_start.elapsed().as_millis();

        let Some(permit) = permit else {
            // Nothing was written and the channel was never held, so there is no hold to
            // report: the wait is the whole of what this call cost.
            if wait_ms >= SLOW_RPC_MS {
                note(app, &format!("[rpc] {method} wait={wait_ms} dropped"));
            }
            return Err(CANCELLED.to_string());
        };

        let hold_start = Instant::now();
        let result = self.io(app, &method, params);
        let hold_ms = hold_start.elapsed().as_millis();

        // Release the channel BEFORE logging, so the log write never extends the hold
        // and makes the next waiter wait on this call's file I/O.
        drop(permit);
        if wait_ms >= SLOW_RPC_MS || hold_ms >= SLOW_RPC_MS {
            note(app, &format!("[rpc] {method} wait={wait_ms} hold={hold_ms}"));
        }
        result
    }

    /// Send one request and wait for its answer. The write is done under the sidecar
    /// mutex — brief, and it serialises the one shared resource, stdin — but the wait for
    /// the response is not, so a foreground call and a background call genuinely overlap.
    /// Spawns the sidecar lazily, and drops it after a transport error so the next call
    /// respawns; on the wait's own failure it drops only the sidecar this call used, never
    /// a fresh one a concurrent caller has since put in place.
    fn io(
        &self,
        app: &AppHandle,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        // Send, under the lock: spawn if needed, register the waiter, write the line.
        let (generation, rx) = {
            let mut guard = self
                .sidecar
                .lock()
                .map_err(|_| "sidecar lock poisoned".to_string())?;
            if guard.is_none() {
                let generation = self.next_generation();
                *guard = Some(spawn_sidecar(app, generation)?);
                // Any spawn after the first replaces one that held the signed-in session,
                // which went with it. The window is told, so it can unlock again or show
                // the lock screen instead of failing every call as if still signed in.
                if generation > 0 {
                    use tauri::Emitter;
                    note(app, "[host] sidecar replaced, session lost");
                    wake_to_restore(app);
                    let _ = app.emit("sidecar-restarted", generation);
                }
            }
            let sc = guard.as_mut().unwrap();
            let generation = sc.generation;
            match send_request(sc, method, params) {
                Ok(rx) => (generation, rx),
                Err(e) => {
                    // The write failed, so this sidecar is suspect: drop it while the lock
                    // is already held and let the next call spawn a fresh one.
                    *guard = None;
                    return Err(e);
                }
            }
        };

        // Wait, with no lock held, so the other lane's call is free to run alongside this.
        let deadline = Instant::now() + deadline_for(method);
        match recv_response(&rx, deadline, method) {
            Ok(value) => Ok(value),
            Err(e) => {
                // A stuck or dead sidecar: drop it so the next call respawns, but only when
                // it is still the one this call used. A slow timeout must not take out a
                // healthy sidecar a concurrent caller spawned after a shared failure.
                let mut guard = self
                    .sidecar
                    .lock()
                    .map_err(|_| "sidecar lock poisoned".to_string())?;
                if guard.as_ref().map(|s| s.generation) == Some(generation) {
                    *guard = None;
                }
                Err(e)
            }
        }
    }
}

type SharedSidecar = Arc<SidecarGate>;

fn sidecar_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../sidecar")
}

/// Windows APIs hand back verbatim paths (`\\?\C:\...`). Rust opens them fine,
/// but Node cannot: its main-module resolver walks such a path down to a bare
/// `C:` and dies with `EISDIR`. Strip the prefix before handing a path over.
pub(crate) fn strip_verbatim(path: std::path::PathBuf) -> std::path::PathBuf {
    match path.to_str().and_then(|s| s.strip_prefix(r"\\?\")) {
        Some(rest) => std::path::PathBuf::from(rest),
        None => path,
    }
}

/// In a packaged build the sidecar ships as two pieces: a Node runtime copied
/// next to the app executable as `sidecar.exe`, and the bundled script beside it
/// under `sidecar/`, with sharp's native addon in `sidecar/node_modules`.
fn packaged_command(app: &AppHandle) -> Result<Command, String> {
    let result = locate_packaged_sidecar(app);
    if let Err(message) = &result {
        // A packaged build has no console and the frontend swallows this error,
        // so leave a trace on disk or a failure is invisible.
        note(app, message);
    }
    let (runtime, script) = result?;

    let mut command = Command::new(runtime);
    command.arg(script);
    // Tell the sidecar this is the packaged build, so it keeps library console
    // output out of the on-disk log (only our own scrubbed lines are persisted).
    command.env("SIDECAR_RELEASE", "1");
    // This app's version, so the updater can take the update installer made for it.
    command.env("PFP_APP_VERSION", app.package_info().version.to_string());
    // The process that holds the unlocked session reads none of these from whatever
    // environment the app was started in: each would let something else run code in
    // it (`NODE_OPTIONS=--require`, a module path) or turn its TLS checks off. A
    // corporate CA added through NODE_EXTRA_CA_CERTS still applies, as it only adds trust.
    for var in [
        "NODE_OPTIONS",
        "NODE_PATH",
        "NODE_TLS_REJECT_UNAUTHORIZED",
        "NODE_REPL_EXTERNAL_MODULE",
        "NODE_V8_COVERAGE",
        "NODE_DEBUG",
    ] {
        command.env_remove(var);
    }
    Ok(command)
}

fn locate_packaged_sidecar(app: &AppHandle) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    let exe_dir = strip_verbatim(
        std::env::current_exe()
            .map_err(|e| format!("cannot locate the app executable: {e}"))?
            .parent()
            .ok_or("the app executable has no parent directory")?
            .to_path_buf(),
    );

    // The installer keeps the runtime under a `resources\` subfolder so the
    // install folder's top level stays tidy: <install>\resources\sidecar.exe and
    // <install>\resources\sidecar\server.mjs.
    let res = exe_dir.join("resources");
    // The node runtime binary. On non-Windows it cannot be named `sidecar`, because
    // `sidecar/` is the directory holding server.mjs and its node_modules right next to
    // it, and a name is either a file or a directory. Windows sidesteps this with the
    // `.exe` suffix, so it keeps `sidecar.exe` beside `sidecar/`.
    let runtime = res.join(if cfg!(windows) { "sidecar.exe" } else { "sidecar-runtime" });

    let beside = res.join("sidecar").join("server.mjs");
    let script = if beside.exists() {
        beside
    } else {
        strip_verbatim(
            app.path()
                .resource_dir()
                .map_err(|e| format!("cannot locate app resources: {e}"))?
                .join("sidecar")
                .join("server.mjs"),
        )
    };

    if !runtime.exists() || !script.exists() {
        return Err(format!(
            "sidecar missing: runtime {} (exists: {}), script {} (exists: {})",
            runtime.display(),
            runtime.exists(),
            script.display(),
            script.exists()
        ));
    }
    Ok((runtime, script))
}

// ---- The on-disk log ----
//
// One file, written from two places: the host appends through `note`, and the
// sidecar's stderr is redirected straight into it at spawn. It is also the one
// artefact a user is likely to hand over when something goes wrong, so everything
// that reaches it is scrubbed first and the file itself stays bounded.

/// Roll over past roughly a megabyte, keeping one previous file. Large enough to
/// hold a long session of the lines that survive `SLOW_RPC_MS`, small enough to
/// send on.
const LOG_MAX_BYTES: u64 = 1_000_000;

/// Below this a call is simply working. The per-RPC line exists to catch one that
/// queued or held the channel long enough for someone to feel it, and that is the
/// only version of it worth reading back later: at a quarter of a second per
/// thumbnail, logging every call made the file 98 percent scroll noise.
const SLOW_RPC_MS: u128 = 1_000;

/// Serializes rotation against the appends around it, so one thread cannot empty the
/// file between another's size check and its write.
static LOG_LOCK: Mutex<()> = Mutex::new(());

/// The shared log, and the single previous file kept beside it.
fn log_paths(app: &AppHandle) -> Option<(std::path::PathBuf, std::path::PathBuf)> {
    let dir = secure_store::app_dir(app).ok()?;
    Some((dir.join("sidecar.log"), dir.join("sidecar.log.1")))
}

/// Roll the log over once it passes `LOG_MAX_BYTES`.
///
/// Copied then TRUNCATED in place, never renamed: the sidecar's stderr handle was
/// opened on this file at spawn and follows the file itself rather than its name, so
/// a rename would leave the sidecar writing into the archive, which would then grow
/// without limit and defeat the rotation entirely. Truncating is safe for that same
/// handle because it is in append mode, so its next write lands at the start of the
/// emptied file instead of at a stale offset.
fn rotate_log(live: &std::path::Path, previous: &std::path::Path) {
    let full = std::fs::metadata(live).map(|m| m.len() >= LOG_MAX_BYTES).unwrap_or(false);
    if !full {
        return;
    }
    let _ = std::fs::copy(live, previous);
    let _ = std::fs::OpenOptions::new()
        .write(true)
        .open(live)
        .and_then(|f| f.set_len(0));
}

/// Append a host-side line to the same log the sidecar's stderr goes to.
///
/// Scrubbed here rather than at the call sites, so a line is safe whatever it was
/// handed. Several callers pass an error string straight through from the SDK, and
/// what one of those contains cannot be predicted from here.
/// Wall-clock time of day, UTC, for the front of a log line.
///
/// A log with no clock in it cannot answer "did these two things happen together",
/// which is the question every startup fault turns into. The date is left off: the
/// file is small and rotates, and the time of day is what lines up with a report.
fn stamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let t = secs % 86_400;
    format!("[{:02}:{:02}:{:02}]", t / 3600, (t % 3600) / 60, t % 60)
}

pub(crate) fn note(app: &AppHandle, message: &str) {
    let Some((live, previous)) = log_paths(app) else {
        return;
    };
    // Built whole and written once. `writeln!` on an unbuffered file emits each
    // fragment of the format as its own append, so two threads logging at the same
    // moment interleave and both lines come out mangled.
    let mut line = String::with_capacity(message.len() + 32);
    line.push_str(&stamp());
    line.push(' ');
    line.push_str("[host] ");
    line.push_str(&scrub(message));
    line.push('\n');
    // Poisoning is not a reason to stop logging, so the guard is taken either way.
    let _guard = LOG_LOCK.lock();
    rotate_log(&live, &previous);
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&live) {
        let _ = file.write_all(line.as_bytes());
    }
}

/// Redact anything shaped like key material or personal data before it can reach the
/// log. The sidecar scrubs its own lines the same way before writing them; this is
/// the host's half of the same job.
///
/// The order is what makes it work: a URL or a Windows path is taken whole first, so
/// the long-run rule cannot chew a hole in the middle of one and leave the rest
/// standing.
fn scrub(message: &str) -> String {
    let s = scrub_pgp(message);
    let s = scrub_urls(&s);
    let s = scrub_emails(&s);
    let s = scrub_user(&s);
    // Control characters, but for the newline and tab a stack trace is made of: a
    // carriage return or an escape sequence in a message would otherwise forge a line
    // of its own, or repaint the terminal someone reads the log in.
    scrub_runs(&s)
        .chars()
        .map(|c| if c.is_control() && c != '\n' && c != '\t' { '?' } else { c })
        .collect()
}

/// A PGP armor block, whatever it turns out to hold.
fn scrub_pgp(s: &str) -> String {
    const BEGIN: &str = "-----BEGIN ";
    const END: &str = "-----END";
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find(BEGIN) {
        // Only a block that closes is a block; a line that merely starts like one is
        // left alone rather than swallowing everything after it.
        let after = &rest[start + BEGIN.len()..];
        let Some(end) = after.find(END) else { break };
        let tail = &after[end + END.len()..];
        let Some(close) = tail.find("-----") else { break };
        out.push_str(&rest[..start]);
        out.push_str("[redacted PGP block]");
        rest = &tail[close + 5..];
    }
    out.push_str(rest);
    out
}

/// A URL, from its scheme to the next space. The host of a Proton endpoint is
/// harmless, but the path and query behind it carry node ids and share tokens.
fn scrub_urls(s: &str) -> String {
    const SCHEMES: [&str; 5] = ["https://", "http://", "wss://", "ws://", "file://"];
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    loop {
        // The earliest scheme left in the string, so a later one cannot hide an
        // earlier one of a different kind.
        let Some(start) = SCHEMES.iter().filter_map(|p| rest.find(*p)).min() else {
            break;
        };
        let end = rest[start..]
            .find(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '<' | '>'))
            .map(|i| start + i)
            .unwrap_or(rest.len());
        out.push_str(&rest[..start]);
        out.push_str("[redacted url]");
        rest = &rest[end..];
    }
    out.push_str(rest);
    out
}

/// An email address, local part and domain both: an SDK failure can name the account
/// it failed for.
fn scrub_emails(s: &str) -> String {
    fn local(c: u8) -> bool {
        c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'%' | b'+' | b'-')
    }
    fn domain(c: u8) -> bool {
        c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-')
    }
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut copied = 0;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'@' {
            i += 1;
            continue;
        }
        let mut start = i;
        while start > copied && local(bytes[start - 1]) {
            start -= 1;
        }
        let mut end = i + 1;
        while end < bytes.len() && domain(bytes[end]) {
            end += 1;
        }
        // Both halves have to be there, and a domain needs a dot inside it to be one,
        // so a bare "@" or a "12@34" version string is left as it is.
        let host = s[i + 1..end].trim_end_matches('.');
        if start == i || !host.contains('.') {
            i += 1;
            continue;
        }
        out.push_str(&s[copied..start]);
        out.push_str("[redacted email]");
        copied = end;
        i = end;
    }
    out.push_str(&s[copied..]);
    out
}

/// The Windows account name, the one piece of personal data every absolute path
/// carries. Only the name goes: what is left names an install rather than a person,
/// and it is what makes a path in an error worth logging at all.
fn scrub_user(s: &str) -> String {
    // ASCII-only lowering, so every index into it addresses the same byte in `s`.
    let lower = s.to_ascii_lowercase();
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut copied = 0;
    let mut i = 0;
    while let Some(rel) = lower[i..].find("users") {
        let at = i + rel;
        i = at + 5;
        // Anchored on a drive, with either separator on either side, which covers
        // both shapes a Windows error hands over.
        let anchored = at >= 3
            && (bytes[at - 3] as char).is_ascii_alphabetic()
            && bytes[at - 2] == b':'
            && matches!(bytes[at - 1], b'\\' | b'/');
        if !anchored || !matches!(bytes.get(at + 5), Some(b'\\' | b'/')) {
            continue;
        }
        let name = at + 6;
        let mut end = name;
        while end < bytes.len()
            && !matches!(bytes[end], b'\\' | b'/' | b' ' | b'\t' | b'"' | b'\'' | b'<' | b'>' | b'|')
        {
            end += 1;
        }
        if end == name {
            continue;
        }
        out.push_str(&s[copied..name]);
        out.push_str("[user]");
        copied = end;
        i = end;
    }
    out.push_str(&s[copied..]);
    out
}

/// Long base64, base64url and hex runs: armored key bodies, session keys, tokens, and
/// the node uids that name a photo (each half of one is 86 characters, so a whole uid
/// goes). Hex falls inside the same character class and needs no pass of its own.
fn scrub_runs(s: &str) -> String {
    const MIN_RUN: usize = 40;
    fn part(c: u8) -> bool {
        c.is_ascii_alphanumeric() || matches!(c, b'+' | b'/' | b'_' | b'-')
    }
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut copied = 0;
    let mut i = 0;
    while i < bytes.len() {
        if !part(bytes[i]) {
            i += 1;
            continue;
        }
        let start = i;
        while i < bytes.len() && part(bytes[i]) {
            i += 1;
        }
        if i - start < MIN_RUN {
            continue;
        }
        // Base64 padding belongs to the run it closes.
        let mut end = i;
        while end < bytes.len() && bytes[end] == b'=' && end - i < 2 {
            end += 1;
        }
        out.push_str(&s[copied..start]);
        out.push_str("[redacted]");
        copied = end;
        i = end;
    }
    out.push_str(&s[copied..]);
    out
}

/// Dev runs the TypeScript straight from the source tree, so editing the sidecar
/// needs no rebuild. The packaged bundle aliases `openpgp/lightweight` to
/// openpgp's Node build, but tsx resolves the real subpath, which only exports a
/// `browser` condition, hence the extra flag here and not in the shipped app.
fn dev_command() -> Command {
    let mut command = Command::new("cmd");
    command
        .args(["/C", "npx", "tsx", "server.ts"])
        .env("NODE_OPTIONS", "--conditions=browser")
        .current_dir(sidecar_dir());
    command
}

/// A packaged build has no console, so the sidecar's stderr would be discarded.
/// Send it to a file in the app directory instead: without it, a failure on a
/// user's machine leaves nothing to look at.
fn sidecar_log(app: &AppHandle) -> Stdio {
    let Some((live, previous)) = log_paths(app) else {
        return Stdio::null();
    };
    // Rotate before the handle exists. The sidecar then holds it for its whole life,
    // and `note` is the only thing left that can roll the file over under it.
    let _guard = LOG_LOCK.lock();
    rotate_log(&live, &previous);
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&live)
        .map(Stdio::from)
        .unwrap_or_else(|_| Stdio::null())
}

fn spawn_sidecar(app: &AppHandle, generation: u64) -> Result<Sidecar, String> {
    let mut command = if cfg!(debug_assertions) {
        dev_command()
    } else {
        packaged_command(app)?
    };

    let stderr = if cfg!(debug_assertions) {
        Stdio::inherit()
    } else {
        sidecar_log(app)
    };

    // The Node runtime is a console-subsystem executable, so Windows would pop a
    // console window every time it is spawned. Suppress it in the packaged app;
    // dev keeps the console so the sidecar's inherited stderr stays visible.
    #[cfg(windows)]
    if !cfg!(debug_assertions) {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(stderr)
        .spawn()
        .map_err(|e| format!("failed to spawn sidecar: {e}"))?;
    let stdin = child.stdin.take().ok_or("sidecar stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("sidecar stdout unavailable")?;

    // One reader thread per sidecar. It matches each response to its asker by id and
    // hands it over through that asker's own one-slot channel, so several requests can be
    // outstanding at once. A stray non-JSON line (an SDK/openpgp log that reached stdout)
    // and an answer whose asker has gone both fall through and are dropped.
    let router: Router = std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new()));
    let reader_router = std::sync::Arc::clone(&router);
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                // A closed pipe or a read error means the process is gone. Dropping every
                // registered sender wakes each waiting caller with a disconnect at once,
                // rather than leaving them to sit out their whole deadlines.
                Ok(0) | Err(_) => {
                    reader_router.lock().unwrap().clear();
                    return;
                }
                Ok(_) => {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    match serde_json::from_str::<serde_json::Value>(trimmed) {
                        Ok(value) => {
                            if let Some(id) = value.get("id").and_then(serde_json::Value::as_u64) {
                                let waiter = reader_router.lock().unwrap().remove(&id);
                                if let Some(tx) = waiter {
                                    // A one-slot channel the asker still holds; a send only
                                    // fails if it gave up first, which is fine — the answer
                                    // is simply no longer wanted.
                                    let _ = tx.send(value);
                                }
                                // No waiter: the asker timed out or its sidecar was
                                // replaced. Drop the answer.
                            }
                            // An id-less JSON line answers no one; drop it too.
                        }
                        // Not JSON: a stray log line on stdout. Ignore it.
                        Err(_) => {}
                    }
                }
            }
        }
    });

    let mut sc = Sidecar {
        child,
        stdin,
        next_id: 1,
        router,
        generation,
    };

    // Hand over the app directory before anything else, so the sidecar knows where to
    // keep its (vault-encrypted) caches and session. This one round trip is synchronous:
    // it runs before the sidecar is reachable by any other caller.
    let init = secure_store::sidecar_init_params(app)?;
    let rx = send_request(&mut sc, "__init", init)?;
    recv_response(&rx, Instant::now() + deadline_for("__init"), "__init")?;
    Ok(sc)
}

/// How long one call may go unanswered before the sidecar counts as wedged.
///
/// A single flat value cannot serve every method: `hydrateFile` and `getOriginal`
/// legitimately stream a whole file, and the `Enumerate` tier sweeps the entire
/// library on a cold run, while everything else answers in milliseconds. So patience
/// is its own question, separate from `priority_for`'s urgency, and the two are tied
/// together only where they genuinely coincide: the tier that exists BECAUSE it is
/// slow inherits the long deadline, so a method added there can never be handed one
/// it is bound to blow.
///
/// Both values sit far past anything a healthy call could reach, because being wrong
/// costs wildly different amounts in the two directions. Too long only delays
/// recovery from a hang, which without a deadline is permanent. Too short kills a working sidecar
/// mid-transfer and takes the unlocked session down with it, which the user sees as
/// being signed out at random.
fn deadline_for(method: &str) -> Duration {
    // A whole file over a slow link: a 2 GB video at 5 Mbit/s still fits.
    const TRANSFER: Duration = Duration::from_secs(60 * 60);
    // Everything else, where a cold, uncached batch is still a few seconds.
    const REPLY: Duration = Duration::from_secs(5 * 60);
    match method {
        // The calls that move whole files: one photo or video for the mount or the
        // viewer, or the installer for an update.
        "hydrateFile" | "getOriginal" | "getVideo" | "downloadUpdate" => TRANSFER,
        // The whole-library sweeps, named by their priority tier so the two lists
        // cannot drift apart.
        _ if priority_for(method) == Priority::Enumerate => TRANSFER,
        // Walks over the whole timeline, an album or the trash, which grow with the
        // library: on a large one over a slow link they outlast five minutes while
        // making steady progress. Each walk is stopped inside the sidecar as soon as
        // the SDK goes a minute without an answer, so a long ceiling here never lets a
        // stuck one hang; a short one would throw away the signed-in session mid-walk.
        "getTimeline" | "getAlbumPhotoUids" | "getAlbumPhotos" | "listTrashed" => TRANSFER,
        // The people and labels the phone saved to Drive: whole files, read over the network.
        "getDriveCollections" => TRANSFER,
        _ => REPLY,
    }
}

/// Register a waiter under a fresh id, write the request line, and hand back the receiver
/// its response will arrive on. Only the write needs the sidecar — and so the sidecar
/// mutex the caller holds for it — while the receiver is waited on with no lock, so two
/// requests on the two lanes overlap. The waiter is registered BEFORE the write, so the
/// answer can never race in ahead of it.
fn send_request(
    sc: &mut Sidecar,
    method: &str,
    params: serde_json::Value,
) -> Result<Receiver<serde_json::Value>, String> {
    let id = sc.next_id;
    sc.next_id += 1;
    // A one-slot channel: exactly one response ever arrives for an id.
    let (tx, rx) = std::sync::mpsc::sync_channel::<serde_json::Value>(1);
    sc.router.lock().unwrap().insert(id, tx);

    let req = serde_json::json!({ "id": id, "method": method, "params": params });
    let mut line = match serde_json::to_string(&req) {
        Ok(line) => line,
        Err(e) => {
            sc.router.lock().unwrap().remove(&id);
            return Err(e.to_string());
        }
    };
    line.push('\n');
    if let Err(e) = sc.stdin.write_all(line.as_bytes()) {
        // Nothing went out, so nothing will ever answer this id: take the waiter back out
        // rather than leave it to be swept only when the sidecar dies.
        sc.router.lock().unwrap().remove(&id);
        return Err(format!("write to sidecar failed: {e}"));
    }
    if let Err(e) = sc.stdin.flush() {
        sc.router.lock().unwrap().remove(&id);
        return Err(format!("flush to sidecar failed: {e}"));
    }
    Ok(rx)
}

/// Wait for one request's response, up to its deadline. The reader matches on id and drops
/// stray non-JSON stdout, so this is a single receive rather than a skip-until-JSON loop.
///
/// Silence past the deadline. A sidecar that is alive but stuck is indistinguishable from
/// a dead one for everyone queued behind it, so failing here lets the caller drop it
/// exactly as a transport error does, discarding the desynchronised stream rather than
/// resuming a half-read conversation.
fn recv_response(
    rx: &Receiver<serde_json::Value>,
    deadline: Instant,
    method: &str,
) -> Result<serde_json::Value, String> {
    let left = deadline.saturating_duration_since(Instant::now());
    match rx.recv_timeout(left) {
        Ok(value) => Ok(value),
        Err(RecvTimeoutError::Timeout) => Err(format!("sidecar did not answer {method} in time")),
        // The reader dropped the sender: the sidecar's stdout closed, so it is gone.
        Err(RecvTimeoutError::Disconnected) => Err("sidecar closed unexpectedly".to_string()),
    }
}

/// Bridge from a Tauri command or the mount into the gate. Kept as a thin wrapper so
/// both entry points (`rpc` and `sidecar_rpc`) share the one path: priority is derived
/// from the method name inside the gate, so neither caller can get it wrong.
///
/// `call_id` is the frontend's alone. Everything reaching the sidecar from inside the
/// host (the mount's hydration, the viewer's byte protocol) passes `None` and is
/// therefore uncancellable, because nothing over here has anyone to give up on it.
fn rpc_blocking(
    app: &AppHandle,
    shared: &SharedSidecar,
    method: String,
    params: serde_json::Value,
    call_id: Option<CallId>,
) -> Result<serde_json::Value, String> {
    shared.rpc(app, method, params, call_id)
}

/// Call a sidecar method from Rust (e.g. the Cloud Filter mount's hydration and
/// populate paths, and the viewer's byte protocol), unwrapping the
/// `{ok,result,error}` envelope.
pub(crate) fn sidecar_rpc(
    app: &AppHandle,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let shared = app.state::<SharedSidecar>().inner().clone();
    let resp = rpc_blocking(app, &shared, method.to_string(), params, None)?;
    if resp.get("ok").and_then(|v| v.as_bool()) == Some(true) {
        Ok(resp.get("result").cloned().unwrap_or(serde_json::Value::Null))
    } else {
        Err(resp
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("sidecar error")
            .to_string())
    }
}

/// Download + decrypt one file through the sidecar to a temp file on disk, and
/// return its path and byte count. The host streams that file into the Explorer
/// placeholder in small chunks and deletes it, so neither process ever holds the
/// whole file (a large video otherwise needed several times its size resident at
/// once, which stalled the app). The caller owns the temp file and must remove it.
#[cfg(windows)]
pub(crate) fn hydrate_to_temp(app: &AppHandle, uid: &str) -> Result<(std::path::PathBuf, u64), String> {
    let result = sidecar_rpc(app, "hydrateFile", serde_json::json!({ "uid": uid }))?;
    let path = result
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or("hydrateFile returned no path")?;
    let size = result.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
    Ok((std::path::PathBuf::from(path), size))
}

/// The sidecar methods only the host may call. Each one either takes a path or hands out
/// something the host alone should hold: the init keys, a decrypted file on disk, the
/// viewer's in-memory bytes, the drive's staged uploads (which the sidecar deletes when it
/// is done with them). A renderer that has been taken over reaches the sidecar only
/// through `rpc`, so this is the line that keeps it to what the interface itself uses.
fn host_only(method: &str) -> bool {
    method.starts_with("__")
        || matches!(
            method,
            "hydrateFile"
                | "startHydrate"
                | "hydrateProgress"
                | "cancelHydrate"
                | "readOriginalBytes"
                | "listForMount"
                | "listAlbumsForMount"
                | "listExtrasForMount"
                | "startDropUpload"
        )
}

#[tauri::command]
async fn rpc(
    app: AppHandle,
    state: State<'_, SharedSidecar>,
    method: String,
    params: serde_json::Value,
    call_id: Option<CallId>,
) -> Result<serde_json::Value, String> {
    if host_only(&method) {
        return Err(format!("{method} is not available here"));
    }
    if method == "startSaveOriginals" && !save_folder_was_picked(&params) {
        return Err("choose the folder to save to first".into());
    }
    // A lock or a sign-out closes the file-manager drive before the sidecar hears of it,
    // so it answers nothing from a library the user has just locked away.
    #[cfg(not(windows))]
    if matches!(method.as_str(), "lock" | "signOut") {
        files_drive::session_ended();
    }
    let shared = state.inner().clone();
    // Registered here rather than inside the task below, so a cancel arriving while the
    // task is still waiting for a thread from the blocking pool already finds the call
    // to mark. Registering twice is harmless: `track` never clears an existing entry.
    if let Some(id) = call_id {
        shared.track(id);
    }
    let called = method.clone();
    #[cfg(windows)]
    let app_after = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        rpc_blocking(&app, &shared, method, params, call_id)
    })
    .await
    .map_err(|e| format!("sidecar task failed: {e}"))?;
    // The Explorer folder held the account that just signed out: its placeholders go.
    #[cfg(windows)]
    if called == "signOut" && result.is_ok() {
        let app = app_after.clone();
        std::thread::spawn(move || cloud_mount::clear_after_sign_out(&app));
    }
    // A change made in the app shows in the Explorer folder too, quietly and soon.
    #[cfg(windows)]
    if result.as_ref().is_ok_and(|r| r.get("ok").and_then(|v| v.as_bool()) == Some(true))
        && matches!(
            called.as_str(),
            "trashPhotos" | "restorePhotos" | "deletePhotosForever" | "emptyTrash" | "renamePhoto"
                | "createAlbum" | "renameAlbum" | "deleteAlbum" | "addPhotosToAlbum"
                | "removePhotosFromAlbum" | "setFavorite" | "saveCloudEdit"
        )
    {
        crate::explorer_sync::request_refresh(&app_after);
    }
    #[cfg(not(windows))]
    if result.as_ref().is_ok_and(|r| r.get("ok").and_then(|v| v.as_bool()) == Some(true)) {
        match called.as_str() {
            // The timeline loads right after every unlock: the drive can list again.
            "getTimeline" | "startTimeline" => files_drive::session_started(),
            "startUpload" | "confirmImport" => files_drive::upload_started(),
            "trashPhotos" | "restorePhotos" | "deletePhotosForever" | "emptyTrash" | "renamePhoto"
            | "createAlbum" | "renameAlbum" | "deleteAlbum" | "addPhotosToAlbum"
            | "removePhotosFromAlbum" | "saveCloudEdit" => files_drive::library_changed(),
            _ => {}
        }
    }
    result
}

/// The folders the user picked to save originals into, this session.
///
/// A save writes decrypted photos under names their uploader chose, so where it writes
/// has to be the user's choice and nobody else's. The folder is picked here, by the host,
/// and `rpc` refuses a save naming any other: a renderer that has been taken over cannot
/// aim one at a startup folder or anywhere else it would like files to appear.
static SAVE_FOLDERS: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// The folder picker for a save. Async, because the dialog waits on the main thread that
/// a synchronous command would be holding.
#[tauri::command]
async fn pick_save_folder(window: tauri::WebviewWindow) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = tauri::async_runtime::spawn_blocking(move || {
        window.dialog().file().set_parent(&window).blocking_pick_folder()
    })
    .await
    .ok()
    .flatten()?;
    let path = picked.into_path().ok()?.to_string_lossy().into_owned();
    SAVE_FOLDERS.lock().unwrap().push(path.clone());
    Some(path)
}

fn save_folder_was_picked(params: &serde_json::Value) -> bool {
    let dir = params.get("destDir").and_then(|v| v.as_str()).unwrap_or_default();
    !dir.is_empty() && SAVE_FOLDERS.lock().unwrap().iter().any(|p| p == dir)
}

/// Linux, the first time a close leaves the app running: say so once, since nothing on
/// screen shows it any more, and give the background-apps list its line again.
#[cfg(not(windows))]
fn announce_background(app: &AppHandle) {
    static TOLD: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    let first = !TOLD.swap(true, std::sync::atomic::Ordering::SeqCst);
    let app = app.clone();
    std::thread::spawn(move || {
        let (title, body, status) = background_texts(&files_drive::app_language(&app));
        autostart::declare_background(status);
        if first {
            files_drive::send_notification(title, body);
        }
    });
}

/// The notice a first close gives, and the background-apps status line, per language.
#[cfg(not(windows))]
fn background_texts(lang: &str) -> (&'static str, &'static str, &'static str) {
    match lang {
        "hu" => ("A Photos for Proton tovább fut", "A Proton Photos elérhető marad a Fájlokban. Az appot az alkalmazások közül nyithatod meg újra, kilépni a fiókmenüből vagy a Háttéralkalmazások közül tudsz.", "A Proton Photos elérhető a Fájlokban"),
        "de" => ("Photos for Proton läuft weiter", "Proton Photos bleibt in Dateien erreichbar. Über die Anwendungen wieder öffnen; beenden über das Kontomenü oder die Hintergrund-Apps.", "Proton Photos ist in Dateien erreichbar"),
        "es" => ("Photos for Proton sigue ejecutándose", "Proton Photos sigue disponible en Archivos. Vuelve a abrir la app desde tus aplicaciones; sal desde el menú de la cuenta o desde las aplicaciones en segundo plano.", "Proton Photos está disponible en Archivos"),
        "fr" => ("Photos for Proton continue de tourner", "Proton Photos reste accessible dans Fichiers. Rouvrez l'app depuis vos applications ; quittez-la depuis le menu du compte ou les applications en arrière-plan.", "Proton Photos est accessible dans Fichiers"),
        "it" => ("Photos for Proton resta attivo", "Proton Photos resta disponibile in File. Riapri l'app dalle applicazioni; esci dal menu dell'account o dalle app in background.", "Proton Photos è disponibile in File"),
        "nl" => ("Photos for Proton blijft draaien", "Proton Photos blijft beschikbaar in Bestanden. Open de app opnieuw via je apps; afsluiten via het accountmenu of de achtergrondapps.", "Proton Photos is beschikbaar in Bestanden"),
        "pl" => ("Photos for Proton działa dalej", "Proton Photos pozostaje dostępne w Plikach. Otwórz aplikację ponownie z listy aplikacji; zakończ ją z menu konta lub z aplikacji w tle.", "Proton Photos jest dostępne w Plikach"),
        "cs" => ("Photos for Proton běží dál", "Proton Photos zůstává dostupné v Souborech. Aplikaci znovu otevřete ze seznamu aplikací; ukončíte ji v nabídce účtu nebo v aplikacích na pozadí.", "Proton Photos je dostupné v Souborech"),
        "sk" => ("Photos for Proton beží ďalej", "Proton Photos zostáva dostupné v Súboroch. Aplikáciu znova otvoríte zo zoznamu aplikácií; ukončíte ju v ponuke účtu alebo v aplikáciách na pozadí.", "Proton Photos je dostupné v Súboroch"),
        "sl" => ("Photos for Proton deluje naprej", "Proton Photos ostane na voljo v Datotekah. Aplikacijo znova odprete med aplikacijami; zaprete jo v meniju računa ali med aplikacijami v ozadju.", "Proton Photos je na voljo v Datotekah"),
        _ => ("Photos for Proton keeps running", "Proton Photos stays available in Files. Open the app again from your apps; quit from its account menu or from Background Apps.", "Proton Photos is available in Files"),
    }
}

/// Whether the user asked for the app to lock when its window is hidden (to the tray, or
/// on Linux into the background), read from the same sealed settings the page keeps. Off
/// when they cannot be read, as the page itself treats it.
fn lock_on_hide(app: &AppHandle) -> bool {
    page_setting(app, "lockOnHide").and_then(|b| b.as_bool()).unwrap_or(false)
}

/// One of the settings the page keeps sealed, for the host to act on; `None` when they
/// cannot be read.
pub(crate) fn page_setting(app: &AppHandle, key: &str) -> Option<serde_json::Value> {
    secure_store::read_sealed(app, "settings.bin")
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| v.get(key).cloned())
}

/// The Linux file-manager drive's state, for Settings. Windows has its own Explorer
/// commands and never asks.
#[tauri::command]
fn files_drive_status(app: AppHandle) -> serde_json::Value {
    #[cfg(not(windows))]
    return serde_json::to_value(files_drive::status(&app)).unwrap_or_default();
    #[cfg(windows)]
    {
        let _ = app;
        serde_json::json!({ "enabled": false, "address": null })
    }
}

/// Linux: whether closing the window leaves the app running. Windows always keeps
/// running in the tray, so there it is simply true.
#[tauri::command]
fn keep_running() -> bool {
    #[cfg(not(windows))]
    return autostart::keep_running();
    #[cfg(windows)]
    true
}

/// Async: turning it on asks the desktop's portal, which may ask the user.
#[tauri::command]
async fn set_keep_running(enabled: bool) -> Result<(), String> {
    #[cfg(not(windows))]
    return tauri::async_runtime::spawn_blocking(move || autostart::set_keep_running(enabled))
        .await
        .map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        let _ = enabled;
        Ok(())
    }
}

/// Where the drive listens: `localhost` or a 127.x address, and a port, or an empty one
/// for any free port. Async, since moving it restarts the server.
#[tauri::command]
async fn set_files_drive_address(app: AppHandle, host: String, port: String) -> Result<serde_json::Value, String> {
    #[cfg(not(windows))]
    return tauri::async_runtime::spawn_blocking(move || {
        files_drive::set_address(&app, &host, &port).map(|s| serde_json::to_value(s).unwrap_or_default())
    })
    .await
    .map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        let _ = (app, host, port);
        Err("not available".into())
    }
}

/// Whether the drive's `Photos/` is split into year and month folders.
#[tauri::command]
fn set_files_drive_by_date(app: AppHandle, enabled: bool) -> serde_json::Value {
    #[cfg(not(windows))]
    return serde_json::to_value(files_drive::set_by_date(&app, enabled)).unwrap_or_default();
    #[cfg(windows)]
    {
        let _ = (app, enabled);
        serde_json::json!({ "enabled": false, "edits": false, "byDate": false, "address": null })
    }
}

/// Whether deleting and renaming in the file manager reach the library.
#[tauri::command]
fn set_files_drive_edits(app: AppHandle, enabled: bool) -> serde_json::Value {
    #[cfg(not(windows))]
    return serde_json::to_value(files_drive::set_edits(&app, enabled)).unwrap_or_default();
    #[cfg(windows)]
    {
        let _ = (app, enabled);
        serde_json::json!({ "enabled": false, "edits": false, "address": null })
    }
}

/// Turn the drive on or off; it applies at once. Async because turning it on asks the
/// sidecar whether it is unlocked, which must not hold the main thread.
#[tauri::command]
async fn set_files_drive(app: AppHandle, enabled: bool) -> Result<serde_json::Value, String> {
    #[cfg(not(windows))]
    return tauri::async_runtime::spawn_blocking(move || {
        serde_json::to_value(files_drive::set_enabled(&app, enabled)).unwrap_or_default()
    })
    .await
    .map_err(|e| e.to_string());
    #[cfg(windows)]
    {
        let _ = (app, enabled);
        Ok(serde_json::json!({ "enabled": false, "address": null }))
    }
}

/// Let go of a call the frontend no longer wants the answer to.
///
/// Deliberately not a sidecar call and deliberately not behind the gate: it sets one
/// flag, so it answers immediately even while the channel is busy with something long.
/// A call this reaches before it is admitted never touches the sidecar at all; one it
/// misses answers normally and the frontend discards the result, exactly as before.
#[tauri::command]
fn cancel_rpc(state: State<'_, SharedSidecar>, call_id: CallId) {
    state.inner().abandon(call_id);
}

// ---- The viewer's in-memory original ----
//
// The full-resolution photo the viewer is showing reaches the webview through this
// scheme instead of a file. The sidecar holds the decrypted bytes in memory and hands
// them over on the one request naming their token, so the ordinary case now writes no
// decrypted photo to disk at all. Only originals too large for the channel still stage
// a file (see MAX_INMEMORY_ORIGINAL in the sidecar's download module), and those keep
// the asset protocol and its one-folder scope exactly as they were.
//
// Why this is narrower than what it displaces, despite being a second origin on
// `img-src`: it reads no filesystem, it serves exactly one photo — the one the viewer
// is on — and only to a caller that already knows the random token the sidecar minted
// for it. Stepping to the next photo drops the bytes, so a URL kept from earlier
// resolves to nothing. Nothing else in the app is reachable through it.

/// The scheme's URL is `http://pfpview.localhost/<token>` on Windows and
/// `pfpview://localhost/<token>` elsewhere; the frontend builds it with Tauri's own
/// `convertFileSrc`, so it never has to know which.
const VIEW_SCHEME: &str = "pfpview";

/// Fetch and decode the bytes behind one token. `None` covers every miss the same
/// way — an unknown or stale token, a locked account, a sidecar that is not there —
/// because the viewer's answer to all of them is identical: keep the preview.
fn original_bytes(app: &AppHandle, token: &str) -> Option<(Vec<u8>, String)> {
    let result = sidecar_rpc(
        app,
        "readOriginalBytes",
        serde_json::json!({ "token": token }),
    )
    .ok()?;
    let b64 = result.get("base64")?.as_str()?;
    let mime = result
        .get("mime")
        .and_then(|v| v.as_str())
        .unwrap_or("image/jpeg")
        .to_string();
    let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, b64).ok()?;
    Some((bytes, mime))
}

fn serve_original(app: &AppHandle, token: &str) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::{header, HeaderValue, Response, StatusCode};
    let build = |status: StatusCode, mime: &str, body: Vec<u8>| {
        let mut response = Response::new(body);
        *response.status_mut() = status;
        // The media type comes from the sidecar's own allowlist, so this only ever
        // falls back on a value that could not be a header at all.
        let value = HeaderValue::from_str(mime)
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream"));
        response.headers_mut().insert(header::CONTENT_TYPE, value);
        // A photo's bytes are the user's own and live for one view: never let the
        // webview keep a copy past the moment the sidecar drops it.
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        response
    };
    match original_bytes(app, token) {
        Some((bytes, mime)) => build(StatusCode::OK, &mime, bytes),
        None => build(StatusCode::NOT_FOUND, "text/plain", Vec::new()),
    }
}

// ---- Human verification (captcha) ----
//
// Proton's captcha page refuses to be iframed: its `frame-ancestors` names only
// Proton's own web origins. That is why the official Android client hosts it in
// a native WebView. We do the same, but as a child webview placed inside the
// main window, so it is a top-level document and no extra OS window appears.
//
// The page reports its result with `window.parent.postMessage(...)`. In a
// top-level webview that posts to itself, so the bridge below catches the event
// and hands it to Rust via a sentinel navigation we cancel. Tauri's IPC is never
// exposed to the remote page.

const CAPTCHA_LABEL: &str = "captcha";
const CAPTCHA_ORIGIN: &str = "https://drive-api.proton.me";
const CAPTCHA_SENTINEL_HOST: &str = "captcha.result";

const CAPTCHA_BRIDGE: &str = r#"
(function () {
  // Blend the page into our card: our background, centred, no scrollbar.
  function applyStyle() {
    var style = document.createElement('style');
    style.textContent =
      'html,body{background:#0e0e0f !important;margin:0 !important;}' +
      'body{display:grid;place-items:center;min-height:100vh;}' +
      '::-webkit-scrollbar{width:0 !important;height:0 !important;}';
    (document.head || document.documentElement).appendChild(style);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyStyle);
  } else {
    applyStyle();
  }

  window.addEventListener('message', function (event) {
    if (event.origin !== 'https://drive-api.proton.me') return;
    var data = event.data;
    if (!data || (data.type !== 'pm_captcha' && data.type !== 'pm_captcha_expired')) return;
    var url = new URL('https://captcha.result/');
    url.searchParams.set('type', data.type);
    url.searchParams.set('token', data.token || '');
    window.location.href = url.toString();
  });
})();
"#;

/// Must stay `async`. Tauri runs synchronous commands on the main thread, while
/// `add_child` posts webview creation to that same thread and waits for it, so a
/// sync version deadlocks before the webview is ever created.
#[tauri::command]
async fn open_captcha(
    app: AppHandle,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    // Exact-origin check (not just a prefix): a look-alike host such as
    // drive-api.proton.me.evil.test must not pass.
    let parsed = tauri::Url::parse(&url).map_err(|e| e.to_string())?;
    if !url.starts_with(CAPTCHA_ORIGIN)
        || parsed.scheme() != "https"
        || parsed.host_str() != Some("drive-api.proton.me")
    {
        return Err("refusing to open a page outside the Proton captcha origin".into());
    }
    let window = app.get_window(MAIN_WINDOW).ok_or("no main window")?;
    if let Some(existing) = app.get_webview(CAPTCHA_LABEL) {
        let _ = existing.close();
    }
    let handle = app.clone();
    let builder = WebviewBuilder::new(CAPTCHA_LABEL, WebviewUrl::External(parsed))
        .initialization_script(CAPTCHA_BRIDGE)
        // A remote page, so no window of its own: whatever it tries to pop up (a help
        // link, or anything a compromised third-party script would open) goes nowhere.
        // Its navigation is left free: the challenge loads its puzzle from hosts that are
        // Proton's to choose, and a sign-in that cannot complete it is worse than the page.
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .on_navigation(move |target| {
            if target.host_str() != Some(CAPTCHA_SENTINEL_HOST) {
                return true;
            }
            let mut kind = String::new();
            let mut token = String::new();
            for (key, value) in target.query_pairs() {
                match key.as_ref() {
                    "type" => kind = value.into_owned(),
                    "token" => token = value.into_owned(),
                    _ => {}
                }
            }
            let _ = handle.emit("captcha", serde_json::json!({ "type": kind, "token": token }));
            false // the sentinel is a signal, never a real navigation
        });

    window
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(width, height),
        )
        .map_err(|e| {
            eprintln!("[host] captcha webview creation failed: {e}");
            e.to_string()
        })?;
    Ok(())
}

/// Keep the child webview glued to its placeholder as the window resizes or scrolls.
#[tauri::command]
async fn move_captcha(app: AppHandle, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    if let Some(webview) = app.get_webview(CAPTCHA_LABEL) {
        webview
            .set_position(LogicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        webview
            .set_size(LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Async for the same reason as `open_captcha`: closing dispatches to the main thread.
#[tauri::command]
async fn close_captcha(app: AppHandle) -> Result<(), String> {
    if let Some(webview) = app.get_webview(CAPTCHA_LABEL) {
        webview.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Reliable click-outside dismissal for the tray popup.
///
/// Focus-based dismissal is unreliable on Windows: the foreground lock keeps the
/// popup from taking focus on show, so no blur ever fires and the first outside
/// click is ignored. Instead, while the popup is open we install a low-level
/// mouse hook and hide it on the first button-down whose point is outside the
/// popup's rectangle. No focus required.
#[cfg(windows)]
mod tray_dismiss {
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicIsize, Ordering};
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetWindowRect, SetWindowsHookExW, ShowWindow, UnhookWindowsHookEx, HHOOK,
        MSLLHOOKSTRUCT, SW_HIDE, WH_MOUSE_LL, WM_LBUTTONDOWN, WM_MBUTTONDOWN, WM_RBUTTONDOWN,
    };

    static HOOK: AtomicIsize = AtomicIsize::new(0);
    static POPUP: AtomicIsize = AtomicIsize::new(0);

    unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 {
            let msg = wparam.0 as u32;
            if msg == WM_LBUTTONDOWN || msg == WM_RBUTTONDOWN || msg == WM_MBUTTONDOWN {
                let raw = POPUP.load(Ordering::SeqCst);
                if raw != 0 {
                    let hwnd = HWND(raw as *mut c_void);
                    let info = &*(lparam.0 as *const MSLLHOOKSTRUCT);
                    let mut rect = RECT::default();
                    if GetWindowRect(hwnd, &mut rect).is_ok() {
                        let p = info.pt;
                        let inside =
                            p.x >= rect.left && p.x < rect.right && p.y >= rect.top && p.y < rect.bottom;
                        if !inside {
                            let _ = ShowWindow(hwnd, SW_HIDE);
                            uninstall();
                        }
                    }
                }
            }
        }
        CallNextHookEx(None, code, wparam, lparam)
    }

    pub fn install(popup: HWND) {
        POPUP.store(popup.0 as isize, Ordering::SeqCst);
        if HOOK.load(Ordering::SeqCst) != 0 {
            return; // already armed
        }
        unsafe {
            if let Ok(h) = SetWindowsHookExW(WH_MOUSE_LL, Some(hook_proc), None, 0) {
                HOOK.store(h.0 as isize, Ordering::SeqCst);
            }
        }
    }

    pub fn uninstall() {
        let raw = HOOK.swap(0, Ordering::SeqCst);
        if raw != 0 {
            unsafe {
                let _ = UnhookWindowsHookEx(HHOOK(raw as *mut c_void));
            }
        }
    }
}

// ---- Windows ----
//
// Three, and the frontend routes on which one it is running in rather than on any
// state of its own. None is declared in tauri.conf.json: a launch that only has a file
// to show must not pay for the app's window, and a window declared in the config is
// created before a line of this runs.

/// The app itself: the library, the sign-in ladder, Settings.
const MAIN_WINDOW: &str = "main";
/// One file, opened from Explorer. Its own window, so a library being browsed in the
/// main one is not replaced by it.
const VIEWER_WINDOW: &str = "viewer";
/// The tray flyout.
const TRAY_POPUP_WINDOW: &str = "tray_popup";

const APP_TITLE: &str = "Photos for Proton";

/// Show a window the frontend has finished painting, and put it in front.
///
/// Both real windows ship hidden so an empty transparent frame is never seen, and this
/// is what ends that. It is a command rather than `show()` from the renderer for the
/// foreground: Windows refuses `SetForegroundWindow` to a process that is not the
/// active one, which is exactly the case for a double-click in Explorer reaching an
/// app that was already running, and only the host can lift that.
/// True while this launch is one nobody watched happen: started by Windows at login,
/// with the tray as the whole of its presence until the app is actually asked for.
static BACKGROUND_LAUNCH: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

fn background_launch() -> bool {
    BACKGROUND_LAUNCH.load(std::sync::atomic::Ordering::Relaxed)
}

/// Whether the main window's page has done what it does by itself at startup: put the
/// saved session back, or found it needs the user (a sign-in, the lock screen), and when
/// signed in, read the timeline and started the Explorer fill. Until then the page must
/// not be suspended: a suspended page runs nothing, so a start in the tray, or a window
/// closed while it was still restoring, left the session unrestored and the Explorer
/// folder empty until the window was opened again.
static PAGE_SETTLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// A suspend asked for before the page settled, carried out once it has.
static SUSPEND_WAITING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// What a request to suspend the main window's page does.
#[derive(Debug, PartialEq, Eq)]
enum SuspendNow {
    /// On screen: never.
    No,
    /// Hidden and settled.
    Now,
    /// Hidden, still at its startup work: once it settles.
    Later,
}

fn suspend_decision(visible: bool, settled: bool) -> SuspendNow {
    match (visible, settled) {
        (true, _) => SuspendNow::No,
        (false, true) => SuspendNow::Now,
        (false, false) => SuspendNow::Later,
    }
}

/// The session went with a replaced sidecar, and only the page puts it back. A page
/// suspended in the tray would not hear of it, so it is woken, kept off screen, and
/// suspended again once it has settled.
fn wake_to_restore(app: &AppHandle) {
    PAGE_SETTLED.store(false, std::sync::atomic::Ordering::Relaxed);
    #[cfg(windows)]
    if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
        if !w.is_visible().unwrap_or(false) {
            SUSPEND_WAITING.store(true, std::sync::atomic::Ordering::Relaxed);
            webview_power::resume(app);
        }
    }
    #[cfg(not(windows))]
    let _ = app;
}

/// The page has settled (see `PAGE_SETTLED`). A suspend that waited for it runs now.
#[tauri::command]
fn page_settled(app: AppHandle) {
    PAGE_SETTLED.store(true, std::sync::atomic::Ordering::Relaxed);
    #[cfg(windows)]
    if SUSPEND_WAITING.swap(false, std::sync::atomic::Ordering::Relaxed) {
        webview_power::suspend(&app);
    }
    #[cfg(not(windows))]
    let _ = app;
}

/// A line from the page, which until now could not reach the log at all.
///
/// The frontend's only trace was accidental: an RPC that happened to take over a
/// second. So a startup that failed before its first call left the file saying
/// nothing, and an empty window and a healthy one looked identical in it.
///
/// Capped and scrubbed like every other line. This is the one input to the log that
/// comes from the page, and a page can be handed an error of any length.
#[tauri::command]
fn log_note(app: AppHandle, message: String) {
    let short: String = message.chars().take(400).collect();
    note(&app, &format!("[ui] {short}"));
}

/// The current start-with-Windows preference, for the Settings toggle.
#[tauri::command]
fn launch_at_login() -> bool {
    autostart::enabled()
}

/// Set it. The one failure worth reporting is being unable to write the entry, since
/// a switch that flips back on its own is worse than one that says why it did not.
///
/// Async: on Linux the answer comes from the desktop's portal, which may first ask the
/// user, and the window must not freeze while it does.
#[tauri::command]
async fn set_launch_at_login(enabled: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || autostart::set(enabled))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn reveal_window(window: tauri::WebviewWindow) {
    // The app's window builds and paints on a background launch exactly as it always
    // does, and asks to be shown at the end of it. Refusing here rather than skipping
    // the build is what makes opening it from the tray instant: the renderer is warm
    // and the first frame is already drawn, so there is nothing left to wait for.
    if window.label() == MAIN_WINDOW && background_launch() {
        // Painted, and staying off screen. Without this the renderer would hold its
        // couple of hundred megabytes from login until the window was first opened
        // and closed again, which is the opposite of what starting quietly is for.
        // Closing to the tray suspends for the same reason; this is the one way into
        // that state that never passes through a close.
        #[cfg(windows)]
        {
            let app = window.app_handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(2));
                if background_launch() {
                    webview_power::suspend(&app);
                }
            });
        }
        return;
    }
    show_main_or_viewer(&window);
    let _ = window.unminimize();
    force_foreground(&window);
}

/// Put a window on screen, with its renderer awake.
///
/// The two halves belong together. The main window's renderer can be suspended while
/// the window is hidden, and a path that shows the window without resuming it puts a
/// live frame on screen over a renderer that was told it is invisible, which leaves
/// the app as an empty transparent pane. Every show goes through here, so the two
/// cannot come apart. Resuming something that was never suspended is a no-op.
fn show_main_or_viewer(window: &tauri::WebviewWindow) {
    #[cfg(windows)]
    if window.label() == MAIN_WINDOW {
        SUSPEND_WAITING.store(false, std::sync::atomic::Ordering::Relaxed);
        webview_power::resume(window.app_handle());
    }
    let _ = window.show();
}

/// Show `window` if the frontend never got as far as asking.
///
/// A window that stays hidden because its renderer failed is indistinguishable from
/// the app not having started, and for the viewer it is worse: a double-click would
/// produce nothing at all, with no tray icon to explain it.
fn reveal_safety_net(window: tauri::WebviewWindow) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(5));
        // Hidden on purpose is not the failure this catches. Rechecked here rather
        // than skipped at the call, because the app can be asked for during the wait.
        if window.label() == MAIN_WINDOW && background_launch() {
            return;
        }
        if !window.is_visible().unwrap_or(false) {
            show_main_or_viewer(&window);
        }
    });
}

/// The frame of the app's own windows. On Windows they are opaque, and the system rounds
/// their corners and draws their shadow: a transparent window is left see-through for a
/// frame wherever a resize uncovers it, before the page catches up, which is the flicker
/// a drag on its edge showed. The colour fills that strip instead, the dark frame the page
/// paints (the page sets it to its theme's as soon as it runs). Elsewhere the page draws
/// the rounded window itself on a transparent one.
fn framed<'a, R: tauri::Runtime, M: tauri::Manager<R>>(
    builder: tauri::WebviewWindowBuilder<'a, R, M>,
) -> tauri::WebviewWindowBuilder<'a, R, M> {
    #[cfg(windows)]
    {
        builder
            .transparent(false)
            .shadow(true)
            .background_color(tauri::window::Color(25, 25, 27, 255))
    }
    #[cfg(not(windows))]
    {
        builder.transparent(true)
    }
}

/// The app's own window. Built rather than declared so it exists only once the app
/// itself has been asked for.
fn build_main_window(app: &AppHandle) -> tauri::Result<()> {
    let main = framed(
        tauri::WebviewWindowBuilder::new(app, MAIN_WINDOW, tauri::WebviewUrl::default())
            .title(APP_TITLE)
            .inner_size(1100.0, 720.0)
            .min_inner_size(720.0, 500.0)
            .decorations(false)
            .resizable(true)
            .visible(false),
    )
    .build()?;
    window_place::apply(app, &main, (1100.0, 720.0));
    // A stale Windows icon cache could otherwise leave the old taskbar icon.
    if let Some(icon) = app.default_window_icon().cloned() {
        let _ = main.set_icon(icon);
    }
    reveal_safety_net(main);
    Ok(())
}

/// The window one file is shown in, created on the first request for one and reused
/// for every request after it.
///
/// Reused rather than multiplied on purpose. A window here is a WebView2 renderer,
/// which is the same couple of hundred megabytes the app goes out of its way to
/// suspend while it sits in the tray, and a viewer per double-click would hand a user
/// browsing a folder a screen full of them. One window that follows the file being
/// asked for is also what the taskbar reads as "the photo viewer", rather than a
/// growing row of identical entries.
pub(crate) fn show_viewer_window(app: &AppHandle) {
    if let Some(existing) = app.get_webview_window(VIEWER_WINDOW) {
        let _ = existing.show();
        let _ = existing.unminimize();
        force_foreground(&existing);
        return;
    }
    let built = framed(
        tauri::WebviewWindowBuilder::new(app, VIEWER_WINDOW, tauri::WebviewUrl::default())
            .title(APP_TITLE)
            .inner_size(1000.0, 700.0)
            .min_inner_size(480.0, 360.0)
            .decorations(false)
            .resizable(true)
            .visible(false)
            .center(),
    )
    .build();
    match built {
        Ok(viewer) => {
            if let Some(icon) = app.default_window_icon().cloned() {
                let _ = viewer.set_icon(icon);
            }
            reveal_safety_net(viewer);
        }
        // Deliberately no path in the message: the file is the user's business.
        Err(e) => note(app, &format!("[viewer] window creation failed: {e}")),
    }
}

/// Everything the app itself needs and a viewer does not: its window, the tray, and
/// the background services.
///
/// Once, whichever way it is reached. The mount registration and the sync-engine
/// connection are per-process, and a second window under the same label would fail
/// the build.
fn ensure_app_started(app: &AppHandle) {
    static STARTED: std::sync::Once = std::sync::Once::new();
    STARTED.call_once(|| {
        if let Err(e) = build_main_window(app) {
            note(app, &format!("[host] main window creation failed: {e}"));
        }
        // No dependable system tray on the Linux target: GNOME shows no legacy tray icon,
        // so the app runs as a plain window there and its close is a real quit (below),
        // rather than a hide to a tray that would not be there to bring it back.
        #[cfg(windows)]
        {
            if let Err(e) = build_tray(app) {
                note(app, &format!("[host] tray creation failed: {e}"));
            }
            if let Err(e) = build_tray_popup(app) {
                note(app, &format!("[host] tray popup creation failed: {e}"));
            }
        }
        start_background_services(app);
    });
}

/// Suspend / resume the main window's WebView2 so it does not hold its full renderer
/// memory (~200 MB) while the app is only in the tray. Suspending keeps all page
/// state; the view resumes instantly on show. Best-effort: any failure just leaves the
/// memory as-is. Windows-only (WebView2); a no-op elsewhere.
#[cfg(windows)]
mod webview_power {
    use tauri::{AppHandle, Manager};
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2TrySuspendCompletedHandler, ICoreWebView2TrySuspendCompletedHandler_Impl,
        ICoreWebView2_3,
    };
    use windows_core::{implement, Interface, BOOL, HRESULT};

    // TrySuspend requires a completion handler; we do not need its result.
    #[implement(ICoreWebView2TrySuspendCompletedHandler)]
    struct SuspendDone;

    impl ICoreWebView2TrySuspendCompletedHandler_Impl for SuspendDone_Impl {
        fn Invoke(&self, _errorcode: HRESULT, _result: BOOL) -> windows_core::Result<()> {
            Ok(())
        }
    }

    pub fn suspend(app: &AppHandle) {
        let Some(w) = app.get_webview_window(super::MAIN_WINDOW) else {
            return;
        };
        // Never on a window that is on screen. Suspending hides the renderer inside a
        // frame that stays where it is, and this window is frameless and transparent,
        // so the result is not a blank page but an empty sheet of glass with no way
        // back: nothing that shows the window afterwards would resume it.
        //
        // The check lives here rather than at each caller because it has to hold for
        // all of them at once. Both callers decide to suspend on a timer, and the
        // window can be asked for in the moment between that decision and this call.
        let settled = super::PAGE_SETTLED.load(std::sync::atomic::Ordering::Relaxed);
        match super::suspend_decision(w.is_visible().unwrap_or(false), settled) {
            super::SuspendNow::No => return,
            super::SuspendNow::Later => {
                super::SUSPEND_WAITING.store(true, std::sync::atomic::Ordering::Relaxed);
                super::note(app, "[host] page suspend held until it settles");
                return;
            }
            super::SuspendNow::Now => super::note(app, "[host] page suspended in the tray"),
        }
        let _ = w.with_webview(|webview| unsafe {
            let controller = webview.controller();
            let _ = controller.SetIsVisible(false); // required before a suspend
            if let Ok(core) = controller.CoreWebView2() {
                if let Ok(core3) = core.cast::<ICoreWebView2_3>() {
                    let handler: ICoreWebView2TrySuspendCompletedHandler = SuspendDone.into();
                    let _ = core3.TrySuspend(&handler);
                }
            }
        });
    }

    pub fn resume(app: &AppHandle) {
        let Some(w) = app.get_webview_window(super::MAIN_WINDOW) else {
            return;
        };
        let _ = w.with_webview(|webview| unsafe {
            let controller = webview.controller();
            if let Ok(core) = controller.CoreWebView2() {
                if let Ok(core3) = core.cast::<ICoreWebView2_3>() {
                    let _ = core3.Resume();
                }
            }
            let _ = controller.SetIsVisible(true);
        });
    }
}

/// The app itself has been asked for: from the tray, from a second launch that named
/// no file, or from the viewer's offer to sign in.
///
/// One path for all three, because all three mean the same thing. A launch that only
/// had a file to show skipped the app's window, its tray and its services, so the
/// first of these has to build them before there is anything to bring back; the rest
/// find them already there and only raise the window.
fn show_main_window(app: &AppHandle) {
    local_file::app_taken_over(app);
    // The app has now been asked for, so a launch that began in the tray stops being
    // one. Cleared before anything else here: what follows may build the window, and
    // that window asks to be shown the moment it has painted.
    BACKGROUND_LAUNCH.store(false, std::sync::atomic::Ordering::Relaxed);
    // Read before, not after: whether the window was already there is what decides who
    // shows it, and `ensure_app_started` is what makes the answer stop being no.
    let existing = app.get_webview_window(MAIN_WINDOW);
    ensure_app_started(app);
    // One that had to be built reveals itself once its first frame is painted, exactly
    // as it does on an ordinary launch. Showing it from here would put the empty
    // transparent frame on screen that shipping it hidden exists to avoid.
    let Some(w) = existing else {
        return;
    };
    show_main_or_viewer(&w);
    let _ = w.unminimize();
    force_foreground(&w);
}

/// System-tray icon so the app keeps running in the background once its window
/// is closed. Either mouse button shows our own rounded popup (a real frameless
/// window, not the OS menu) near the cursor — with the account, live sync status,
/// a "Sync now" action, and Open / Sign out / Quit.
fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let Some(icon) = app.default_window_icon().cloned() else {
        return Ok(());
    };

    TrayIconBuilder::with_id("main")
        .icon(icon)
        .tooltip("Photos for Proton")
        .on_tray_icon_event(|tray, event| {
            let app = tray.app_handle();
            match event {
                // Both buttons open our own rounded popup (account, sync status, and
                // Open / Sign out / Quit). "Open" in the popup brings the window back.
                TrayIconEvent::Click {
                    button: MouseButton::Left | MouseButton::Right,
                    button_state: MouseButtonState::Up,
                    ..
                } => show_tray_popup(app),
                _ => {}
            }
        })
        .build(app)?;
    Ok(())
}

/// A frameless, transparent popup styled like the app (rounded corners). It
/// loads the frontend, which renders the tray menu when it sees this window's
/// label. Created hidden alongside the app's own window; shown on a tray click.
fn build_tray_popup(app: &AppHandle) -> tauri::Result<()> {
    let popup =
        tauri::WebviewWindowBuilder::new(app, TRAY_POPUP_WINDOW, tauri::WebviewUrl::default())
            .title("")
            .inner_size(320.0, 436.0)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .visible(false)
            .build()?;

    // Dismiss on click-outside.
    let handle = app.clone();
    popup.on_window_event(move |event| {
        if let tauri::WindowEvent::Focused(false) = event {
            if let Some(w) = handle.get_webview_window(TRAY_POPUP_WINDOW) {
                let _ = w.hide();
            }
        }
    });
    Ok(())
}

/// Force a window to the foreground. Windows blocks `SetForegroundWindow` when the
/// calling app is not the active one, so `set_focus` alone leaves a window shown but
/// behind whatever the user was in: the tray popup would not dismiss on the first
/// click outside, and a viewer opened from Explorer would come up behind Explorer.
/// Briefly attaching this app's input thread to the current foreground thread lifts
/// that restriction, and the focus can then be taken.
#[cfg(windows)]
fn force_foreground(window: &tauri::WebviewWindow) {
    use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows::Win32::UI::Input::KeyboardAndMouse::SetFocus;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowThreadProcessId, SetForegroundWindow,
    };
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    unsafe {
        let fg_thread = GetWindowThreadProcessId(GetForegroundWindow(), None);
        let our_thread = GetCurrentThreadId();
        let attached = fg_thread != 0 && fg_thread != our_thread;
        if attached {
            let _ = AttachThreadInput(our_thread, fg_thread, true);
        }
        let _ = SetForegroundWindow(hwnd);
        let _ = SetFocus(Some(hwnd));
        if attached {
            let _ = AttachThreadInput(our_thread, fg_thread, false);
        }
    }
}

#[cfg(not(windows))]
fn force_foreground(window: &tauri::WebviewWindow) {
    let _ = window.set_focus();
}

/// Natively show the window. The dismiss hook hides it with `ShowWindow(SW_HIDE)`,
/// which bypasses Tauri, so Tauri still believes the window is visible and its own
/// `show()` becomes a no-op on the next open. A native `SW_SHOW` re-shows it
/// regardless of that stale state.
#[cfg(windows)]
fn native_show(window: &tauri::WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_SHOW};
    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            let _ = ShowWindow(hwnd, SW_SHOW);
        }
    }
}

#[cfg(not(windows))]
fn native_show(_window: &tauri::WebviewWindow) {}

/// Anchor the popup bottom-right, above the taskbar, like a standard tray flyout,
/// then tell it to refresh its account data (it was created before sign-in).
fn show_tray_popup(app: &AppHandle) {
    let Some(w) = app.get_webview_window(TRAY_POPUP_WINDOW) else {
        return;
    };
    let size = w.outer_size().unwrap_or(tauri::PhysicalSize::new(320, 436));
    if let Ok(Some(monitor)) = w.primary_monitor() {
        let ms = monitor.size();
        let taskbar = (48.0 * monitor.scale_factor()) as i32;
        let margin = (10.0 * monitor.scale_factor()) as i32;
        let x = (ms.width as i32 - size.width as i32 - margin).max(margin);
        let y = (ms.height as i32 - size.height as i32 - taskbar - margin).max(margin);
        let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
    }
    let _ = w.show();
    native_show(&w);
    force_foreground(&w);
    #[cfg(windows)]
    if let Ok(hwnd) = w.hwnd() {
        tray_dismiss::install(hwnd);
    }
    let _ = w.emit("tray-shown", ());
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Relaunch the app (used to apply the "show in File Explorer" toggle, which mounts
/// or unmounts the sync root at startup).
#[tauri::command]
fn restart_app(app: AppHandle) {
    app.restart();
}

/// The Explorer "Proton Photos" mount: the nav-pane entry, and the cloud placeholders
/// that hydrate on open. Opt-in through the installer checkbox and the Settings toggle,
/// default on. Best-effort and non-blocking; any failure leaves an ordinary folder.
///
/// Reached only through `ensure_app_started`, which is what guarantees the once: the
/// registration and the sync engine connection are per-process, and connecting a second
/// time would leave two.
fn start_background_services(app: &AppHandle) {
    // Linux: the file-manager drive, on the same terms (see files_drive.rs).
    #[cfg(not(windows))]
    files_drive::start(app);
    // Linux: tell the desktop from the start, not only at the first close, that the app
    // runs in the background, so it is listed among the background apps as soon as its
    // window goes, and with a line saying why.
    #[cfg(not(windows))]
    if autostart::keep_running() {
        let app = app.clone();
        std::thread::spawn(move || {
            let (_, _, status) = background_texts(&files_drive::app_language(&app));
            autostart::declare_background(status);
        });
    }
    if cloud_mount::show_in_explorer_enabled() {
        cloud_mount::ensure_folder();
        cloud_mount::mount(app.clone());
    } else {
        // Opted out: remove the registration so the nav-pane entry is gone.
        cloud_mount::unmount(app.clone());
    }
}

/// The app itself has been asked for from the viewer, which is where signing in to
/// upload the open file leads. Everything a viewer launch deliberately skipped happens
/// here, so that one path reaches a working app rather than a half-started one.
///
/// The viewer window is left alone. It is its own window now, the file in it is what
/// the sign-in was for, and closing it would take away the thing the user is signing in
/// about.
#[tauri::command]
fn enter_app(app: AppHandle) {
    show_main_window(&app);
}

/// Launch the freshly downloaded installer in update mode (it replaces this install
/// in place and relaunches the app), then quit so the running files unlock. The
/// installer runs from TEMP and breaks away from any job so it survives our exit.
#[tauri::command]
fn run_updater(app: AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        // The one path the sidecar writes a hash-verified installer to, computed
        // here rather than taken as an argument: executing a path the renderer
        // chose would hand any injected script arbitrary code execution, and the
        // CSP that otherwise contains the renderer cannot reach this far.
        let path = std::env::temp_dir().join("pfp-update.exe");
        if !path.is_file() {
            note(&app, "[update] no verified installer staged, not launching");
            return Err("no installer staged".into());
        }
        // Checked here, by the process that runs it, right before it runs: signed with
        // the update key and newer than this app, or it is deleted and not run.
        let signature = std::env::temp_dir().join("pfp-update.exe.minisig");
        if let Err(e) = update_sig::verify_installer(&path, &signature, &app.package_info().version) {
            note(&app, &format!("[update] installer refused: {e}"));
            let _ = std::fs::remove_file(&path);
            let _ = std::fs::remove_file(&signature);
            return Err(e);
        }
        let spawn = |flags: u32| {
            std::process::Command::new(&path)
                .arg("--update")
                .current_dir(std::env::temp_dir())
                .creation_flags(flags)
                .spawn()
        };
        if spawn(DETACHED_PROCESS | CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB)
            .or_else(|_| spawn(DETACHED_PROCESS | CREATE_NO_WINDOW))
            .is_err()
        {
            note(&app, "[update] could not launch the installer");
            return Err("could not launch the installer".into());
        }
    }
    app.exit(0);
    Ok(())
}

#[tauri::command]
fn hide_tray_popup(app: AppHandle) {
    #[cfg(windows)]
    tray_dismiss::uninstall();
    if let Some(w) = app.get_webview_window(TRAY_POPUP_WINDOW) {
        let _ = w.hide();
    }
}

#[tauri::command]
fn open_main_from_tray(app: AppHandle) {
    #[cfg(windows)]
    tray_dismiss::uninstall();
    if let Some(w) = app.get_webview_window(TRAY_POPUP_WINDOW) {
        let _ = w.hide();
    }
    show_main_window(&app);
}

/// True when Explorer offers this app for EVERY photo and video type it claims, false
/// otherwise, read out of the registry rather than remembered.
///
/// The one boolean stands for the whole registration, and it means all of it, not part
/// of it: a registration that lost some of its types reads false, which is the reading
/// the user can act on, since switching on rewrites the lot. The reasoning is in
/// `file_assoc::registration_is_complete`, and it is worth reading before this is
/// loosened, because false over a partial registration is a deliberate choice and not
/// an oversight.
#[tauri::command]
fn file_association_enabled() -> bool {
    file_assoc::is_registered()
}

/// Turn the "Open with" offer on or off.
///
/// Safe to call again in either direction, and switching on is a full repair rather
/// than a top-up: it writes every key and value the current list names whatever was
/// already there, so a registration left uneven by a failed write, by a hand-edited
/// registry, or by an older build that claimed fewer types comes out whole. Switching
/// off twice finds nothing left the second time. Explorer is told either way, so the
/// change reaches the context menu without a sign-out.
#[tauri::command]
fn set_file_association(enabled: bool) -> Result<(), String> {
    if enabled {
        // The app registers ITSELF. Reading an install location back out of the
        // registry would be a guess, and a wrong one for a copy that has been moved.
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        file_assoc::register(&exe)?;
    } else {
        file_assoc::unregister();
    }
    // The switch reports the registry, so the command owes the caller a registry that
    // agrees before it returns. Removal is best-effort key by key on purpose, since one
    // locked key belonging to another app must not abort the rest, which leaves this as
    // the only place a switch-off that did not take can be caught.
    if file_assoc::is_registered() != enabled {
        return Err("the file association did not change".into());
    }
    Ok(())
}

/// The Windows Settings page where a default handler is chosen, documented by Microsoft
/// as part of the `ms-settings:` URI scheme.
///
/// Windows 11 also accepts a `?registeredAppUser=` parameter that opens one app's own
/// page, which would be the better destination. It is deliberately not sent: the name
/// it resolves is a value under `HKCU\Software\RegisteredApplications`, a Default
/// Programs registration neither this app nor its installer writes. Windows answers a
/// name it cannot resolve with this same page, so the parameter would buy nothing while
/// claiming a registration that is not there.
#[cfg(windows)]
const DEFAULT_APPS_PAGE: &str = "ms-settings:defaultapps";

/// A NUL-terminated UTF-16 buffer for a Win32 string pointer. The terminator is the
/// point of it: the call receives a bare pointer and has nothing else to tell it where
/// the string ends.
#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

/// Hand a URI to the shell, the way a double-click would. `ShellExecuteW` reports
/// success as an `HINSTANCE` above 32, which is the whole of what it says.
#[cfg(windows)]
fn shell_open(target: &str) -> bool {
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let target = wide(target);
    // A null verb is the default one, which for a URI scheme is what opens it.
    let result = unsafe {
        ShellExecuteW(
            None,
            PCWSTR::null(),
            PCWSTR(target.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    result.0 as isize > 32
}

/// Take the user to where a default handler is chosen.
///
/// Being OFFERED for a type and being the one that OPENS it are different things, and
/// only the first is this app's to set. Windows seals the default behind a hash it
/// verifies and blocks a program from writing its own, by design and against malware,
/// so pointing the user at the surface where the choice is theirs is the whole of the
/// honest help available here.
#[tauri::command]
fn open_default_apps() -> Result<(), String> {
    #[cfg(windows)]
    {
        if shell_open(DEFAULT_APPS_PAGE) {
            return Ok(());
        }
        // Reached only where the `ms-settings:` scheme has no handler at all, which is
        // to say a Windows without the Settings app. The Control Panel page is the
        // older surface for the same choice and is what such a machine still has.
        if std::process::Command::new("control.exe")
            .args(["/name", "Microsoft.DefaultPrograms"])
            .spawn()
            .is_ok()
        {
            return Ok(());
        }
        Err("could not open the Windows default apps settings".into())
    }
    #[cfg(not(windows))]
    Err("choosing a default app is a Windows setting".into())
}

/// The start of every link a browser sign-in opens: Proton's own sign-in page.
const SIGN_IN_PREFIX: &str = "https://account.proton.me/desktop/login?app=drive&pv=3#payload=";

/// Whether `url` is a browser sign-in link and nothing else: Proton's page, with a
/// payload of the characters URL encoding leaves, so the shell is handed no other
/// address, scheme or argument whatever the renderer asks for.
fn is_sign_in_url(url: &str) -> bool {
    let Some(payload) = url.strip_prefix(SIGN_IN_PREFIX) else {
        return false;
    };
    !payload.is_empty()
        && payload.len() <= 512
        && payload.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'%' | b'-' | b'_' | b'.'))
}

/// Opens Proton's sign-in page in the default browser, for a sign-in through it.
#[tauri::command]
fn open_sign_in_page(url: String) -> Result<(), String> {
    if !is_sign_in_url(&url) {
        return Err("not a Proton sign-in link".into());
    }
    #[cfg(windows)]
    {
        if shell_open(&url) {
            return Ok(());
        }
        Err("could not open the browser".into())
    }
    // xdg-open, which inside the Flatpak sandbox is the desktop's open-URI portal.
    #[cfg(not(windows))]
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|_| "could not open the browser".into())
}

#[cfg(test)]
mod sign_in_url_tests {
    use super::is_sign_in_url;

    #[test]
    fn a_sign_in_link_is_accepted() {
        assert!(is_sign_in_url(
            "https://account.proton.me/desktop/login?app=drive&pv=3#payload=0%3AABCD1234%3Aa2V5%2Bx%2Fy%3D%3D%3Aexternal-drive"
        ));
    }

    #[test]
    fn anything_else_is_refused() {
        for url in [
            "https://account.proton.me/desktop/login?app=drive&pv=3#payload=",
            "https://evil.example/desktop/login?app=drive&pv=3#payload=0%3AA",
            "https://account.proton.me.evil.example/desktop/login?app=drive&pv=3#payload=0",
            "http://account.proton.me/desktop/login?app=drive&pv=3#payload=0",
            "file:///C:/Windows/System32/calc.exe",
            "https://account.proton.me/desktop/login?app=drive&pv=3#payload=0 /c calc",
            "https://account.proton.me/desktop/login?app=drive&pv=3#payload=0\"&calc",
        ] {
            assert!(!is_sign_in_url(url), "{url}");
        }
    }
}

#[cfg(all(test, windows))]
mod default_apps_tests {
    use super::*;

    /// The buffer reaches Win32 as a bare pointer, so the terminator is the only thing
    /// that says where the string stops. Without it the call reads past the end.
    #[test]
    fn wide_strings_are_nul_terminated() {
        let encoded = wide(DEFAULT_APPS_PAGE);
        assert_eq!(encoded.last(), Some(&0), "no terminator");
        assert_eq!(
            String::from_utf16_lossy(&encoded[..encoded.len() - 1]),
            DEFAULT_APPS_PAGE
        );
        assert_eq!(encoded.iter().filter(|c| **c == 0).count(), 1, "terminated twice");
        // An empty string is still a string, and still has to stop somewhere.
        assert_eq!(wide(""), vec![0]);
    }

    /// The per-app deep link resolves a name under `RegisteredApplications`, and nothing
    /// here writes one. Carrying the parameter would name a registration that does not
    /// exist, and Windows would fall back to this same page anyway.
    #[test]
    fn the_settings_page_claims_no_app_registration() {
        assert!(DEFAULT_APPS_PAGE.starts_with("ms-settings:"), "{DEFAULT_APPS_PAGE}");
        assert!(!DEFAULT_APPS_PAGE.contains("registeredApp"), "{DEFAULT_APPS_PAGE}");
        assert!(!DEFAULT_APPS_PAGE.contains('?'), "{DEFAULT_APPS_PAGE}");
    }
}

#[cfg(test)]
mod capability_tests {
    use super::*;

    /// The capability file, read at compile time so it cannot go stale against the
    /// binary that carries it.
    const CAPABILITY: &str = include_str!("../capabilities/default.json");

    fn capability() -> serde_json::Value {
        serde_json::from_str(CAPABILITY).expect("the capability file is not valid JSON")
    }

    /// A window whose label the capability does not list gets no IPC at all, and the
    /// failure is silent: every call from it is refused, so it comes up as a frame with
    /// a dead page in it rather than as an error anyone sees. Nothing else in the build
    /// ties the two together, so this is what does.
    #[test]
    fn every_window_the_host_builds_is_covered_by_the_capability() {
        let cap = capability();
        let listed: Vec<&str> = cap["windows"]
            .as_array()
            .expect("no windows array")
            .iter()
            .map(|w| w.as_str().expect("a window label is not a string"))
            .collect();
        for label in [MAIN_WINDOW, VIEWER_WINDOW, TRAY_POPUP_WINDOW] {
            assert!(listed.contains(&label), "{label} is not in the capability: {listed:?}");
        }
    }

    /// The renderer drives its own window through these, and `core:window:default`
    /// carries none of them: it is read-only, so each one has to be granted by name.
    /// Dropping any leaves a window that cannot be moved, closed, or named after the
    /// file in it.
    #[test]
    fn the_window_controls_the_renderer_uses_are_granted() {
        let cap = capability();
        let granted: Vec<&str> = cap["permissions"]
            .as_array()
            .expect("no permissions array")
            .iter()
            .filter_map(|p| p.as_str())
            .collect();
        for permission in [
            "core:window:allow-close",
            "core:window:allow-minimize",
            "core:window:allow-toggle-maximize",
            "core:window:allow-start-dragging",
            "core:window:allow-set-title",
        ] {
            assert!(granted.contains(&permission), "{permission} is not granted");
        }
    }

    /// The renderer opens four fixed pages in the browser and nothing else, so that is
    /// all it may open: `opener:default` would let a renderer that has been taken over
    /// open any web address, or reveal any path, on the user's desktop.
    #[test]
    fn the_browser_can_be_sent_only_to_the_apps_own_pages() {
        let cap = capability();
        let permissions = cap["permissions"].as_array().expect("no permissions array");
        assert!(
            !permissions.iter().any(|p| p.as_str().is_some_and(|s| s.starts_with("opener:"))),
            "an unscoped opener permission is granted"
        );
        let scoped = permissions
            .iter()
            .find(|p| p["identifier"] == "opener:allow-open-url")
            .expect("the scoped opener permission is missing");
        for entry in scoped["allow"].as_array().expect("no allow list") {
            let url = entry["url"].as_str().expect("an entry without a url");
            assert!(url.starts_with("https://") && !url.contains('*'), "{url} is not one fixed page");
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Keep the WebView2 profile inside the app's own data folder so, on an
    // installed build, everything (session, caches, WebView data) lives under the
    // single install folder and the uninstaller wipes it all together.
    #[cfg(windows)]
    if let Some(data) = secure_store::install_data_dir() {
        let webview = data.join("EBWebView");
        let _ = std::fs::create_dir_all(&webview);
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &webview);
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // A second launch is one of two things, and they are not the same request.
            // A file goes to the viewer and leaves the app's window exactly as it was,
            // library and all; anything else is the app itself being started again, so
            // that is what comes forward.
            if !local_file::deliver_warm(app, &argv) {
                show_main_window(app);
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage::<SharedSidecar>(Arc::new(SidecarGate::new()))
        .manage(local_file::PendingOpen::default())
        .manage(local_file::ViewerOnlyLaunch::default())
        .manage(local_file::StagedPreview::default())
        .manage(local_folder::FolderListing::default())
        // Asynchronous, so the fetch runs on a blocking thread: the handler goes
        // through the sidecar gate, and doing that on the webview's own thread would
        // freeze the window for the length of the transfer.
        .register_asynchronous_uri_scheme_protocol(VIEW_SCHEME, |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            // The whole path is the token. Anything else it might carry is ignored:
            // there is nothing to address here but the one original.
            let token = request
                .uri()
                .path()
                .trim_start_matches('/')
                .split('/')
                .next()
                .unwrap_or("")
                .to_string();
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(serve_original(&app, &token));
            });
        })
        .invoke_handler(tauri::generate_handler![
            rpc,
            cancel_rpc,
            open_captcha,
            move_captcha,
            close_captcha,
            quit_app,
            run_updater,
            restart_app,
            enter_app,
            reveal_window,
            page_settled,
            log_note,
            launch_at_login,
            set_launch_at_login,
            hide_tray_popup,
            open_main_from_tray,
            secure_store::store_set,
            secure_store::store_get,
            secure_store::store_del,
            cloud_mount::populate_mount,
            cloud_mount::sync_now,
            cloud_mount::pin_selected,
            cloud_mount::free_up_selected,
            cloud_mount::free_up_all,
            cloud_mount::hydrated_uids,
            cloud_mount::reveal_photo,
            cloud_mount::local_usage,
            cloud_mount::show_in_explorer,
            cloud_mount::set_show_in_explorer,
            cloud_mount::auto_download,
            cloud_mount::set_auto_download,
            cloud_mount::explorer_edits,
            cloud_mount::set_explorer_edits,
            cloud_mount::synced_albums,
            cloud_mount::set_album_synced,
            cloud_mount::album_local_count,
            cloud_mount::free_up_album,
            cloud_mount::sync_busy,
            cloud_mount::mount_activity,
            file_association_enabled,
            set_file_association,
            open_default_apps,
            open_sign_in_page,
            local_file::take_pending_open,
            local_file::local_file_info,
            local_file::local_file_url,
            local_file::decode_preview,
            local_file::rename_local_file,
            local_file::delete_local_file,
            photo_edit::local_editor_source,
            photo_edit::save_local_edit,
            local_folder::list_media_folder,
            local_folder::local_thumbnails,
            upload_frame::upload_frames,
            files_drive_status,
            set_files_drive,
            set_files_drive_edits,
            set_files_drive_by_date,
            set_files_drive_address,
            keep_running,
            set_keep_running,
            pick_save_folder
        ])
        .setup(|app| {
            // The file a cold launch was asked to open. The single-instance callback
            // above never runs for the first process, and this never runs for a second
            // one, so both are needed and neither is a duplicate of the other. This one
            // opens the viewer window itself, since no webview exists yet to hear an event.
            let argv: Vec<String> = std::env::args().collect();
            // Read before the window is built, since that is what consults it. A
            // launch carrying a file to show is a launch someone is watching, so the
            // flag never applies to one: the two cannot both be true.
            let opened_a_file = local_file::deliver_cold(app.handle(), &argv);
            if !opened_a_file && argv.iter().any(|a| a == autostart::BACKGROUND_FLAG) {
                BACKGROUND_LAUNCH.store(true, std::sync::atomic::Ordering::Relaxed);
            }
            // An install that moved keeps starting with Windows; one that never asked
            // to start is left alone.
            #[cfg(windows)]
            autostart::refresh();

            // Our own temp leftovers, swept unconditionally: orphaned plaintext
            // hydration files must not linger, and tied to the mount they would never
            // be cleaned for anyone who opts out of Explorer. A viewer
            // launch sweeps too, because the folder emptied here is the one its own
            // decoded previews are staged in.
            cloud_mount::reap_temp_leftovers();
            #[cfg(not(windows))]
            files_drive::reap(app.handle());
            // A launch that exists only to show a file stops here, with one window on
            // screen and nothing else built. What `ensure_app_started` holds is the app
            // starting up, and none of it is on the path from a double-click to a
            // picture; it runs if and when the app itself is asked for.
            if !opened_a_file {
                ensure_app_started(app.handle());
            }

            // Tauri touches the OS app-data dir on init even though, on an
            // installed build, we keep everything in the install folder. A moment
            // after startup, drop that stray dir if it is empty, so nothing is
            // scattered outside the one install folder.
            #[cfg(windows)]
            if secure_store::install_data_dir().is_some() {
                if let Ok(d) = app.path().app_local_data_dir() {
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_secs(6));
                        let empty = std::fs::read_dir(&d)
                            .map(|mut r| r.next().is_none())
                            .unwrap_or(false);
                        if empty {
                            let _ = std::fs::remove_dir(&d);
                        }
                    });
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            let tauri::WindowEvent::CloseRequested { api, .. } = event else {
                return;
            };
            let app = window.app_handle();
            match window.label() {
                // The viewer closes for real: it holds one file, and the user is done
                // with it. If that file is the whole of what this process was ever
                // started for there is nothing behind the window to keep running, and
                // a process left in the tray with nothing on screen is
                // indistinguishable from the app having died.
                VIEWER_WINDOW => {
                    local_file::forget_pending_open(app);
                    if local_file::viewer_only_launch(app) {
                        app.exit(0);
                    }
                }
                // Close to tray: the app keeps running in the background, and quitting
                // for real is the tray's own Quit. Suspending the now-hidden WebView2
                // stops it holding its renderer memory while nothing is on screen.
                MAIN_WINDOW => {
                    // Windows closes to the tray and keeps running; the Linux build has no
                    // tray, so closing the main window quits rather than leaving the app
                    // running invisibly with no icon to reopen it.
                    #[cfg(windows)]
                    {
                        let _ = window.hide();
                        api.prevent_close();
                        // Locked from here rather than left to the page: the page is
                        // suspended a moment later and would not act on the event until
                        // it is woken, which left the session open behind the tray.
                        if lock_on_hide(app) {
                            let locking = app.clone();
                            std::thread::spawn(move || {
                                let _ = sidecar_rpc(&locking, "lock", serde_json::json!({}));
                            });
                        }
                        let _ = app.emit("window-hidden", ());
                        webview_power::suspend(app);
                    }
                    // Linux, when asked to keep running (the default): the window only
                    // hides, and the app goes on serving the file-manager drive. It
                    // comes back when the app is started again, and quits from its
                    // account menu or the desktop's list of background apps.
                    #[cfg(not(windows))]
                    {
                        if autostart::keep_running() {
                            let _ = window.hide();
                            api.prevent_close();
                            if lock_on_hide(app) {
                                files_drive::session_ended();
                                let locking = app.clone();
                                std::thread::spawn(move || {
                                    let _ = sidecar_rpc(&locking, "lock", serde_json::json!({}));
                                });
                            }
                            announce_background(app);
                            let _ = app.emit("window-hidden", ());
                        } else {
                            let _ = (window, api);
                            app.exit(0);
                        }
                    }
                }
                // The popup dismisses itself on click-outside and is shown again from
                // the tray, so it is hidden rather than destroyed: there would be
                // nothing left to show next time.
                _ => {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod gate_tests {
    // The gate is tested in isolation: `Gate` carries no `Sidecar`, so these exercise
    // the queueing and mutual-exclusion logic without spawning the Node process.
    use super::{Gate, Priority};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::{Duration, Instant};

    /// Run `body` under a watchdog that aborts the whole test binary if it has not
    /// finished within `secs`. Belt-and-braces proof of termination: a deadlocked gate
    /// would hang here, and the abort turns that hang into a loud failure instead of a
    /// silently stuck test run.
    fn with_watchdog<F: FnOnce()>(secs: u64, body: F) {
        let done = Arc::new(AtomicUsize::new(0));
        let watch = Arc::clone(&done);
        let handle = thread::spawn(move || {
            let start = Instant::now();
            while watch.load(Ordering::SeqCst) == 0 {
                if start.elapsed() > Duration::from_secs(secs) {
                    eprintln!("watchdog: gate test exceeded {secs}s, treating as a deadlock");
                    std::process::abort();
                }
                thread::sleep(Duration::from_millis(20));
            }
        });
        body();
        done.store(1, Ordering::SeqCst);
        let _ = handle.join();
    }

    /// Spin until the gate has exactly `n` waiters queued, so callers can be lined up
    /// in a known order before the holder releases. Bounded by the caller's watchdog.
    fn wait_until_queued(gate: &Gate, n: usize) {
        while gate.queued() != n {
            thread::yield_now();
        }
    }

    // (a) Highest priority first, and FIFO within one priority — shown on the foreground
    // lane. The background lane runs the identical code, and (b) proves the two are
    // independent, so one lane's ordering stands for both.
    #[test]
    fn a_hidden_page_is_suspended_only_once_it_has_settled() {
        use crate::{suspend_decision, SuspendNow};
        assert_eq!(suspend_decision(true, true), SuspendNow::No);
        assert_eq!(suspend_decision(true, false), SuspendNow::No);
        assert_eq!(suspend_decision(false, true), SuspendNow::Now);
        assert_eq!(suspend_decision(false, false), SuspendNow::Later);
    }

    #[test]
    fn admits_by_priority_then_fifo() {
        with_watchdog(10, || {
            let gate = Arc::new(Gate::new());
            // Hold the FOREGROUND lane so every foreground waiter below must queue.
            let holder = gate.acquire(Priority::UserAction);

            let order = Arc::new(Mutex::new(Vec::<u32>::new()));
            // Queue callers ONE AT A TIME (waiting until each is in the heap before
            // launching the next), so arrival order — and thus the FIFO tiebreak — is
            // deterministic. All foreground: ids 1,2 UserAction; 3,4 Interactive.
            let plan = [
                (1u32, Priority::UserAction),
                (2, Priority::UserAction),
                (3, Priority::Interactive),
                (4, Priority::Interactive),
            ];
            let mut threads = Vec::new();
            for (id, prio) in plan {
                let gate_t = Arc::clone(&gate);
                let order_t = Arc::clone(&order);
                let already = gate.queued();
                threads.push(thread::spawn(move || {
                    let permit = gate_t.acquire(prio);
                    order_t.lock().unwrap().push(id);
                    drop(permit);
                }));
                wait_until_queued(&gate, already + 1);
            }

            // Everyone is queued behind the holder; releasing lets the lane drain by
            // priority, then FIFO within a priority.
            drop(holder);
            for t in threads {
                t.join().unwrap();
            }

            // Interactive first (3 before 4), then UserAction (1 before 2).
            assert_eq!(*order.lock().unwrap(), vec![3, 4, 1, 2]);
        });
    }

    // (b) The two lanes are independent: a background call runs while a foreground one is
    // held, and a foreground call runs while a background one is held. Either acquire
    // would hang here — and trip the watchdog — if the gate serialised the two.
    #[test]
    fn the_two_lanes_run_independently() {
        with_watchdog(10, || {
            let gate = Gate::new();
            let fg = gate.acquire(Priority::Interactive);
            let bg = gate.acquire(Priority::Background);
            drop(bg);
            drop(fg);
            // And the other way round.
            let bg = gate.acquire(Priority::Background);
            drop(gate.acquire(Priority::Interactive));
            drop(bg);
        });
    }

    // (c)+(d) Mutual exclusion holds WITHIN each lane under many concurrent, mixed-priority
    // callers; at most two run at once (one per lane); and the whole thing terminates.
    #[test]
    fn never_admits_two_on_one_lane() {
        with_watchdog(20, || {
            let gate = Arc::new(Gate::new());
            let fg_inside = Arc::new(AtomicUsize::new(0));
            let bg_inside = Arc::new(AtomicUsize::new(0));
            let lane_overlaps = Arc::new(AtomicUsize::new(0));
            let peak_total = Arc::new(AtomicUsize::new(0));

            let mut threads = Vec::new();
            for t in 0..16u32 {
                let gate_t = Arc::clone(&gate);
                let fg_t = Arc::clone(&fg_inside);
                let bg_t = Arc::clone(&bg_inside);
                let overlaps_t = Arc::clone(&lane_overlaps);
                let peak_t = Arc::clone(&peak_total);
                threads.push(thread::spawn(move || {
                    // Rotate through the priorities so both lanes and the heap are worked.
                    let prio = match t % 3 {
                        0 => Priority::Background,
                        1 => Priority::UserAction,
                        _ => Priority::Interactive,
                    };
                    let background = super::is_background(prio);
                    for _ in 0..250 {
                        let permit = gate_t.acquire(prio);
                        let lane = if background { &bg_t } else { &fg_t };
                        // A per-lane counter that must never exceed 1 while the lane holds.
                        let now = lane.fetch_add(1, Ordering::SeqCst) + 1;
                        if now > 1 {
                            overlaps_t.fetch_add(1, Ordering::SeqCst);
                        }
                        // Across both lanes, at most two hold at once (one per lane).
                        let total = fg_t.load(Ordering::SeqCst) + bg_t.load(Ordering::SeqCst);
                        peak_t.fetch_max(total, Ordering::SeqCst);
                        // A brief, real critical section widens any overlap window.
                        thread::yield_now();
                        lane.fetch_sub(1, Ordering::SeqCst);
                        drop(permit);
                    }
                }));
            }
            for t in threads {
                t.join().unwrap();
            }

            assert_eq!(
                lane_overlaps.load(Ordering::SeqCst),
                0,
                "two RPCs were admitted on one lane at once"
            );
            assert!(
                peak_total.load(Ordering::SeqCst) <= 2,
                "more than two callers held the gate simultaneously"
            );
        });
    }

    // (d) A waiter given up on while it queues leaves without ever being admitted, and
    // the queue behind it drains as if it had never joined. This is the whole fix: a
    // superseded call has to stop costing the channel anything, not merely stop being
    // listened to.
    #[test]
    fn an_abandoned_waiter_leaves_the_queue() {
        with_watchdog(10, || {
            let gate = Arc::new(Gate::new());
            let holder = gate.acquire(Priority::Interactive);

            let gone = Arc::new(AtomicUsize::new(0)); // 0 = still queued, 1 = let go
            let admitted = Arc::new(Mutex::new(Vec::<u32>::new()));

            // Queued first and at the highest priority, so it would be admitted before
            // anyone else if it were still there when the holder releases.
            let gate_a = Arc::clone(&gate);
            let gone_a = Arc::clone(&gone);
            let admitted_a = Arc::clone(&admitted);
            let abandoned = thread::spawn(move || {
                let permit = gate_a.acquire_unless(Priority::Interactive, &|| {
                    gone_a.load(Ordering::SeqCst) == 1
                });
                if permit.is_some() {
                    admitted_a.lock().unwrap().push(1);
                }
                permit.is_some()
            });
            wait_until_queued(&gate, 1);

            let gate_b = Arc::clone(&gate);
            let admitted_b = Arc::clone(&admitted);
            let kept = thread::spawn(move || {
                let permit = gate_b.acquire(Priority::Interactive);
                admitted_b.lock().unwrap().push(2);
                drop(permit);
            });
            wait_until_queued(&gate, 2);

            // Let go of the first while both are still waiting on a busy channel.
            gone.store(1, Ordering::SeqCst);
            gate.wake_all();
            // It must leave on that wake alone, without the channel ever freeing up.
            while gate.queued() != 1 {
                thread::yield_now();
            }

            drop(holder);
            assert!(!abandoned.join().unwrap(), "an abandoned waiter was admitted");
            kept.join().unwrap();
            assert_eq!(
                *admitted.lock().unwrap(),
                vec![2],
                "only the caller still waiting for its answer should reach the channel"
            );
        });
    }

    // (e) The predicate is the only thing that drops a caller: one that is never
    // abandoned goes through exactly as `acquire` does.
    #[test]
    fn a_live_waiter_is_still_admitted() {
        with_watchdog(10, || {
            let gate = Gate::new();
            let permit = gate.acquire_unless(Priority::UserAction, &|| false);
            assert!(permit.is_some(), "a caller nobody let go of must be admitted");
            drop(permit);
            // And the channel is free afterwards, so the next caller does not hang.
            drop(gate.acquire(Priority::Background));
        });
    }
}

#[cfg(test)]
mod cancel_tests {
    // What the frontend's cancel actually reaches. `SidecarGate` spawns its Node process
    // lazily, so one can be built and exercised here without any sidecar existing.
    use super::SidecarGate;

    #[test]
    fn a_cancel_only_lands_while_the_call_is_outstanding() {
        let shared = SidecarGate::new();

        shared.track(7);
        assert!(!shared.is_abandoned(7), "a fresh call is not abandoned");
        shared.abandon(7);
        assert!(shared.is_abandoned(7));

        // Registering again must not undo a cancel that landed in between: the frontend
        // registers on the way in and the pool thread registers again when it starts.
        shared.track(7);
        assert!(shared.is_abandoned(7), "a second registration wiped the cancel");
    }

    #[test]
    fn a_cancel_that_lost_the_race_leaves_nothing_behind() {
        let shared = SidecarGate::new();

        // The call answered and stopped being followed before the cancel arrived.
        shared.track(1);
        shared.pending.lock().unwrap().remove(&1);
        shared.abandon(1);
        assert_eq!(shared.tracked(), 0, "a late cancel was remembered");
        assert!(!shared.is_abandoned(1));

        // Same for one that was never ours at all.
        shared.abandon(9999);
        assert_eq!(shared.tracked(), 0);
    }

    #[test]
    fn one_call_being_abandoned_says_nothing_about_another() {
        let shared = SidecarGate::new();
        shared.track(1);
        shared.track(2);
        shared.abandon(1);
        assert!(shared.is_abandoned(1));
        assert!(!shared.is_abandoned(2), "a cancel reached the wrong call");
        assert_eq!(shared.tracked(), 2);
    }
}

#[cfg(test)]
mod log_tests {
    use super::{deadline_for, priority_for, scrub, Priority};

    /// A node uid in the shape the mount actually holds one: two 86-character
    /// base64url halves joined by a tilde. This is what an SDK error string can carry
    /// into the log.
    fn uid() -> String {
        let half = "A".repeat(86);
        format!("{half}==~{half}==")
    }

    #[test]
    fn a_node_uid_does_not_survive() {
        let out = scrub(&format!("[cloud] hydrate download failed: {} is gone", uid()));
        assert!(!out.contains("AAAA"), "part of a uid survived: {out}");
        assert!(out.contains("hydrate download failed"), "the message was lost: {out}");
        assert!(out.contains("is gone"), "the tail was lost: {out}");
    }

    #[test]
    fn a_pgp_block_goes_whole() {
        let out = scrub("key: -----BEGIN PGP PRIVATE KEY BLOCK-----\nxyzzy\n-----END PGP PRIVATE KEY BLOCK-----\ndone");
        assert_eq!(out, "key: [redacted PGP block]\ndone");
    }

    #[test]
    fn an_unterminated_block_is_not_a_block() {
        // Otherwise a stray line of dashes would swallow everything logged after it.
        let line = "-----BEGIN PGP MESSAGE----- and then nothing";
        assert_eq!(scrub(line), line);
    }

    #[test]
    fn a_path_keeps_everything_but_the_account_name() {
        let out = scrub(r"sidecar missing: runtime C:\Users\jbrightwell\AppData\Local\App\x.exe (exists: false)");
        assert!(!out.contains("jbrightwell"), "the account name survived: {out}");
        assert!(out.contains(r"C:\Users\[user]\AppData\Local\App\x.exe"), "the path was lost: {out}");
    }

    #[test]
    fn an_email_and_a_url_both_go() {
        let out = scrub("failed for ada@example.com at https://drive-api.proton.me/v2/nodes?id=7");
        assert_eq!(out, "failed for [redacted email] at [redacted url]");
    }

    #[test]
    fn an_ordinary_line_is_left_alone() {
        for line in [
            "[cloud] populate: created 12 photo placeholders, reconciled 3 existing",
            "[rpc] getThumbnails wait=1200 hold=3400",
            "[rpc] getPreview wait=2600 dropped",
            "[cloud] hydrate start (size=4096 by=photosforproton.exe explicit=false)",
            "[freeup] convert-dehydrate failed: ERROR_INVALID_HANDLE",
        ] {
            assert_eq!(scrub(line), line, "an ordinary line was chewed up");
        }
    }

    #[test]
    fn only_the_slow_calls_get_the_long_deadline() {
        let long = deadline_for("hydrateFile");
        assert_eq!(deadline_for("getTimeline"), long, "a large library's timeline must not cost the session");
        assert_eq!(deadline_for("getOriginal"), long, "a whole-file transfer must not be cut short");
        // The whole-library sweeps come in by priority tier, not by a second list.
        assert_eq!(priority_for("listForMount"), Priority::Enumerate);
        assert_eq!(deadline_for("listForMount"), long);
        assert!(deadline_for("getPreview") < long);
        assert!(deadline_for("aMethodAddedLater") < long, "an unknown method waits the short one");
    }

    #[test]
    fn what_a_page_draws_goes_before_the_warmer() {
        for on_screen in ["getThumbnails", "getAlbums", "getAlbumPhotos", "getShared"] {
            assert!(
                priority_for(on_screen) > priority_for("warmThumbnails"),
                "{on_screen} would wait behind a warm batch"
            );
        }
        assert_eq!(priority_for("warmThumbnails"), Priority::Background);
    }
}
