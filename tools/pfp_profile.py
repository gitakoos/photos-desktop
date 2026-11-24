#!/usr/bin/env python3
#
# Photos for Proton
# Copyright (C) 2026 Akoos <https://akoos.eu>
#
# Source:  https://github.com/gitakoos/photos-desktop
# Website: https://www.photosforproton.eu
#
# This file is part of Photos for Proton.
#
# Photos for Proton is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License version 3 as
# published by the Free Software Foundation.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program. If not, see <https://www.gnu.org/licenses/>.
"""
pfp_profile.py - profile the Photos for Proton desktop app (Linux) from the outside.

No build, no root, no extra packages: it only reads /proc for the app's processes
while you walk through a fixed scenario, then collects the app's own slow-call log.

What it records
  - per process, once a second: CPU, memory (RSS, PSS), thread count, disk I/O
  - for each process, how busy its MAIN thread is (a main thread stuck near 100%
    is what makes an app feel frozen)
  - which threads of the Node sidecar burn the CPU
  - the app's "[rpc] <method> wait=<ms> hold=<ms>" log lines written during the run
    (the app logs every call that waited or ran for 1 s or more)
  - the sidecar's timing of the steps of its face, search and Explorer-folder work
    ("[diag] ..." lines: a step name and its milliseconds; the slow ones only, or every
    one with Settings > Diagnostics > Detailed logging on)
  - the face scan's passes ("[diag] ... faces pass_start / pass_end": counts and seconds)
  - the app's watchdog lines for calls still stuck (waiting or running for 5 s or more),
    how many of Proton's download slots are held, and what the thumbnail server has open
  - the screen the window shows, as it changes ("[screen] <name>": a fixed word)

What it does NOT record
  - no photo names, no file contents, no account data, no hostname, no username
  - from the app log it copies ONLY the lines named above: method, step and screen names,
    durations and counts

Usage
  1. Close the app completely.
  2. python3 pfp_profile.py
  3. Follow the prompts (about 10 minutes).
  4. Upload the .tar.gz it prints at the end.

Watching, with nothing to answer
  python3 pfp_profile.py --watch      (or --people)
  start the app, use it, quit it: the run is split by the screen the app says it shows, and
  the summary opens with the busiest moments, each with its screen, the sidecar's threads
  and what the app logged then.

Options
  --app-id ID     Flatpak app id (default eu.akoos.photos)
  --watch         follow the app's screens, no steps or questions
  --people        the same as --watch
  --idle SECONDS  length of the final idle step (default 30)
  --ask           ask about the library and the build, for the record
"""

import argparse
import json
import os
import platform
import re
import subprocess
import sys
import tarfile
import threading
import time
from collections import defaultdict
from datetime import datetime, timezone

CLK = os.sysconf("SC_CLK_TCK")
PAGE = os.sysconf("SC_PAGE_SIZE")
RPC_LINE = re.compile(r"^\[(\d\d):(\d\d):(\d\d)\] \[host\] \[rpc\] (\w+) wait=(\d+) hold=(\d+)")
OTHER_TAG = re.compile(r"^\[\d\d:\d\d:\d\d\] \[(\w+)\] \[(\w+)\]")
# The app's watchdog, every 5 s while a call is stuck (method names and counts only):
STUCK_LINE = re.compile(
    r"^\[(\d\d):(\d\d):(\d\d)\] \[host\] \[rpc\] (\w+) stuck lane=(fg|bg) (?:waiting=(\d+)|running=(\d+) waited=(\d+))")
QUEUE_LINE = re.compile(r"^\[(\d\d):(\d\d):(\d\d)\] \[host\] \[rpc\] queue (stuck=\d+ .*)$")
THUMBS_LINE = re.compile(
    r"^\[(\d\d):(\d\d):(\d\d)\] \[sidecar\] \[thumbs\] open=(\d+) oldest=(\d+) served=(\d+) "
    r"missing=(\d+) failed=(\d+) dropped=(\d+)")
# The window's screen, as it changes (a fixed screen name only):
SCREEN_LINE = re.compile(r"^\[(\d\d):(\d\d):(\d\d)\] \[host\] \[screen\] ([a-z0-9_]{1,40})\s*$")
# The sidecar's own timing of a step of its face, search and Explorer-folder work, as its
# diagnostics write a timed call: "slow_" before the name past 3 s, "failed_" when it threw,
# and the bare name for every one with detailed logging on. Stamped in local time. Only these
# steps: the same lines also time each photo of a scan, which would bury them.
WORK_STEPS = (
    "models", "load_faces", "load_search", "list_library", "list_trash", "keep_only",
    "search_keep_only", "search_take_in", "adopt_phone_scans", "place_adopted", "todo",
    "compare_phone", "take_in_copy", "regroup_all", "list_people",
    "mount_trash", "mount_shared", "mount_albums", "mount_meta",
)
STEP_LINE = re.compile(
    r"^\[diag\] (\d\d):(\d\d):(\d\d)\.\d{3} (?:faces|drive) (?:slow_|failed_)?(" + "|".join(WORK_STEPS) +
    r") ms=(\d+)(?: |\s*$)")
# A face scan pass starting or ending, and each batch of photos it read: counts and times only.
# Keys and values as the sidecar's diagnostics write them (a code word, or "[x]").
PASS_LINE = re.compile(
    r"^\[diag\] (\d\d):(\d\d):(\d\d)\.\d{3} faces (pass_start|pass_end|scan_batch)"
    r"((?: [A-Za-z0-9_.:+-]+=(?:[A-Za-z0-9_.:+-]+|\[x\]))*)\s*$")
SLOTS_LINE = re.compile(r"^\[(\d\d):(\d\d):(\d\d)\] \[sidecar\] \[slots\] in_use=(\d+) oldest=(\d+)")

STEPS = [
    ("launch",
     "Press Enter, THEN start the app.\n"
     "   Press Enter again as soon as its window shows anything (lock screen or photos)."),
    ("unlock_to_ready",
     "Unlock / sign in if asked, and wait until the timeline is filled with thumbnails.\n"
     "   Press Enter when the first screen of photos is fully drawn."),
    ("scroll_down",
     "Scroll DOWN through the timeline steadily for about 30 seconds.\n"
     "   Press Enter when done."),
    ("scroll_back",
     "Scroll back UP to the top, through the photos you just passed.\n"
     "   Press Enter when you are at the top."),
    ("viewer",
     "Open a photo and step through about 20 photos with the arrow key, then close it.\n"
     "   Press Enter when done."),
    ("video",
     "Open a video (ideally 20-100 MB), let it play 10 seconds, close it.\n"
     "   Press Enter when done, or type s + Enter to skip."),
    ("people",
     "Open People and scroll the whole list of people, down and back up. Then open\n"
     "   the person with the most photos, scroll a little, and go back to People.\n"
     "   Take about a minute. Press Enter when done, or s + Enter to skip."),
    ("search",
     "Search for something by content (for example: beach) and wait for results.\n"
     "   Press Enter when results are shown, or s + Enter to skip."),
]


def follow_screens(sampler, log_path, offset, limit, app_id, already_running):
    """A run with no steps to follow: takes the step of the run from the screen the window says
    it shows (its "[screen] ..." log lines) until the app is quit, Ctrl+C, or `limit` seconds.
    Returns the run's steps as (name, start, end, False), and whether the log was rotated."""
    if already_running:
        print("The app is already running: measuring it from now. Switch to a screen to start.")
    else:
        print("Start the app now (from the menu, or: flatpak run eu.akoos.photos).")
    print("Use it as you like: open the screens that feel slow and stay a little on each.")
    print("When done, quit the app (its Quit; closing the window may only hide it) or press")
    print("Ctrl+C here. Nothing to answer.\n")
    seen_app = already_running
    gone_since = None
    phases = []
    current, started = "starting", 0.0
    counts = defaultdict(int)
    pos = offset
    rotated = False
    screens_seen = 0
    t_end = time.monotonic() + limit
    ended = "limit"

    def switch(name):
        nonlocal current, started
        now = time.monotonic() - sampler.t0
        phases.append((current, started, now, False))
        counts[name] += 1
        current = name if counts[name] == 1 else f"{name}#{counts[name]}"
        started = now
        sampler.phase = current
        print(f"\r   {now:6.0f} s  screen: {name:24}", end="", flush=True)

    sampler.phase = current
    checked = 0
    try:
        while time.monotonic() < t_end:
            time.sleep(0.5)
            # A first run may have no log yet: looked for again until there is one.
            if not log_path:
                log_path = find_log(app_id)
                pos = 0
            try:
                if log_path and os.path.exists(log_path):
                    size = os.path.getsize(log_path)
                    if size < pos:
                        pos, rotated = 0, True  # the log was rotated
                    if size > pos:
                        with open(log_path, "r", errors="replace") as f:
                            f.seek(pos)
                            chunk = f.read()
                            pos = f.tell()
                        for line in chunk.splitlines():
                            m = SCREEN_LINE.match(line)
                            if m:
                                screens_seen += 1
                                switch(m.group(4))
            except OSError:
                pass
            # Whether the app still runs, once a second (the sampler scans /proc as well).
            checked += 1
            if checked % 2:
                continue
            if sampler.find_pids():
                seen_app, gone_since = True, None
            elif seen_app:
                gone_since = gone_since or time.monotonic()
                if time.monotonic() - gone_since > 3:
                    ended = "quit"
                    break
    except KeyboardInterrupt:
        ended = "ctrl-c"
    print()
    if ended == "limit":
        print(f"   Stopped after {limit // 60} minutes.")
    if screens_seen == 0:
        print("   The app wrote no screen names: this build may not have them, so the run is one step.")
    end = (time.monotonic() - sampler.t0) - (3.5 if ended == "quit" else 0)
    phases.append((current, started, max(end, started), False))
    return [p for p in phases if p[2] - p[1] >= 0.5], rotated, ended, log_path


def spikes_summary(rows, thread_ticks, phases, events):
    """The moments the app took the most CPU, each with what the window showed, which of the
    sidecar's threads ran, and what the app logged around it."""
    per_t = defaultdict(lambda: defaultdict(float))
    for r in rows:
        if r["cpu"] is not None:
            per_t[int(r["t"])][r["role"]] += r["cpu"]
            if r["role"] == "webview":
                per_t[int(r["t"])]["webview_main"] = max(per_t[int(r["t"])]["webview_main"], r["main_cpu"] or 0.0)
    hot = sorted(t for t, v in per_t.items()
                 if v.get("sidecar", 0) >= 150 or v.get("webview", 0) >= 100 or v.get("webview_main", 0) >= 90)
    episodes = []
    for t in hot:
        if episodes and t - episodes[-1][1] <= 2:
            episodes[-1][1] = t
        else:
            episodes.append([t, t])
    def phase_at(t):
        return next((p[0] for p in phases if p[1] <= t <= p[2]), "-")
    scored = []
    for a, b in episodes:
        secs = range(a, b + 1)
        total = sum(sum(v for k, v in per_t[t].items() if k != "webview_main") for t in secs)
        scored.append((total, a, b))
    lines = ["\n== CPU spikes: the busiest moments (a second with the sidecar >= 150%, or the window >= 100% or",
             "   its main thread >= 90%), with the screen, the sidecar's threads and what the app logged then"]
    if not scored:
        lines.append("none")
        return lines
    for total, a, b in sorted(scored, reverse=True)[:12]:
        secs = range(a, b + 1)
        n = len(secs)
        avg = lambda role: sum(per_t[t].get(role, 0) for t in secs) / n
        peak = lambda role: max(per_t[t].get(role, 0) for t in secs)
        screens = list(dict.fromkeys(phase_at(t) for t in secs))
        threads = defaultdict(float)
        for _, at, used in thread_ticks:
            if a < at <= b + 1:
                for name, v in used.items():
                    threads[name] += v
        top = sorted(threads.items(), key=lambda kv: -kv[1])[:4]
        lines.append(f"\n{a:5d}-{b:<5d}s ({n} s) on {', '.join(screens)}: "
                     f"sidecar {avg('sidecar'):.0f}% (peak {peak('sidecar'):.0f}%), "
                     f"window {avg('webview'):.0f}% (main peak {peak('webview_main'):.0f}%), host {avg('host'):.0f}%")
        shown = [f"{name}={v:.1f}s" for name, v in top if v >= 0.05]
        if shown:
            lines.append("   sidecar threads: " + ", ".join(shown))
        near = [text for at, until, text in events if at <= b + 2 and until >= a - 2]
        for text in near[:8]:
            lines.append(f"   {text}")
        if len(near) > 8:
            lines.append(f"   ... {len(near) - 8} more")
    return lines


def screens_summary(rows, phases):
    """CPU and time per screen, all its visits together (people, people#2, ... as one)."""
    base = lambda name: name.split("#")[0]
    seconds = defaultdict(float)
    for name, a, b, _ in phases:
        seconds[base(name)] += b - a
    cpu = defaultdict(lambda: defaultdict(float))   # screen -> role -> cpu-seconds
    for r in rows:
        if r["cpu"] is not None:
            cpu[base(r["phase"])][r["role"]] += r["cpu"] / 100
    lines = ["\n== CPU by screen, all visits together (cpu-seconds; 1 = one core for one second)",
             f"{'screen':20} {'time':>7} {'sidecar':>8} {'window':>8} {'host':>8} {'network':>8}"]
    for name in sorted(seconds, key=lambda n: -sum(cpu[n].values())):
        c = cpu[name]
        lines.append(f"{name:20} {seconds[name]:6.0f}s {c.get('sidecar', 0):8.1f} {c.get('webview', 0):8.1f} "
                     f"{c.get('host', 0):8.1f} {c.get('webkit-network', 0):8.1f}")
    return lines


def fields_of(text):
    """`name=value` fields of a line: numbers as ints, anything else as it is."""
    out = {}
    for part in text.split():
        name, _, value = part.partition("=")
        try:
            out[name] = int(value)
        except ValueError:
            out[name] = value
    return out


def read(path, binary=False):
    try:
        with open(path, "rb" if binary else "r") as f:
            return f.read()
    except OSError:
        return None


def parse_stat(text):
    """Fields of /proc/<pid>/stat; the name may hold spaces and brackets."""
    close = text.rfind(")")
    comm = text[text.find("(") + 1:close]
    rest = text[close + 2:].split()
    # rest[0] is field 3 (state); utime=14, stime=15, threads=20, ppid=4
    return comm, int(rest[1]), int(rest[11]) + int(rest[12]), int(rest[17])


def role_of(comm, cmdline):
    c = comm.lower()
    if c.startswith("webkitwebproc"):
        return "webview"
    if c.startswith("webkitnetwork"):
        return "webkit-network"
    if c.startswith("webkitgpu"):
        return "webkit-gpu"
    if c.startswith("photosforproton"):
        return "host"
    args = cmdline.split("\0") if cmdline else []
    base0 = os.path.basename(args[0]).lower() if args else ""
    if c == "node" or base0.startswith("node") or any(
        a.endswith((".mjs", ".cjs", ".js")) or "sidecar" in a.lower() for a in args[1:3]
    ):
        return "sidecar"
    return "other:" + comm


class Sampler(threading.Thread):
    def __init__(self, app_id, match):
        super().__init__(daemon=True)
        self.app_id, self.match = app_id, match
        self.phase = "before"
        self.stop_flag = False
        self.t0 = time.monotonic()
        self.rows = []          # one row per process per second
        self.prev = {}          # pid -> (ticks, main_ticks, time)
        self.prev_threads = {}  # (pid, tid) -> ticks
        self.thread_cpu = defaultdict(lambda: defaultdict(float))  # phase -> thread name -> cpu s
        self.thread_ticks = []  # (t, {sidecar thread name: cpu s}) per sample, for the spikes
        self.roles = {}
        self.tick = 0

    def find_pids(self):
        found, ppid_of, comm_of = set(), {}, {}
        for name in os.listdir("/proc"):
            if not name.isdigit():
                continue
            pid = int(name)
            st = read(f"/proc/{pid}/stat")
            if not st:
                continue
            try:
                comm, ppid, _, _ = parse_stat(st)
            except (ValueError, IndexError):
                continue
            ppid_of[pid], comm_of[pid] = ppid, comm
            if self.match:
                if self.match in comm:
                    found.add(pid)
                continue
            cg = read(f"/proc/{pid}/cgroup") or ""
            if self.app_id in cg or comm.startswith("photosforproton"):
                found.add(pid)
        # children of anything found (covers systems without per-app cgroups)
        changed = True
        while changed:
            changed = False
            for pid, ppid in ppid_of.items():
                if ppid in found and pid not in found:
                    found.add(pid)
                    changed = True
        found.discard(os.getpid())
        return found

    def sample(self, pids):
        now = time.monotonic()
        for pid in pids:
            st = read(f"/proc/{pid}/stat")
            if not st:
                continue
            try:
                comm, _, ticks, threads = parse_stat(st)
            except (ValueError, IndexError):
                continue
            if pid not in self.roles:
                self.roles[pid] = role_of(comm, read(f"/proc/{pid}/cmdline") or "")
            role = self.roles[pid]
            if role.startswith("other:") and role[6:] in ("bwrap", "xdg-dbus-proxy", "sh", "bash"):
                continue
            main = read(f"/proc/{pid}/task/{pid}/stat")
            try:
                main_ticks = parse_stat(main)[2] if main else 0
            except (ValueError, IndexError):
                main_ticks = 0
            statm = read(f"/proc/{pid}/statm")
            rss_mb = int(statm.split()[1]) * PAGE / 1048576 if statm else 0.0
            pss_mb = None
            if self.tick % 5 == 0:
                roll = read(f"/proc/{pid}/smaps_rollup")
                if roll:
                    m = re.search(r"^Pss:\s+(\d+) kB", roll, re.M)
                    if m:
                        pss_mb = int(m.group(1)) / 1024
            rd = wr = None
            io = read(f"/proc/{pid}/io")
            if io:
                m1 = re.search(r"^read_bytes: (\d+)", io, re.M)
                m2 = re.search(r"^write_bytes: (\d+)", io, re.M)
                if m1 and m2:
                    rd, wr = int(m1.group(1)) / 1048576, int(m2.group(1)) / 1048576
            cpu = main_cpu = None
            if pid in self.prev:
                pt, pm, ptime = self.prev[pid]
                dt = max(now - ptime, 1e-6)
                cpu = (ticks - pt) / CLK / dt * 100
                main_cpu = (main_ticks - pm) / CLK / dt * 100
            self.prev[pid] = (ticks, main_ticks, now)
            if role == "sidecar":
                self.sample_threads(pid)
            self.rows.append({
                "t": round(now - self.t0, 2), "phase": self.phase, "role": role, "pid": pid,
                "cpu": None if cpu is None else round(cpu, 1),
                "main_cpu": None if main_cpu is None else round(main_cpu, 1),
                "rss_mb": round(rss_mb, 1),
                "pss_mb": None if pss_mb is None else round(pss_mb, 1),
                "threads": threads,
                "read_mb": None if rd is None else round(rd, 1),
                "write_mb": None if wr is None else round(wr, 1),
            })

    def sample_threads(self, pid):
        try:
            tids = os.listdir(f"/proc/{pid}/task")
        except OSError:
            return
        for tid in tids:
            st = read(f"/proc/{pid}/task/{tid}/stat")
            if not st:
                continue
            try:
                comm, _, ticks, _ = parse_stat(st)
            except (ValueError, IndexError):
                continue
            name = "MAIN(" + comm + ")" if tid == str(pid) else re.sub(r"[-#:]?\d+$", "", comm)
            key = (pid, tid)
            if key in self.prev_threads:
                used = (ticks - self.prev_threads[key]) / CLK
                self.thread_cpu[self.phase][name] += used
                if used > 0:
                    if not self.thread_ticks or self.thread_ticks[-1][0] != self.tick:
                        self.thread_ticks.append((self.tick, round(time.monotonic() - self.t0, 2), defaultdict(float)))
                    self.thread_ticks[-1][2][name] += used
            self.prev_threads[key] = ticks

    def run(self):
        pids = set()
        while not self.stop_flag:
            start = time.monotonic()
            if self.tick % 2 == 0:
                pids = self.find_pids()
            self.sample(pids)
            self.tick += 1
            time.sleep(max(0.0, 1.0 - (time.monotonic() - start)))


def find_log(app_id):
    home = os.path.expanduser("~")
    roots = [os.path.join(home, ".var", "app", app_id), os.path.join(home, ".local", "share")]
    hits = []
    for root in roots:
        for dirpath, dirnames, filenames in os.walk(root):
            if dirpath.count(os.sep) - root.count(os.sep) > 4:
                dirnames[:] = []
                continue
            if "sidecar.log" in filenames and ("akoos" in dirpath or app_id in dirpath):
                hits.append(os.path.join(dirpath, "sidecar.log"))
    hits.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    return hits[0] if hits else None


def system_info(app_id):
    info = {"kernel": platform.release(), "arch": platform.machine(), "cores": os.cpu_count()}
    cpu = read("/proc/cpuinfo") or ""
    m = re.search(r"^model name\s*:\s*(.+)$", cpu, re.M)
    info["cpu"] = m.group(1).strip() if m else "?"
    mem = read("/proc/meminfo") or ""
    m = re.search(r"^MemTotal:\s+(\d+) kB", mem, re.M)
    info["ram_gb"] = round(int(m.group(1)) / 1048576, 1) if m else None
    m = re.search(r"^SwapTotal:\s+(\d+) kB", mem, re.M)
    info["swap_gb"] = round(int(m.group(1)) / 1048576, 1) if m else None
    osr = read("/etc/os-release") or ""
    m = re.search(r'^PRETTY_NAME="?([^"\n]+)', osr, re.M)
    info["distro"] = m.group(1) if m else "?"
    info["session"] = os.environ.get("XDG_SESSION_TYPE", "?")
    info["desktop"] = os.environ.get("XDG_CURRENT_DESKTOP", "?")
    try:
        out = subprocess.run(["flatpak", "info", app_id], capture_output=True, text=True, timeout=10).stdout
        for key in ("Version", "Runtime", "Branch", "Installed"):
            m = re.search(rf"^\s*{key}:\s*(.+)$", out, re.M)
            if m:
                info["flatpak_" + key.lower()] = m.group(1).strip()
    except (OSError, subprocess.SubprocessError):
        info["flatpak_version"] = "flatpak info failed"
    return info


def summarise(rows, phases):
    lines = []
    by = defaultdict(list)
    for r in rows:
        by[(r["phase"], r["role"])].append(r)
    for name, start, end, skipped in phases:
        if skipped:
            lines.append(f"\n== {name}: skipped")
            continue
        lines.append(f"\n== {name}  ({end - start:.0f} s)")
        lines.append(f"{'process':16} {'cpu avg':>8} {'cpu max':>8} {'main avg':>9} {'main>=90%':>10} "
                     f"{'rss start':>10} {'rss end':>8} {'rss peak':>9} {'pss peak':>9} {'thr':>4} {'read':>7} {'write':>7}")
        total_peak = defaultdict(float)
        for (phase, role), rs in sorted(by.items()):
            if phase != name:
                continue
            # several processes can share a role (WebKit): add them up per second
            per_t = defaultdict(lambda: {"cpu": 0.0, "main": 0.0, "rss": 0.0, "thr": 0, "has": False})
            for r in rs:
                slot = per_t[int(r["t"])]
                slot["rss"] += r["rss_mb"]
                slot["thr"] += r["threads"]
                if r["cpu"] is not None:
                    slot["cpu"] += r["cpu"]
                    slot["main"] = max(slot["main"], r["main_cpu"] or 0.0)
                    slot["has"] = True
            ts = sorted(per_t)
            cpus = [per_t[t]["cpu"] for t in ts if per_t[t]["has"]] or [0.0]
            mains = [per_t[t]["main"] for t in ts if per_t[t]["has"]] or [0.0]
            rss = [per_t[t]["rss"] for t in ts]
            for t in ts:
                total_peak[t] += per_t[t]["rss"]
            pss_by_pid = defaultdict(float)
            for r in rs:
                if r["pss_mb"] is not None:
                    pss_by_pid[r["pid"]] = max(pss_by_pid[r["pid"]], r["pss_mb"])
            io = defaultdict(lambda: [None, None, None, None])
            for r in rs:
                if r["read_mb"] is None:
                    continue
                slot = io[r["pid"]]
                if slot[0] is None:
                    slot[0], slot[2] = r["read_mb"], r["write_mb"]
                slot[1], slot[3] = r["read_mb"], r["write_mb"]
            rd = sum(v[1] - v[0] for v in io.values() if v[0] is not None)
            wr = sum(v[3] - v[2] for v in io.values() if v[2] is not None)
            lines.append(
                f"{role[:16]:16} {sum(cpus) / len(cpus):7.0f}% {max(cpus):7.0f}% {sum(mains) / len(mains):8.0f}% "
                f"{sum(1 for m in mains if m >= 90):8d} s {rss[0]:8.0f} M {rss[-1]:6.0f} M {max(rss):7.0f} M "
                f"{sum(pss_by_pid.values()):7.0f} M {max(per_t[t]['thr'] for t in ts):4d} {rd:5.0f} M {wr:5.0f} M")
        if total_peak:
            lines.append(f"{'ALL (rss peak)':16} {max(total_peak.values()):.0f} M")
    return lines


def main():
    ap = argparse.ArgumentParser(description="Profile Photos for Proton desktop from /proc")
    ap.add_argument("--app-id", default="eu.akoos.photos")
    ap.add_argument("--idle", type=int)
    ap.add_argument("--ask", action="store_true",
                    help="ask about the library, the build and what feels slow, for the record")
    ap.add_argument("--people", action="store_true",
                    help="the same as --watch: follow the app's screens by themselves, no questions")
    ap.add_argument("--watch", action="store_true",
                    help="no steps or questions: follow the screens the app shows until it is closed, "
                         "and report the busiest moments")
    ap.add_argument("--log", help=argparse.SUPPRESS)         # testing: the app log to read
    ap.add_argument("--match", help=argparse.SUPPRESS)       # testing: match processes by name
    ap.add_argument("--auto", type=int, help=argparse.SUPPRESS)  # testing: seconds per step, no prompts
    args = ap.parse_args()
    if args.idle is None:
        args.idle = 30
    watch = args.watch or args.people
    steps = [] if watch else STEPS

    if not sys.platform.startswith("linux"):
        sys.exit("This script reads /proc and only works on Linux.")

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    out_dir = os.path.abspath(f"pfp-profile-{stamp}")
    os.makedirs(out_dir)

    sampler = Sampler(args.app_id, args.match)
    already_running = bool(sampler.find_pids())
    if not args.auto and already_running and not watch:
        print("The app seems to be running. Quit it completely first (its Quit), then run this again.")
        os.rmdir(out_dir)
        sys.exit(1)

    answers = {}
    if not args.auto:
        print(f"Photos for Proton desktop profiler. {'As long as you like' if watch else 'About 10 minutes'}. "
              "Nothing personal is recorded.\n")
    # The questions about the library are asked only with --ask: the measurement itself says
    # what they used to, and a run that repeats one before is quicker without them.
    if args.ask and not args.auto:
        answers["photo_count"] = input("Roughly how many photos are in the library? ").strip()
        answers["background_work"] = input(
            "Was a face scan / search indexing still running last time you used the app? (y/n/unknown) ").strip()
        answers["start_screen"] = input("Which screen does the app open on? (Photos/Albums/People/other) ").strip()
        answers["build"] = input("Which build is installed? (official / patched) ").strip()
        answers["notes"] = input("Anything that feels especially slow? (free text, optional) ").strip()

    log_path = args.log or find_log(args.app_id)
    log_offset = os.path.getsize(log_path) if log_path else 0
    # One instant for both clocks, so the app's log lines land in the right step.
    sampler.t0 = time.monotonic()
    utc_start = datetime.now(timezone.utc)

    sampler.start()
    phases = []
    for name, text in steps:
        if args.auto:
            sampler.phase = name
            t = time.monotonic() - sampler.t0
            time.sleep(args.auto)
            phases.append((name, t, time.monotonic() - sampler.t0, False))
            continue
        print(f"\n--- Step: {name}\n   {text}")
        if name == "launch":
            input("   [Enter, then start the app] ")
        sampler.phase = name
        t = time.monotonic() - sampler.t0
        reply = input("   [Enter when done] ").strip().lower()
        phases.append((name, t, time.monotonic() - sampler.t0, reply == "s"))
    rotated, ended = False, None
    if watch:
        phases, rotated, ended, log_path = follow_screens(
            sampler, log_path, log_offset, args.auto or 20 * 60, args.app_id, already_running)
    else:
        idle = args.auto or args.idle
        print(f"\n--- Step: idle\n   Do not touch the app for {idle} seconds (shows whether memory is given back).")
        sampler.phase = "idle"
        t = time.monotonic() - sampler.t0
        for left in range(idle, 0, -1):
            print(f"\r   {left:4d} s left ", end="", flush=True)
            time.sleep(1)
        print()
        phases.append(("idle", t, time.monotonic() - sampler.t0, False))
    if not phases:
        phases = [("run", 0.0, time.monotonic() - sampler.t0, False)]
    sampler.stop_flag = True
    # The recording is not to be lost to a second Ctrl+C while it is written out.
    import signal
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    sampler.join(timeout=5)
    utc_end = datetime.now(timezone.utc)
    rows = list(sampler.rows)
    thread_ticks = [(n, at, dict(used)) for n, at, used in list(sampler.thread_ticks)]
    cols = ["t", "phase", "role", "pid", "cpu", "main_cpu", "rss_mb", "pss_mb", "threads", "read_mb", "write_mb"]
    with open(os.path.join(out_dir, "samples.csv"), "w") as f:
        f.write(",".join(cols) + "\n")
        for r in rows:
            f.write(",".join("" if r[c] is None else str(r[c]) for c in cols) + "\n")

    # the app's own slow-call log, rpc timing lines only
    rpc_lines, other_tags = [], defaultdict(int)
    by_method = defaultdict(list)
    stuck_lines, slot_lines = [], []
    stuck_by = defaultdict(lambda: defaultdict(int))   # phase -> "method lane state" -> worst ms
    slots_by = defaultdict(lambda: [0, 0])             # phase -> [most in use, oldest ms]
    thumbs_by = defaultdict(lambda: [0, 0, 0, 0, 0, 0])  # phase -> [max open, oldest ms, served, missing, failed, dropped]
    thumb_lines = []

    def when(h, mi, s):
        sec = (int(h) * 3600 + int(mi) * 60 + int(s)
               - (utc_start.hour * 3600 + utc_start.minute * 60 + utc_start.second)) % 86400
        phase = next((p[0] for p in phases if p[1] <= sec <= p[2]),
                     min(phases, key=lambda p: min(abs(sec - p[1]), abs(sec - p[2])))[0])
        return sec, phase
    events = []   # (second into the run, what the app logged), for the spikes
    local_start = utc_start.astimezone()
    step_lines = []
    pass_lines = []
    pass_open = None   # [start, latest, text] of a face scan pass not yet ended
    batches = 0
    step_by = defaultdict(lambda: defaultdict(lambda: [0, 0, 0]))   # phase -> step -> [n, sum ms, max ms]

    def when_step(h, mi, s, ms):
        """When a step began (its line is written at its end), in seconds into the run, and the
        run's step it fell in. The sidecar stamps it in its own zone, which inside the sandbox
        may be UTC rather than this machine's: whichever reading lands inside the run is taken;
        None when neither does."""
        at = int(h) * 3600 + int(mi) * 60 + int(s) - ms / 1000
        end = phases[-1][2] + 5 if phases else 0
        for start in (local_start, utc_start):
            sec = (at - (start.hour * 3600 + start.minute * 60 + start.second)) % 86400
            if -5 <= sec <= end or sec >= 86400 - 5:
                sec = sec - 86400 if sec > 43200 else sec
                phase = next((p[0] for p in phases if p[1] <= sec <= p[2]),
                             min(phases, key=lambda p: min(abs(sec - p[1]), abs(sec - p[2])))[0])
                return int(sec), phase
        return None
    # The log as written during the run: after a rotation, the older file's part and then the
    # whole of the new one.
    log_sources = []
    if log_path and os.path.exists(log_path):
        if rotated:
            if os.path.exists(log_path + ".1"):
                log_sources.append((log_path + ".1", log_offset))
            log_sources.append((log_path, 0))
        else:
            log_sources.append((log_path, log_offset if os.path.getsize(log_path) >= log_offset else 0))
    for src_path, start_at in log_sources:
        with open(src_path, "r", errors="replace") as f:
            f.seek(start_at)
            for line in f:
                m = RPC_LINE.match(line)
                if m:
                    h, mi, s, method, wait, hold = m.groups()
                    sec = (int(h) * 3600 + int(mi) * 60 + int(s)
                           - (utc_start.hour * 3600 + utc_start.minute * 60 + utc_start.second)) % 86400
                    phase = next((p[0] for p in phases if p[1] <= sec <= p[2]),
                                 min(phases, key=lambda p: min(abs(sec - p[1]), abs(sec - p[2])))[0])
                    by_method[method].append((int(wait), int(hold)))
                    events.append((sec - int(hold) / 1000, sec, f"call {method} wait={int(wait)} ms hold={int(hold)} ms"))
                    rpc_lines.append(f"{h}:{mi}:{s} +{sec:4d}s {phase:16} {method:28} wait={int(wait):7d} ms hold={int(hold):7d} ms")
                    continue
                m = PASS_LINE.match(line)
                if m:
                    h, mi, s, kind, fields = m.groups()
                    wall = fields_of(fields).get("wall", 0) if kind == "scan_batch" else 0
                    placed = when_step(h, mi, s, wall if isinstance(wall, int) else 0)
                    if placed is None:
                        continue
                    sec, phase = placed
                    if kind == "scan_batch":
                        # Many a pass: counted, and kept as the span of the pass's reading.
                        batches += 1
                        if pass_open is not None:
                            pass_open[1] = max(pass_open[1], sec + (wall if isinstance(wall, int) else 0) / 1000)
                        continue
                    text = f"face scan {kind}{fields}"
                    pass_lines.append(f"{h}:{mi}:{s} +{sec:4d}s {phase:16} {text}")
                    if kind == "pass_start":
                        pass_open = [sec, sec, text]
                    elif pass_open is not None:
                        # The pass as one span, start to end, so a spike in its middle names it.
                        events.append((pass_open[0], sec, pass_open[2] + " ... " + text))
                        pass_open = None
                    else:
                        events.append((sec, sec, text))
                    continue
                m = STEP_LINE.match(line)
                if m:
                    h, mi, s, step, ms = m.groups()
                    placed = when_step(h, mi, s, int(ms))
                    if placed is None:
                        continue
                    sec, phase = placed
                    agg = step_by[phase][step]
                    agg[0] += 1
                    agg[1] += int(ms)
                    agg[2] = max(agg[2], int(ms))
                    step_lines.append(f"{h}:{mi}:{s} +{sec:4d}s {phase:16} {step:20} {int(ms):7d} ms")
                    events.append((sec, sec + int(ms) / 1000, f"sidecar step {step} {int(ms)} ms"))
                    continue
                m = STUCK_LINE.match(line)
                if m:
                    h, mi, s, method, lane, waiting, running, waited = m.groups()
                    sec, phase = when(h, mi, s)
                    state, ms = ("waiting", int(waiting)) if waiting else ("running", int(running))
                    key = f"{method} {lane} {state}"
                    stuck_by[phase][key] = max(stuck_by[phase][key], ms)
                    extra = f" waited={int(waited):7d} ms" if waited else ""
                    stuck_lines.append(f"{h}:{mi}:{s} +{sec:4d}s {phase:16} {method:28} {lane} {state}={ms:7d} ms{extra}")
                    events.append((sec - ms / 1000, sec, f"call {method} still {state} after {ms} ms"))
                    continue
                m = QUEUE_LINE.match(line)
                if m:
                    h, mi, s, rest = m.groups()
                    sec, phase = when(h, mi, s)
                    stuck_lines.append(f"{h}:{mi}:{s} +{sec:4d}s {phase:16} queue {rest}")
                    continue
                m = THUMBS_LINE.match(line)
                if m:
                    h, mi, s, *nums = m.groups()
                    sec, phase = when(h, mi, s)
                    o, oldest, served, missing, failed, dropped = map(int, nums)
                    t = thumbs_by[phase]
                    t[0], t[1] = max(t[0], o), max(t[1], oldest)
                    t[2] += served; t[3] += missing; t[4] += failed; t[5] += dropped
                    thumb_lines.append(f"{h}:{mi}:{s} +{sec:4d}s {phase:16} open={o} oldest={oldest // 1000} s "
                                       f"served={served} missing={missing} failed={failed} dropped={dropped}")
                    continue
                m = SLOTS_LINE.match(line)
                if m:
                    h, mi, s, in_use, oldest = m.groups()
                    sec, phase = when(h, mi, s)
                    slots_by[phase][0] = max(slots_by[phase][0], int(in_use))
                    slots_by[phase][1] = max(slots_by[phase][1], int(oldest))
                    slot_lines.append(f"{h}:{mi}:{s} +{sec:4d}s {phase:16} in_use={in_use} oldest={int(oldest) // 1000} s")
                    continue
                m = OTHER_TAG.match(line)
                other_tags[(m.group(1) + "/" + m.group(2)) if m else "untagged"] += 1


    summary = ["Photos for Proton desktop profile", f"UTC {utc_start:%Y-%m-%d %H:%M:%S} to {utc_end:%H:%M:%S}", ""]
    summary.append("cpu = percent of ONE core. main = the process's main thread. rss/pss in MB.")
    summary.append("'main>=90%' = seconds the main thread was pinned, i.e. could do nothing else.")
    # A pass still under way when the run ended spans to the end of the run.
    if pass_open is not None:
        run_end = phases[-1][2] if phases else pass_open[1]
        events.append((pass_open[0], max(pass_open[1], run_end), pass_open[2] + " ... (still under way at the end)"))
    events.sort()
    try:
        summary += spikes_summary(rows, thread_ticks, phases, events)
        summary += screens_summary(rows, phases)
    except Exception as e:  # the rest of the report still goes out
        summary.append(f"\n(spikes could not be summarised: {type(e).__name__})")
    summary += summarise(rows, phases)
    summary.append("\n== Node sidecar: CPU seconds by thread, per step")
    for name, _, _, skipped in phases:
        threads = sampler.thread_cpu.get(name)
        if skipped or not threads:
            continue
        top = sorted(threads.items(), key=lambda kv: -kv[1])[:6]
        summary.append(f"{name:16} " + ", ".join(f"{n}={v:.1f}s" for n, v in top if v >= 0.05))
    summary.append("\n== Slow calls by method (the app logs only calls that waited or ran >= 1 s)")
    summary.append(f"{'method':28} {'n':>5} {'wait med':>9} {'wait max':>9} {'hold med':>9} {'hold max':>9} {'hold sum':>9}")
    for method, v in sorted(by_method.items(), key=lambda kv: -len(kv[1])):
        w = sorted(x[0] for x in v)
        h = sorted(x[1] for x in v)
        summary.append(f"{method[:28]:28} {len(v):5d} {w[len(w) // 2]:7d}ms {w[-1]:7d}ms "
                       f"{h[len(h) // 2]:7d}ms {h[-1]:7d}ms {sum(h) / 1000:7.1f} s")
    end_t = phases[-1][2]
    last_seen = {}
    for r in rows:
        last_seen[(r["role"], r["pid"])] = r["t"]
    gone = [(role, t) for (role, _), t in last_seen.items() if t < end_t - 3]
    if gone and ended != "quit":
        summary.append("\n== Processes that ended during the run")
        for role, t in sorted(gone, key=lambda x: x[1]):
            phase = next((p[0] for p in phases if p[1] <= t <= p[2]), "?")
            summary.append(f"{role:16} last seen at {t:.0f} s (step: {phase})")
    summary.append("\n== Calls stuck, named by the app's watchdog while stuck (worst per step)")
    if not stuck_by:
        summary.append("none (or this build has no watchdog)")
    for name, _, _, _ in phases:
        for key, ms in sorted(stuck_by.get(name, {}).items(), key=lambda kv: -kv[1])[:10]:
            summary.append(f"{name:16} {key:40} {ms / 1000:7.1f} s")
    summary.append("\n== Proton download slots held (of 5), most and oldest per step")
    if not slots_by:
        summary.append("none held (or this build does not log them)")
    for name, _, _, _ in phases:
        if name in slots_by:
            most, oldest = slots_by[name]
            summary.append(f"{name:16} in_use max={most}  oldest={oldest / 1000:.0f} s")
    summary.append("\n== Thumbnail server (pictures only): most open, oldest, and totals per step")
    if not thumbs_by:
        summary.append("no lines (or this build does not log them)")
    for name, _, _, _ in phases:
        if name in thumbs_by:
            o, oldest, served, missing, failed, dropped = thumbs_by[name]
            summary.append(f"{name:16} open max={o:4d}  oldest={oldest / 1000:5.1f} s  served={served}  "
                           f"missing={missing}  failed={failed}  dropped={dropped}")
    summary.append("\n== Sidecar work after unlock (faces, search, Explorer folder), per step of the run: steps of 3 s"
                   " or more, or every one with Settings > Diagnostics > Detailed logging on")
    if not step_by:
        summary.append("none slow (turn on detailed logging for every step)")
    for name, _, _, _ in phases:
        if name in step_by:
            parts = sorted(step_by[name].items(), key=lambda kv: -kv[1][1])
            summary.append(f"{name:16} " + ", ".join(
                f"{step}={total / 1000:.1f}s" + (f" ({n}x, max {most / 1000:.1f}s)" if n > 1 else "")
                for step, (n, total, most) in parts))
    summary.append("\n== Face scan passes (photos in the library, still to read, faces): reading photos is image work")
    summary += pass_lines[:200] or ["none matched (no pass had photos to read, or none was logged)"]
    if batches:
        summary.append(f"({batches} batches of photos read in all)")
    summary.append(f"\n== Slow calls logged by the app (>= 1 s): {len(rpc_lines)}")
    summary += rpc_lines[:400]
    if not log_path:
        summary.append("(sidecar.log was not found)")
    with open(os.path.join(out_dir, "summary.txt"), "w") as f:
        f.write("\n".join(summary) + "\n")
    with open(os.path.join(out_dir, "rpc_slow.txt"), "w") as f:
        f.write("\n".join(rpc_lines) + "\n")
    with open(os.path.join(out_dir, "rpc_stuck.txt"), "w") as f:
        f.write("\n".join(stuck_lines) + "\n")
    with open(os.path.join(out_dir, "slots.txt"), "w") as f:
        f.write("\n".join(slot_lines) + "\n")
    with open(os.path.join(out_dir, "thumbs.txt"), "w") as f:
        f.write("\n".join(thumb_lines) + "\n")
    with open(os.path.join(out_dir, "steps.txt"), "w") as f:
        f.write("\n".join(step_lines) + "\n")
    with open(os.path.join(out_dir, "meta.json"), "w") as f:
        json.dump({
            "system": system_info(args.app_id),
            "answers": answers,
            "phases": [{"name": n, "start": round(a, 1), "end": round(b, 1), "skipped": s} for n, a, b, s in phases],
            "processes_seen": sorted(set(sampler.roles.values())),
            "log_found": bool(log_path),
            "other_log_lines_by_tag": dict(other_tags),
        }, f, indent=2)

    archive = out_dir + ".tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        tar.add(out_dir, arcname=os.path.basename(out_dir))

    print("\n".join(summary[:60]))
    seen = sorted(set(sampler.roles.values()))
    if not any(r in ("host", "sidecar", "webview") for r in seen):
        print("\nWARNING: no app processes were found. Was the app started during the run?")
    elif "webview" not in seen:
        print("\nNote: the WebKit web process was not matched; the window's own CPU/memory is missing.")
    print(f"\nDone. Upload this file:\n  {archive}")


if __name__ == "__main__":
    main()
