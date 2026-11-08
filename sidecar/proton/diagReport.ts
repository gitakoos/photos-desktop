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

// The diagnostics report: how this computer and each part of the app stand, read when it is
// asked for, ahead of what the diagnostics kept; and the watch that keeps them. Counts, states
// and sizes only, as everything in the diagnostics.

import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { arch, cpus, freemem, release, totalmem } from "node:os";
import { extname, isAbsolute, join } from "node:path";

import { scrubSecrets } from "../scrub.ts";
import { diag } from "./diag.ts";
import { faceScanner } from "./faceScan.ts";
import { labelList, labelStore } from "./labelStore.ts";
import { isReady, storeDir } from "./store.ts";
import type { BackupStatus } from "./sharedBackup.ts";
import { getUploadStatus } from "./upload.ts";

/** How often the watchdog looks, and how often memory is noted. */
const LOOK_MS = 30_000;
const MEMORY_MS = 60_000;
/** Memory is noted again only when it moved this much, or after this long. */
const MEMORY_STEP = 0.1;
const MEMORY_HEARTBEAT_MS = 10 * 60_000;
/** The log's last lines in a report. */
const LOG_TAIL = 300;

const mb = (bytes: number) => Math.round(bytes / (1024 * 1024));

/** Text the window adds to the header, kept to plain words, numbers and marks. */
function plain(line: unknown): string {
  return String(line ?? "")
    .replace(/[^A-Za-z0-9 .:,=_()/+-]/g, "_")
    .slice(0, 200);
}

/** Where the shared backup's state is read from, handed in by the server. */
let backupStatus: () => BackupStatus | null = () => null;

/**
 * Puts the long-running work under the watchdog, and starts it and the memory notes.
 * `backup` reads how the shared backup stands, for the report.
 */
export function watchJobs(backup: () => BackupStatus): void {
  backupStatus = backup;
  diag.watch("face_scan", {
    active: () => ["models", "scanning", "finding", "grouping"].includes(faceScanner.getStatus().state),
    progress: () => {
      const s = faceScanner.getStatus();
      return s.done + (s.search ? s.search.indexed + s.search.unreadable : 0) + (s.download?.done ?? 0);
    },
  });
  diag.watch("upload", {
    active: () => getUploadStatus().running,
    progress: () => {
      const s = getUploadStatus();
      return s.done + s.skipped + s.failed + s.items.reduce((sum, it) => sum + (it.sent ?? 0), 0);
    },
  });
  diag.watch("import_download", {
    active: () => getUploadStatus().importing?.phase === "downloading" || getUploadStatus().importing?.phase === "unpacking",
    progress: () => getUploadStatus().importing?.done ?? 0,
  });
  setInterval(() => diag.checkStalls(), LOOK_MS).unref();

  let noted = { heap: 0, at: 0 };
  setInterval(() => {
    const m = process.memoryUsage();
    const now = Date.now();
    const moved = noted.heap === 0 || Math.abs(m.heapUsed - noted.heap) / noted.heap >= MEMORY_STEP;
    if (!moved && now - noted.at < MEMORY_HEARTBEAT_MS) return;
    noted = { heap: m.heapUsed, at: now };
    diag.log("perf", "memory", { heap_mb: mb(m.heapUsed), rss_mb: mb(m.rss), external_mb: mb(m.external) });
  }, MEMORY_MS).unref();
  diag.log("app", "start", { node: process.versions.node });
}

/** How this computer and each part of the app stand right now, a line each. */
function stateLines(header: unknown[]): string[] {
  const lines = header.map(plain);
  const m = process.memoryUsage();
  lines.push(
    `Windows ${plain(release())} ${plain(arch())}, ${cpus().length} cores, ${mb(totalmem())} MB memory, ${mb(freemem())} MB free`,
    `Sidecar: up ${Math.round((Date.now() - diag.startedAt) / 60_000)} min, heap ${mb(m.heapUsed)} MB, rss ${mb(m.rss)} MB, detailed logging ${diag.isDetailed() ? "on" : "off"}`,
  );
  const f = faceScanner.getStatus();
  lines.push(
    `Faces: ${f.state}, ${f.done} of ${f.total} photos, ${f.faces} faces, on ${f.accel ?? "-"}` +
      (f.search ? `; search index ${f.search.indexed} indexed, ${f.search.unreadable} unreadable, of ${f.search.total}` : ""),
  );
  const b = backupStatus();
  const ago = (at?: number | null) => (at ? `${Math.round((Date.now() - at) / 60_000)} min ago` : "never");
  lines.push(
    b
      ? `Shared backup: ${b.on ? "on" : "off"}, ${b.running ? "running" : "idle"}, last round ${ago(b.lastAt)}${b.failed ? ", failed" : ""}; ` +
          `saved faces ${ago(b.saved.faces)}, labels ${ago(b.saved.labels)}, search ${ago(b.saved.search)}`
      : "Shared backup: off",
  );
  if (isReady()) {
    try {
      const labels = labelList(labelStore.get());
      lines.push(`Labels: ${labels.length} labels on ${Object.keys(labelStore.get().photos).length} photos`);
    } catch {
      /* not readable now: left out */
    }
  }
  const u = getUploadStatus();
  lines.push(
    `Uploads: ${u.running ? "running" : "idle"}, ${u.done} done, ${u.skipped} already there, ${u.failed} failed, of ${u.total}` +
      (u.importing ? `; import ${u.importing.phase} ${u.importing.part}/${u.importing.parts}` : "") +
      (u.moveResult ? `; last move ${u.moveResult.moved} moved, ${u.moveResult.kept} kept` : ""),
  );
  return lines;
}

/**
 * A log line as a report may carry it: paths and anything named like a file taken out. A
 * Windows path may hold spaces, so it is taken to the end of the line or the next quote.
 */
export function withoutNames(line: string): string {
  return scrubSecrets(line)
    .replace(/[A-Za-z]:[\\/][^"'<>|\r\n]*/g, "[path]")
    .replace(/(?:\/[^\s"'<>|/]+){2,}/g, "[path]")
    .replace(/[^\s"'<>|\\/:]+\.[A-Za-z0-9]{2,5}\b/g, (m) => (/^[\d.]+$/.test(m) ? m : "[file]"));
}

/** The log's last lines, without the diagnostics' own (they are in the report already). */
function logTail(): string[] {
  try {
    const path = join(storeDir(), "sidecar.log");
    if (!existsSync(path)) return [];
    const lines = readFileSync(path, "utf8").split(/\r?\n/).filter((l) => l && !l.startsWith("[diag]"));
    return lines.slice(-LOG_TAIL).map(withoutNames);
  } catch {
    return [];
  }
}

/** The whole report, as text. `header` is what the window adds: its version and settings. */
export function diagnosticsReport(header: unknown[]): { text: string } {
  return { text: diag.report(stateLines(header), logTail()) };
}

/** Writes the report to `path`, a text file the user picked. */
export async function saveDiagnostics(path: string, header: unknown[]): Promise<{ saved: boolean }> {
  if (!isAbsolute(path) || extname(path).toLowerCase() !== ".txt") throw new Error("The report is saved as a .txt file.");
  await writeFile(path, diagnosticsReport(header).text, "utf8");
  diag.log("app", "report_saved");
  return { saved: true };
}
