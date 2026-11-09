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

//! Notes in the log where the window's thread is stuck when it stops answering.
//!
//! A frozen window leaves nothing behind: Windows records no report for an app that is
//! closed from the Task Manager, and by the time anyone looks the thread is gone. So a
//! background thread asks the window's thread to answer once a second, and when it has
//! been silent for a while reads its call stack into the log.
//!
//! The stack is written as module names and offsets only, such as `user32.dll+0x1a2b`.
//! They name code, never a path, a file or anything of the user's. The offsets into this
//! app's own executable are turned into function names afterwards, with the `.pdb` of
//! the same build.

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::AppHandle;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, DuplicateHandle, DUPLICATE_SAME_ACCESS, HANDLE, HMODULE};
use windows::Win32::System::Diagnostics::Debug::{
    GetThreadContext, RtlLookupFunctionEntry, RtlVirtualUnwind, CONTEXT, CONTEXT_FULL_AMD64,
    UNW_FLAG_NHANDLER,
};
use windows::Win32::System::LibraryLoader::{
    GetModuleFileNameW, GetModuleHandleExW, GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
    GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
};
use windows::Win32::System::Threading::{
    GetCurrentProcess, GetCurrentThreadId, GetCurrentThreadStackLimits, OpenThread, ResumeThread, SuspendThread, THREAD_GET_CONTEXT,
    THREAD_QUERY_INFORMATION, THREAD_SUSPEND_RESUME,
};

/// How often the window's thread is asked to answer.
const POLL: Duration = Duration::from_secs(1);

/// After how many unanswered polls the stack is read: once when the window has clearly
/// stalled, and again later, because a stack that has not moved by then is stuck rather
/// than slow. Counted in polls and not by the clock, so a laptop that slept through a
/// poll is not taken for a freeze.
const REPORT_AT: [u32; 2] = [10, 60];

/// The most stacks one run writes, so that a window that keeps stalling cannot fill the log.
const MAX_REPORTS: u32 = 20;

/// How many frames of a stack are kept.
const MAX_FRAMES: usize = 48;

/// What one poll's answer, or its absence, calls for.
#[derive(Debug, PartialEq, Eq)]
enum Step {
    Nothing,
    /// Silent for this many polls: read the stack now.
    Report(u32),
    /// Answering again, after this many polls of silence that were reported.
    Recovered(u32),
}

#[derive(Default)]
struct Detector {
    silent: u32,
    reported: bool,
}

impl Detector {
    fn observe(&mut self, answered: bool) -> Step {
        if answered {
            let silent = std::mem::take(&mut self.silent);
            return if std::mem::take(&mut self.reported) {
                Step::Recovered(silent)
            } else {
                Step::Nothing
            };
        }
        self.silent = self.silent.saturating_add(1);
        if REPORT_AT.contains(&self.silent) {
            self.reported = true;
            Step::Report(self.silent)
        } else {
            Step::Nothing
        }
    }
}

/// Starts watching the calling thread, which must be the window's. `setup` runs there.
pub fn start(app: &AppHandle) {
    let window_thread = unsafe { GetCurrentThreadId() };
    let (mut low, mut high) = (0usize, 0usize);
    unsafe { GetCurrentThreadStackLimits(&mut low, &mut high) };
    let limits = (low as u64, high as u64);
    let app = app.clone();
    let _ = std::thread::Builder::new()
        .name("hang-watch".into())
        .spawn(move || watch(app, window_thread, limits));
}

fn watch(app: AppHandle, window_thread: u32, limits: StackLimits) {
    let answered = Arc::new(AtomicU64::new(0));
    let mut detector = Detector::default();
    let mut reports = 0;
    let mut asked = 0;
    let mut waiting = false;
    loop {
        // One question at a time: a stuck thread would otherwise come back to a queue of them.
        if !waiting {
            asked += 1;
            let answer = answered.clone();
            let this = asked;
            if app
                .run_on_main_thread(move || answer.store(this, Ordering::Relaxed))
                .is_err()
            {
                return; // The event loop has ended, so the app is closing.
            }
            waiting = true;
        }
        std::thread::sleep(POLL);
        let got = answered.load(Ordering::Relaxed) >= asked;
        if got {
            waiting = false;
        }
        match detector.observe(got) {
            Step::Nothing => {}
            Step::Report(silent) if reports < MAX_REPORTS => {
                reports += 1;
                crate::note(&app, &report_line(silent, read_stack(window_thread, limits)));
            }
            Step::Report(_) => {}
            Step::Recovered(silent) => {
                crate::note(&app, &format!("[hang] window thread answering again after {silent}s"));
            }
        }
    }
}

fn report_line(silent: u32, stack: Result<Vec<String>, String>) -> String {
    match stack {
        Ok(frames) => format!("[hang] window thread silent for {silent}s: {}", frames.join(" ")),
        Err(why) => format!("[hang] window thread silent for {silent}s, stack unavailable: {why}"),
    }
}

/// `CONTEXT` must sit on a 16-byte boundary, which the type does not ask for itself.
#[repr(C, align(16))]
struct AlignedContext(CONTEXT);

/// Reads another thread's call stack as `module+0xoffset` entries, innermost first.
fn read_stack(thread_id: u32, limits: StackLimits) -> Result<Vec<String>, String> {
    let access = THREAD_SUSPEND_RESUME | THREAD_GET_CONTEXT | THREAD_QUERY_INFORMATION;
    let thread = unsafe { OpenThread(access, false, thread_id) }.map_err(|e| format!("open: {e}"))?;
    let mut addresses = [0u64; MAX_FRAMES];
    let count = unsafe { walk_suspended(thread, &mut addresses, limits) };
    let _ = unsafe { CloseHandle(thread) };
    Ok(addresses[..count?].iter().map(|a| describe(*a)).collect())
}

/// How long the thread may stay suspended before a helper resumes it regardless.
const RESUME_BUDGET: Duration = Duration::from_millis(200);

/// The longest this side waits for the helper: to start running, and to finish.
const HELPER_WAIT: Duration = Duration::from_millis(500);

/// The window thread's stack, low and high address, as `GetCurrentThreadStackLimits` gives.
type StackLimits = (u64, u64);

const UNDECIDED: u8 = 0;
const WALKER: u8 = 1;
const WATCHDOG: u8 = 2;

/// Decides which side resumes the suspended thread: the first to claim it, and only that one.
struct ResumeGate(AtomicU8);

impl ResumeGate {
    fn new() -> Self {
        ResumeGate(AtomicU8::new(UNDECIDED))
    }

    /// True for the one caller that may resume the thread, false for every later one.
    fn claim(&self, who: u8) -> bool {
        self.0.compare_exchange(UNDECIDED, who, Ordering::AcqRel, Ordering::Acquire).is_ok()
    }

    /// True once the helper has resumed the thread: its stack is moving again.
    fn watchdog_fired(&self) -> bool {
        self.0.load(Ordering::Acquire) == WATCHDOG
    }
}

/// Whether the walk may go on reading from `rsp`: only while the thread is still frozen,
/// and only while the stack pointer is inside the thread's stack with room for a read.
fn may_continue(gate: &ResumeGate, rsp: u64, limits: StackLimits) -> bool {
    !gate.watchdog_fired() && rsp >= limits.0 && rsp.checked_add(8).is_some_and(|end| end <= limits.1)
}

/// Suspends the thread, walks its stack into `addresses` and resumes it.
///
/// The walk looks up unwind tables, which can take locks inside ntdll that the suspended
/// thread may be holding, and then the walk would wait for ever. So a helper thread,
/// started and confirmed running before the suspend, resumes the target itself if the walk
/// has not finished within `RESUME_BUDGET`. Exactly one side resumes it, whichever claims
/// it first. If the helper did, the walk stops reading at once, since the stack is moving
/// again, and its result is dropped. The walk itself allocates nothing, and this side
/// never waits on the helper for longer than `HELPER_WAIT`.
unsafe fn walk_suspended(
    thread: HANDLE,
    addresses: &mut [u64; MAX_FRAMES],
    limits: StackLimits,
) -> Result<usize, String> {
    unsafe { capture(thread, RESUME_BUDGET, |context, gate| unwind(context, addresses, gate, limits)) }
}

const WAITING: u8 = 0;
const SUSPENDED: u8 = 1;
const FINISHED: u8 = 2;

/// The helper that resumes the thread if the walk stalls. It does nothing until told the
/// thread is suspended, then gives the walk `budget` and resumes the thread itself if the
/// walk has not finished, unless the gate says the walker already did. Signals are atomics
/// and an unpark, so they are safe to send while the target holds any lock. It owns a
/// duplicate of the thread handle and shares the rest by `Arc`, so a helper that outlives
/// the call touches nothing that was released, and it resumes only while the phase says
/// suspended, which `finish` ends.
struct Watchdog {
    phase: Arc<AtomicU8>,
    ready: Arc<AtomicBool>,
    done: Arc<AtomicBool>,
    helper: std::thread::Thread,
}

impl Watchdog {
    fn spawn(thread: HANDLE, gate: Arc<ResumeGate>, budget: Duration) -> Option<Watchdog> {
        let mut own = HANDLE::default();
        unsafe {
            let process = GetCurrentProcess();
            DuplicateHandle(process, thread, process, &mut own, 0, false, DUPLICATE_SAME_ACCESS).ok()?;
        }
        let raw = own.0 as isize;
        let phase = Arc::new(AtomicU8::new(WAITING));
        let ready = Arc::new(AtomicBool::new(false));
        let done = Arc::new(AtomicBool::new(false));
        let (seen, up, over) = (phase.clone(), ready.clone(), done.clone());
        let spawned = std::thread::Builder::new().name("hang-watch-resume".into()).spawn(move || {
            up.store(true, Ordering::Release);
            let own = HANDLE(raw as *mut core::ffi::c_void);
            // No limit on this wait: the clock starts at the suspend, not before. The short
            // timeout means a store is seen even if its wake is missed.
            while seen.load(Ordering::Acquire) == WAITING {
                std::thread::park_timeout(Duration::from_millis(5));
            }
            let deadline = std::time::Instant::now() + budget;
            while seen.load(Ordering::Acquire) == SUSPENDED {
                let left = deadline.saturating_duration_since(std::time::Instant::now());
                if left.is_zero() {
                    if gate.claim(WATCHDOG) {
                        unsafe { ResumeThread(own) };
                    }
                    break;
                }
                std::thread::park_timeout(left.min(Duration::from_millis(5)));
            }
            let _ = unsafe { CloseHandle(own) };
            // Last, so that thread exit, which the loader can hold up, is never waited on.
            over.store(true, Ordering::Release);
        });
        match spawned {
            Ok(join) => Some(Watchdog { phase, ready, done, helper: join.thread().clone() }),
            Err(_) => {
                let _ = unsafe { CloseHandle(own) };
                None
            }
        }
    }

    /// Waits a bounded time for the helper to be running.
    fn started(&self) -> bool {
        wait_for(&self.ready)
    }

    /// The thread is suspended: start counting.
    fn suspended(&self) {
        self.phase.store(SUSPENDED, Ordering::Release);
        self.helper.unpark();
    }

    /// Nothing is left to guard: the helper stops without resuming anything. Waits for it
    /// only a bounded time, and lets go of a helper that does not finish.
    fn finish(self) {
        self.phase.store(FINISHED, Ordering::Release);
        self.helper.unpark();
        wait_for(&self.done);
    }
}

fn wait_for(flag: &AtomicBool) -> bool {
    let until = std::time::Instant::now() + HELPER_WAIT;
    while !flag.load(Ordering::Acquire) {
        if std::time::Instant::now() >= until {
            return false;
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    true
}

unsafe fn capture(
    thread: HANDLE,
    budget: Duration,
    walk: impl FnOnce(&mut CONTEXT, &ResumeGate) -> usize,
) -> Result<usize, String> {
    let gate = Arc::new(ResumeGate::new());
    let Some(watchdog) = Watchdog::spawn(thread, gate.clone(), budget) else {
        return Err("watchdog".to_string());
    };
    if !watchdog.started() {
        // Never suspend without a helper that can undo it.
        watchdog.finish();
        return Err("watchdog did not start".to_string());
    }
    if unsafe { SuspendThread(thread) } == u32::MAX {
        watchdog.finish();
        return Err("suspend".to_string());
    }
    // From here the helper's clock runs. Signalling it takes no lock and no allocation.
    watchdog.suspended();
    // SAFETY: an all-zero CONTEXT is a valid value of this plain-data struct.
    let mut context = AlignedContext(unsafe { std::mem::zeroed() });
    context.0.ContextFlags = CONTEXT_FULL_AMD64;
    let read = unsafe { GetThreadContext(thread, &mut context.0) }.is_ok();
    let count = if read { walk(&mut context.0, &gate) } else { 0 };
    let resume = gate.claim(WALKER);
    if resume {
        unsafe { ResumeThread(thread) };
    }
    watchdog.finish();
    if !resume {
        return Err("timed out walking the stack, thread resumed".to_string());
    }
    if read {
        Ok(count)
    } else {
        Err("context".to_string())
    }
}

/// Unwinds with the unwind tables Windows keeps for every x64 module. Stops, keeping what
/// it has, as soon as `may_continue` says the stack can no longer be trusted.
unsafe fn unwind(
    context: &mut CONTEXT,
    addresses: &mut [u64; MAX_FRAMES],
    gate: &ResumeGate,
    limits: StackLimits,
) -> usize {
    let mut count = 0;
    while count < MAX_FRAMES && context.Rip != 0 && may_continue(gate, context.Rsp, limits) {
        addresses[count] = context.Rip;
        count += 1;
        let mut image_base = 0u64;
        let function = unsafe { RtlLookupFunctionEntry(context.Rip, &mut image_base, None) };
        if !may_continue(gate, context.Rsp, limits) {
            break;
        }
        if function.is_null() {
            // Only the innermost frame can be a leaf with no table entry, its return
            // address on top of the stack. Further out, no entry means the walk has lost
            // its footing, and following it could read past the end of the stack.
            if count > 1 {
                break;
            }
            // SAFETY: may_continue has just found Rsp inside the thread's stack, with
            // room for the read, and the helper has not yet resumed the thread.
            context.Rip = unsafe { *(context.Rsp as *const u64) };
            context.Rsp += 8;
            continue;
        }
        let mut handler_data = std::ptr::null_mut();
        let mut establisher_frame = 0u64;
        // SAFETY: the same check has passed just above. The helper can resume the thread
        // between the check and the unwind, so the unwind may read stack that is moving; it
        // reads inside the stack's bounds, which stay mapped, and its result is dropped.
        unsafe {
            RtlVirtualUnwind(
                UNW_FLAG_NHANDLER,
                image_base,
                context.Rip,
                function,
                context,
                &mut handler_data,
                &mut establisher_frame,
                None,
            );
        }
    }
    count
}

/// One address as its module's bare name and the offset into it. Never the module's path,
/// which would hold the user's name.
fn describe(address: u64) -> String {
    let flags = GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT;
    let mut module = HMODULE::default();
    let found = unsafe { GetModuleHandleExW(flags, PCWSTR(address as *const u16), &mut module) };
    if found.is_err() {
        return "unknown".to_string();
    }
    let mut path = [0u16; 1024];
    let length = unsafe { GetModuleFileNameW(Some(module), &mut path) } as usize;
    let full = String::from_utf16_lossy(&path[..length.min(path.len())]);
    let name = full.rsplit(['\\', '/']).next().unwrap_or("unknown").to_ascii_lowercase();
    format!("{name}+0x{:x}", address.wrapping_sub(module.0 as u64))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn silence(detector: &mut Detector, polls: u32) -> Vec<Step> {
        (0..polls)
            .map(|_| detector.observe(false))
            .filter(|s| *s != Step::Nothing)
            .collect()
    }

    #[test]
    fn a_short_pause_writes_nothing() {
        let mut d = Detector::default();
        assert!(silence(&mut d, 9).is_empty());
        assert_eq!(d.observe(true), Step::Nothing);
    }

    #[test]
    fn a_freeze_is_reported_when_it_stalls_and_again_if_it_stays() {
        let mut d = Detector::default();
        assert_eq!(silence(&mut d, 70), vec![Step::Report(10), Step::Report(60)]);
    }

    #[test]
    fn a_reported_freeze_says_when_it_ends_and_counts_from_zero_after() {
        let mut d = Detector::default();
        silence(&mut d, 12);
        assert_eq!(d.observe(true), Step::Recovered(12));
        assert_eq!(d.observe(true), Step::Nothing);
        assert_eq!(silence(&mut d, 10), vec![Step::Report(10)]);
    }

    #[test]
    fn another_threads_stack_is_read_and_the_thread_carries_on() {
        let (id_tx, id_rx) = std::sync::mpsc::channel();
        let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
        let parked = std::thread::spawn(move || {
            id_tx.send((unsafe { GetCurrentThreadId() }, my_limits())).unwrap();
            let _ = stop_rx.recv();
        });
        let (id, limits) = id_rx.recv().unwrap();
        std::thread::sleep(Duration::from_millis(200));

        let frames = read_stack(id, limits).expect("the stack should be readable");

        stop_tx.send(()).unwrap();
        parked.join().expect("the thread should have been resumed");
        assert!(frames.len() >= 3, "too few frames: {frames:?}");
        assert!(frames[0].starts_with("ntdll.dll+0x"), "innermost frame: {frames:?}");
        assert!(frames.iter().any(|f| f.contains(".exe+0x")), "no frame in this program: {frames:?}");
    }

    fn my_limits() -> StackLimits {
        let (mut low, mut high) = (0usize, 0usize);
        unsafe { GetCurrentThreadStackLimits(&mut low, &mut high) };
        (low as u64, high as u64)
    }

    fn parked_thread() -> (u32, StackLimits, std::sync::mpsc::Sender<()>, std::thread::JoinHandle<()>) {
        let (id_tx, id_rx) = std::sync::mpsc::channel();
        let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
        let parked = std::thread::spawn(move || {
            id_tx.send((unsafe { GetCurrentThreadId() }, my_limits())).unwrap();
            let _ = stop_rx.recv();
        });
        let (id, limits) = id_rx.recv().unwrap();
        std::thread::sleep(Duration::from_millis(200));
        (id, limits, stop_tx, parked)
    }

    fn open(id: u32) -> HANDLE {
        let access = THREAD_SUSPEND_RESUME | THREAD_GET_CONTEXT | THREAD_QUERY_INFORMATION;
        unsafe { OpenThread(access, false, id) }.unwrap()
    }

    /// How many times the thread is suspended now, found by suspending it once and undoing it.
    fn suspend_count(id: u32) -> u32 {
        let thread = open(id);
        let before = unsafe { SuspendThread(thread) };
        unsafe { ResumeThread(thread) };
        let _ = unsafe { CloseHandle(thread) };
        before
    }

    #[test]
    fn the_first_side_to_claim_resumes_and_the_other_does_not() {
        let walker_first = ResumeGate::new();
        assert!(walker_first.claim(WALKER));
        assert!(!walker_first.claim(WATCHDOG));
        assert!(!walker_first.claim(WALKER));

        let watchdog_first = ResumeGate::new();
        assert!(watchdog_first.claim(WATCHDOG));
        assert!(!watchdog_first.claim(WALKER));
    }

    #[test]
    fn a_normal_walk_resumes_the_thread_once_and_returns_frames() {
        let (id, limits, stop, parked) = parked_thread();
        let thread = open(id);
        let mut addresses = [0u64; MAX_FRAMES];
        let count = unsafe { walk_suspended(thread, &mut addresses, limits) }.expect("walk");
        let _ = unsafe { CloseHandle(thread) };
        assert!(count >= 3, "too few frames: {count}");
        assert_eq!(suspend_count(id), 0, "left suspended");
        // The helper must stay quiet once the walk has resumed the thread.
        std::thread::sleep(RESUME_BUDGET + Duration::from_millis(100));
        assert_eq!(suspend_count(id), 0);
        stop.send(()).unwrap();
        parked.join().unwrap();
    }

    #[test]
    fn a_walk_that_stalls_is_cut_off_the_thread_resumed_and_the_result_dropped() {
        let (id, _, stop, parked) = parked_thread();
        let thread = open(id);
        let result = unsafe {
            capture(thread, Duration::from_millis(50), |_, _| {
                std::thread::sleep(Duration::from_millis(400));
                7
            })
        };
        let _ = unsafe { CloseHandle(thread) };
        let why = result.expect_err("a stalled walk must not give a stack");
        assert!(why.contains("timed out"), "{why}");
        assert_eq!(suspend_count(id), 0, "left suspended");
        stop.send(()).unwrap();
        parked.join().expect("the thread should be running");
    }

    #[test]
    fn the_watchdog_counts_only_from_the_suspend_and_never_before() {
        let (id, _, stop, parked) = parked_thread();
        let thread = open(id);
        let gate = Arc::new(ResumeGate::new());
        let watchdog = Watchdog::spawn(thread, gate.clone(), Duration::from_millis(50)).unwrap();
        // Well past the budget, and not yet told: it must not have touched the thread.
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(gate.0.load(Ordering::Acquire), UNDECIDED, "claimed before the signal");
        unsafe { SuspendThread(thread) };
        watchdog.suspended();
        std::thread::sleep(Duration::from_millis(300));
        // Told, and the walk never finished: it resumed the thread once.
        assert_eq!(gate.0.load(Ordering::Acquire), WATCHDOG);
        assert_eq!(suspend_count(id), 0, "still suspended");
        watchdog.finish();
        let _ = unsafe { CloseHandle(thread) };
        stop.send(()).unwrap();
        parked.join().unwrap();
    }

    #[test]
    fn a_watchdog_told_to_finish_exits_without_resuming() {
        let (id, _, stop, parked) = parked_thread();
        let thread = open(id);
        let gate = Arc::new(ResumeGate::new());
        let watchdog = Watchdog::spawn(thread, gate.clone(), Duration::from_millis(50)).unwrap();
        let started = std::time::Instant::now();
        watchdog.finish();
        assert!(started.elapsed() < Duration::from_millis(200), "did not exit promptly");
        assert_eq!(gate.0.load(Ordering::Acquire), UNDECIDED);
        let _ = unsafe { CloseHandle(thread) };
        stop.send(()).unwrap();
        parked.join().unwrap();
    }

    #[test]
    fn the_walk_stops_when_the_helper_has_resumed_or_the_stack_pointer_leaves_the_stack() {
        let limits = (0x1000u64, 0x2000u64);
        let frozen = ResumeGate::new();
        assert!(may_continue(&frozen, 0x1000, limits));
        assert!(may_continue(&frozen, 0x1ff8, limits));
        assert!(!may_continue(&frozen, 0xff8, limits), "below the stack");
        assert!(!may_continue(&frozen, 0x1ff9, limits), "no room for a read");
        assert!(!may_continue(&frozen, 0x2000, limits), "above the stack");
        assert!(!may_continue(&frozen, u64::MAX, limits), "wrapping");
        assert!(!may_continue(&frozen, 0, limits));

        // The walker's own claim comes after the walk, so only the helper's stops it.
        let resumed = ResumeGate::new();
        assert!(resumed.claim(WATCHDOG));
        assert!(!may_continue(&resumed, 0x1800, limits));
    }

    #[test]
    fn the_walk_of_a_live_thread_keeps_inside_its_stack() {
        let (id, limits, stop, parked) = parked_thread();
        let thread = open(id);
        let mut addresses = [0u64; MAX_FRAMES];
        // Limits that exclude the real stack: nothing may be read.
        let none = unsafe {
            capture(thread, RESUME_BUDGET, |c, g| unwind(c, &mut addresses, g, (limits.1, limits.1 + 8)))
        };
        let _ = unsafe { CloseHandle(thread) };
        assert_eq!(none, Ok(0));
        assert_eq!(suspend_count(id), 0);
        stop.send(()).unwrap();
        parked.join().unwrap();
    }

    #[test]
    fn the_report_holds_no_path_and_survives_the_log_scrubber() {
        let id = unsafe { GetCurrentThreadId() };
        let (tx, rx) = std::sync::mpsc::channel();
        let limits = my_limits();
        let reader = std::thread::spawn(move || tx.send(read_stack(id, limits)).unwrap());
        let stack = rx.recv().unwrap();
        reader.join().unwrap();

        let line = report_line(10, stack);
        assert!(!line.contains('\\') && !line.contains(":/"), "{line}");
        assert_eq!(crate::scrub(&line), line);
    }
}
