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

//! With Detailed logging on, the host's CPU and memory, and its web view's where the OS
//! lets them be read, written into the app's log every few seconds:
//!   [res] host cpu=<percent> mem_mb=<n> webview cpu=<percent> mem_mb=<n> procs=<n>
//! Numbers only. With it off nothing is measured and nothing is written.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::AppHandle;

static DETAILED: AtomicBool = AtomicBool::new(false);
static SAMPLING: AtomicBool = AtomicBool::new(false);

/// How often a resource line is written.
const EVERY: Duration = Duration::from_secs(5);

/// CPU time a process (or a group of them) has used so far, and the memory it holds now.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct Usage {
    pub cpu: Duration,
    pub mem_bytes: u64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Sample {
    host: Option<Usage>,
    /// The web view's processes summed, and how many there are.
    webview: Option<(Usage, usize)>,
}

pub(crate) fn detailed() -> bool {
    DETAILED.load(Ordering::Relaxed)
}

/// Follows the Detailed logging setting: on starts the measuring, off ends it.
pub(crate) fn set_detailed(app: &AppHandle, on: bool) {
    DETAILED.store(on, Ordering::Relaxed);
    if on && !SAMPLING.swap(true, Ordering::AcqRel) {
        let app = app.clone();
        std::thread::spawn(move || sample_while_detailed(&app));
    }
}

fn sample_while_detailed(app: &AppHandle) {
    loop {
        let mut last: Option<(Instant, Sample)> = None;
        while detailed() {
            let at = Instant::now();
            let now = sample();
            if let Some((then, before)) = last {
                crate::note(app, &resource_line(&before, &now, at - then));
            }
            last = Some((at, now));
            std::thread::sleep(EVERY);
        }
        SAMPLING.store(false, Ordering::Release);
        // Turned on again while this thread was on its way out: it carries on rather than leave none.
        if !detailed() || SAMPLING.swap(true, Ordering::AcqRel) {
            return;
        }
    }
}

/// CPU use over `wall` as a percentage of one core, as top shows it.
pub(crate) fn cpu_percent(before: Duration, after: Duration, wall: Duration) -> f64 {
    if wall.is_zero() {
        return 0.0;
    }
    let used = after.saturating_sub(before);
    (used.as_secs_f64() / wall.as_secs_f64() * 1000.0).round() / 10.0
}

fn resource_line(before: &Sample, now: &Sample, wall: Duration) -> String {
    let part = |b: Option<Usage>, n: Option<Usage>| {
        n.map(|n| (cpu_percent(b.map(|b| b.cpu).unwrap_or(n.cpu), n.cpu, wall), n.mem_bytes))
    };
    format_line(
        part(before.host, now.host),
        now.webview.and_then(|(n, procs)| part(before.webview.map(|(b, _)| b), Some(n)).map(|(c, m)| (c, m, procs))),
    )
}

/// The log line for the host's and the web view's CPU percent and memory.
pub(crate) fn format_line(host: Option<(f64, u64)>, webview: Option<(f64, u64, usize)>) -> String {
    let mb = |bytes: u64| (bytes as f64 / 1_048_576.0).round() as u64;
    let mut line = String::from("[res]");
    if let Some((cpu, mem)) = host {
        line.push_str(&format!(" host cpu={cpu:.1} mem_mb={}", mb(mem)));
    }
    if let Some((cpu, mem, procs)) = webview {
        line.push_str(&format!(" webview cpu={cpu:.1} mem_mb={} procs={procs}", mb(mem)));
    }
    line
}

/// CPU time and memory from a Linux `/proc/<pid>/stat` and `/proc/<pid>/status`, with the
/// parent's pid and the process name. The kernel counts CPU time in USER_HZ, which is 100.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn parse_proc(stat: &str, status: &str) -> Option<(u32, String, Usage)> {
    let open = stat.find('(')?;
    let close = stat.rfind(')')?;
    let name = stat.get(open + 1..close)?.to_string();
    let fields: Vec<&str> = stat.get(close + 1..)?.split_whitespace().collect();
    // From the state on: ppid is the 2nd, utime the 12th and stime the 13th.
    let ppid = fields.get(1)?.parse().ok()?;
    let ticks: u64 = fields.get(11)?.parse::<u64>().ok()? + fields.get(12)?.parse::<u64>().ok()?;
    let rss_kb: u64 = status
        .lines()
        .find_map(|l| l.strip_prefix("VmRSS:"))
        .and_then(|v| v.split_whitespace().next())
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    Some((ppid, name, Usage { cpu: Duration::from_millis(ticks * 10), mem_bytes: rss_kb * 1024 }))
}

/// Every process below `root` in `parents` (pid to parent pid), however deep.
pub(crate) fn descendants(root: u32, parents: &[(u32, u32)]) -> Vec<u32> {
    let mut found = Vec::new();
    let mut frontier = vec![root];
    while let Some(parent) = frontier.pop() {
        for &(pid, ppid) in parents {
            if ppid == parent && pid != root && !found.contains(&pid) {
                found.push(pid);
                frontier.push(pid);
            }
        }
    }
    found
}

fn summed(parts: impl Iterator<Item = Usage>) -> Option<(Usage, usize)> {
    let mut total = Usage::default();
    let mut count = 0;
    for u in parts {
        total.cpu += u.cpu;
        total.mem_bytes += u.mem_bytes;
        count += 1;
    }
    (count > 0).then_some((total, count))
}

#[cfg(target_os = "linux")]
fn sample() -> Sample {
    let read = |pid: &str| {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        let status = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
        parse_proc(&stat, &status)
    };
    let host = read("self").map(|(_, _, u)| u);
    let mut procs: Vec<(u32, u32, String, Usage)> = Vec::new();
    if let Ok(dir) = std::fs::read_dir("/proc") {
        for entry in dir.flatten() {
            let name = entry.file_name();
            let Some(pid) = name.to_str().filter(|n| n.bytes().all(|b| b.is_ascii_digit())) else { continue };
            if let (Ok(id), Some((ppid, comm, usage))) = (pid.parse(), read(pid)) {
                procs.push((id, ppid, comm, usage));
            }
        }
    }
    let parents: Vec<(u32, u32)> = procs.iter().map(|p| (p.0, p.1)).collect();
    let below = descendants(std::process::id(), &parents);
    // WebKitGTK's web, network and GPU processes; under a Flatpak sandbox of their own they are out of reach.
    let webview = summed(procs.iter().filter(|p| below.contains(&p.0) && p.2.starts_with("WebKit")).map(|p| p.3));
    Sample { host, webview }
}

#[cfg(windows)]
fn sample() -> Sample {
    use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    fn usage(process: HANDLE) -> Option<Usage> {
        let (mut created, mut exited, mut kernel, mut user) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
        unsafe { GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user) }.ok()?;
        let hundred_ns = |t: FILETIME| ((t.dwHighDateTime as u64) << 32) | t.dwLowDateTime as u64;
        let mut memory = PROCESS_MEMORY_COUNTERS { cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32, ..Default::default() };
        if !unsafe { K32GetProcessMemoryInfo(process, &mut memory, memory.cb) }.as_bool() {
            return None;
        }
        Some(Usage { cpu: Duration::from_nanos((hundred_ns(kernel) + hundred_ns(user)) * 100), mem_bytes: memory.WorkingSetSize as u64 })
    }

    let host = usage(unsafe { GetCurrentProcess() });
    let mut procs: Vec<(u32, u32, String)> = Vec::new();
    if let Ok(snapshot) = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) } {
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut more = unsafe { Process32FirstW(snapshot, &mut entry) }.is_ok();
        while more {
            let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
            procs.push((entry.th32ProcessID, entry.th32ParentProcessID, String::from_utf16_lossy(&entry.szExeFile[..len])));
            more = unsafe { Process32NextW(snapshot, &mut entry) }.is_ok();
        }
        let _ = unsafe { CloseHandle(snapshot) };
    }
    let parents: Vec<(u32, u32)> = procs.iter().map(|p| (p.0, p.1)).collect();
    let below = descendants(std::process::id(), &parents);
    let webview = summed(
        procs
            .iter()
            .filter(|p| below.contains(&p.0) && p.2.eq_ignore_ascii_case("msedgewebview2.exe"))
            .filter_map(|p| {
                let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, p.0) }.ok()?;
                let got = usage(process);
                let _ = unsafe { CloseHandle(process) };
                got
            }),
    );
    Sample { host, webview }
}

/// The host alone: WebKit's processes on macOS are system services, not the app's children.
#[cfg(target_os = "macos")]
fn sample() -> Sample {
    let mut ru: libc::rusage = unsafe { std::mem::zeroed() };
    let cpu = (unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut ru) } == 0).then(|| {
        let tv = |t: libc::timeval| Duration::from_secs(t.tv_sec as u64) + Duration::from_micros(t.tv_usec as u64);
        tv(ru.ru_utime) + tv(ru.ru_stime)
    });
    let mut info: libc::proc_taskinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_taskinfo>() as libc::c_int;
    let read = unsafe {
        libc::proc_pidinfo(libc::getpid(), libc::PROC_PIDTASKINFO, 0, &mut info as *mut _ as *mut libc::c_void, size)
    };
    let host = cpu.map(|cpu| Usage { cpu, mem_bytes: if read == size { info.pti_resident_size } else { 0 } });
    Sample { host, webview: None }
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn sample() -> Sample {
    Sample::default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_the_host_and_the_web_view_in_numbers_only() {
        assert_eq!(
            format_line(Some((12.46, 180 * 1_048_576)), Some((3.0, 420 * 1_048_576, 4))),
            "[res] host cpu=12.5 mem_mb=180 webview cpu=3.0 mem_mb=420 procs=4"
        );
    }

    #[test]
    fn leaves_out_what_could_not_be_read() {
        assert_eq!(format_line(Some((0.0, 0)), None), "[res] host cpu=0.0 mem_mb=0");
        assert_eq!(format_line(None, None), "[res]");
    }

    #[test]
    fn counts_cpu_as_a_share_of_one_core() {
        let s = Duration::from_secs;
        assert_eq!(cpu_percent(s(10), s(11), s(5)), 20.0);
        assert_eq!(cpu_percent(s(10), s(20), s(5)), 200.0);
        assert_eq!(cpu_percent(s(10), s(9), s(5)), 0.0);
        assert_eq!(cpu_percent(s(10), s(11), Duration::ZERO), 0.0);
    }

    #[test]
    fn reads_a_linux_process_entry_with_spaces_in_its_name() {
        let stat = "4242 (WebKit Web) S 4100 4242 4242 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 12 0 100 1000 2000";
        let status = "Name:\tWebKitWebProces\nVmRSS:\t  204800 kB\nThreads:\t12\n";
        let (ppid, name, usage) = parse_proc(stat, status).unwrap();
        assert_eq!(ppid, 4100);
        assert_eq!(name, "WebKit Web");
        assert_eq!(usage, Usage { cpu: Duration::from_millis(3000), mem_bytes: 204_800 * 1024 });
    }

    #[test]
    fn refuses_a_cut_short_linux_entry() {
        assert!(parse_proc("4242 (x) S 1", "").is_none());
    }

    #[test]
    fn finds_every_process_below_the_host_however_deep() {
        let parents = [(2, 1), (3, 2), (4, 3), (5, 9), (1, 0)];
        let mut below = descendants(1, &parents);
        below.sort();
        assert_eq!(below, vec![2, 3, 4]);
        assert!(descendants(7, &parents).is_empty());
    }
}
