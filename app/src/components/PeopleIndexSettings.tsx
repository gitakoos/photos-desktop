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

// Settings for the desktop's own People and search index: the four models, the scan of the
// library on a button, and where this PC's copy in Drive stands.

import { useEffect, useRef, useState } from "react";
import { useLang, useT } from "../lib/i18n";
import type { IndexStatus, ModelsStatus, SyncStatus } from "../lib/people";
import { rpc } from "../lib/rpc";
import { CloudIcon, FaceIcon, MergeIcon, SearchIcon } from "./icons";

const megabytes = (n: number) => `${Math.round(n / 1_000_000)} MB`;
const megabytesOne = (n: number) => `${(n / 1_000_000).toFixed(1)} MB`;

/** Polls `method` while `active` says the answer is still moving. */
function usePolled<T>(method: string, active: (v: T | null) => boolean, ms: number): [T | null, (v: T) => void] {
  const [value, setValue] = useState<T | null>(null);
  const moving = active(value);
  useEffect(() => {
    let live = true;
    let timer = 0;
    const poll = async () => {
      try {
        const v = await rpc<T>(method);
        if (!live) return;
        setValue(v);
        if (active(v)) timer = window.setTimeout(poll, ms);
      } catch {
        /* the row shows what it last knew */
      }
    };
    void poll();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [method, moving]);
  return [value, setValue];
}

export function PeopleIndexSettings() {
  const t = useT();
  const { lang } = useLang();
  const date = new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short" });
  const [models, setModels] = usePolled<ModelsStatus>("mlModels", (v) => !!v?.downloading, 700);
  const [job, setJob] = usePolled<IndexStatus>("mlIndexStatus", (v) => !!v?.running, 1000);
  // Read often while a save runs, so its bar moves; slowly while changes only wait.
  const [sync, setSync] = usePolled<SyncStatus>("mlSync", (v) => !!v && (v.saving || v.pending), 3000);
  const [saveSync, setSaveSync] = usePolled<SyncStatus>("mlSync", (v) => !!v?.saving, 500);
  const shown = saveSync?.saving ? saveSync : sync;
  const [error, setError] = useState<string | null>(null);
  // Null until the sidecar answers, so the switch never shows a guess.
  const [autoMerge, setAutoMerge] = useState<boolean | null>(null);
  const [merging, setMerging] = useState(false);
  const [mergedNow, setMergedNow] = useState<number | null>(null);
  useEffect(() => {
    rpc<{ on: boolean }>("mlAutoMerge").then((v) => setAutoMerge(v.on), () => {});
  }, []);
  const toggleAutoMerge = async (on: boolean) => {
    setError(null);
    setMerging(true);
    setMergedNow(null);
    try {
      const v = await rpc<{ on: boolean; merged: number }>("mlAutoMerge", { on });
      setAutoMerge(v.on);
      if (v.on) setMergedNow(v.merged);
      if (v.merged > 0) window.dispatchEvent(new Event("pfp:people-changed"));
    } catch (e) {
      setError(String(e));
    } finally {
      setMerging(false);
    }
  };
  const [scanned, setScanned] = useState<number | null>(null);
  // How many photos any device has looked at, read again whenever a scan ends.
  useEffect(() => {
    if (job?.running) return;
    rpc<{ scanned: number }>("mlView").then((v) => setScanned(v.scanned), () => {});
  }, [job?.running]);

  // A scan that just ended: People reads what it found.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (job?.running) wasRunning.current = true;
    else if (job && wasRunning.current) {
      wasRunning.current = false;
      window.dispatchEvent(new Event("pfp:people-changed"));
    }
  }, [job]);
  // A scan that just ended has saved, or is about to: read where the copy stands again.
  useEffect(() => {
    if (job && !job.running) rpc<SyncStatus>("mlSync").then(setSync, () => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.running]);

  const ready = models?.missing === 0;
  const call = async <T,>(method: string, set: (v: T) => void) => {
    setError(null);
    try {
      set(await rpc<T>(method));
    } catch (e) {
      setError(String(e));
    }
  };

  let modelsLine = "";
  if (models?.downloading) {
    modelsLine = t("settings.mlModelsDownloading", { done: megabytes(models.downloading.done), total: megabytes(models.downloading.total) });
  } else if (models?.failed) {
    modelsLine = t("settings.mlModelsFailed");
  } else if (models) {
    modelsLine = ready ? t("settings.mlModelsReady") : t("settings.mlModelsMissing", { size: megabytes(models.missing) });
  }

  let jobLine = "";
  if (job?.running) {
    const n = (v: number) => v.toLocaleString(lang);
    jobLine =
      job.phase === "listing"
        ? t("settings.mlScanListing")
        : job.phase === "saving"
          ? t("settings.mlScanSaving")
          : job.phase === "retrying"
            ? t("settings.mlScanRetrying", { done: n(job.done), total: n(job.total) })
            : t("settings.mlScanRunning", { done: n(job.done), total: n(job.total), second: n(job.secondLooks), faces: n(job.faces) });
  } else if (job?.error) {
    jobLine = t("settings.mlScanError", { error: job.error });
  } else if (job?.finishedAt) {
    const n = (v: number) => v.toLocaleString(lang);
    jobLine =
      job.total === 0
        ? t("settings.mlScanNothing")
        : [
            t("settings.mlScanDone", { withFaces: n(job.withFaces), noFaces: n(job.noFaces), faces: n(job.faces), date: date.format(new Date(job.finishedAt)) }),
            job.retryLater > 0 ? t("settings.mlScanRetryLater", { count: n(job.retryLater) }) : "",
            job.unreadable > 0 ? t("settings.mlScanUnreadable", { count: n(job.unreadable) }) : "",
          ]
            .filter(Boolean)
            .join(" ");
  }

  const n = (v: number) => v.toLocaleString(lang);
  const progress = shown?.saving ? shown.progress : null;
  let syncLine = "";
  if (progress?.phase === "uploading") {
    syncLine = t("settings.mlSyncUploading", { sent: megabytesOne(progress.sent), total: megabytesOne(progress.total) });
  } else if (shown?.saving) syncLine = t("settings.mlSyncPreparing");
  else if (shown?.error) syncLine = t("settings.mlSyncFailed", { error: shown.error });
  else if (shown?.pending) syncLine = t("settings.mlSyncPending");
  else if (shown?.savedAt) syncLine = t("settings.mlSyncSaved", { date: date.format(new Date(shown.savedAt)) });
  else if (shown) syncLine = t("settings.mlSyncNever");
  const lastLine =
    !shown?.saving && shown?.last
      ? t(shown.last.outcome === "saved" ? "settings.mlSyncLastSaved" : "settings.mlSyncLastUpToDate", {
          faces: n(shown.last.faces),
          photos: n(shown.last.photos),
          people: n(shown.last.people),
          vectors: n(shown.last.vectors),
        })
      : "";
  const devices = [...new Set((shown?.sources ?? []).map((s) => s.device))];

  return (
    <>
      <h3 className="st-subhead">{t("settings.ml")}</h3>
      <p className="st-intro">{t("settings.mlIntro")}</p>
      <div className="st-rows">
        <div className="st-row off">
          <span className="st-row-ico" aria-hidden>
            <SearchIcon size={18} />
          </span>
          <div className="st-text">
            <div className="st-label">{t("settings.mlModels")}</div>
            {modelsLine && <div className="st-desc">{modelsLine}</div>}
            {models?.downloading && (
              <div className="st-progress">
                <div style={{ width: `${Math.round((models.downloading.done / Math.max(1, models.downloading.total)) * 100)}%` }} />
              </div>
            )}
          </div>
          {models && !ready && !models.downloading && (
            <button className="st-row-btn" onClick={() => void call<ModelsStatus>("mlModelsDownload", setModels)}>
              {t("settings.mlDownload")}
            </button>
          )}
        </div>
        <div className="st-row off">
          <span className="st-row-ico" aria-hidden>
            <FaceIcon size={18} />
          </span>
          <div className="st-text">
            <div className="st-label">{t("settings.mlScan")}</div>
            <div className="st-desc">{t("settings.mlScanDesc", { scanned: (scanned ?? 0).toLocaleString(lang) })}</div>
            {jobLine && <div className="st-desc st-status">{jobLine}</div>}
            {job?.running && job.total > 0 && (
              <div className="st-progress">
                <div style={{ width: `${Math.round((job.done / Math.max(1, job.total)) * 100)}%` }} />
              </div>
            )}
          </div>
          {job?.running ? (
            <button className="st-row-btn" onClick={() => void call<IndexStatus>("mlIndexCancel", setJob)}>
              {t("settings.mlScanStop")}
            </button>
          ) : (
            <button className="st-row-btn" disabled={!ready} onClick={() => void call<IndexStatus>("mlIndexStart", setJob)}>
              {t("settings.mlScanStart")}
            </button>
          )}
        </div>
        <label className="st-row">
          <span className="st-row-ico" aria-hidden>
            <MergeIcon size={18} />
          </span>
          <div className="st-text">
            <div className="st-label">{t("settings.mlAutoMerge")}</div>
            <div className="st-desc">{t("settings.mlAutoMergeDesc")}</div>
            {merging && <div className="st-desc st-status">{t("settings.mlAutoMergeRunning")}</div>}
            {!merging && mergedNow !== null && (
              <div className="st-desc st-status">{t("settings.mlAutoMergeDone", { count: mergedNow.toLocaleString(lang) })}</div>
            )}
          </div>
          <input
            className="st-switch"
            type="checkbox"
            checked={autoMerge === true}
            disabled={autoMerge === null || merging}
            onChange={(e) => void toggleAutoMerge(e.currentTarget.checked)}
          />
        </label>
        <div className="st-row off">
          <span className="st-row-ico" aria-hidden>
            <CloudIcon size={18} />
          </span>
          <div className="st-text">
            <div className="st-label">{t("settings.mlSync")}</div>
            {syncLine && <div className="st-desc">{syncLine}</div>}
            {shown?.saving && (
              <div className={`st-progress${progress?.phase === "uploading" ? "" : " st-progress-busy"}`}>
                <div style={{ width: progress?.phase === "uploading" ? `${Math.round((progress.sent / Math.max(1, progress.total)) * 100)}%` : "100%" }} />
              </div>
            )}
            {lastLine && <div className="st-desc st-status">{lastLine}</div>}
            {devices.length > 0 && <div className="st-desc st-status">{t("settings.mlSyncMerged", { devices: devices.join(", ") })}</div>}
          </div>
          <button
            className="st-row-btn"
            disabled={!!shown?.saving}
            onClick={() => void call<SyncStatus>("mlSaveNow", (v) => {
              setSync(v);
              setSaveSync(v);
            })}
          >
            {t("settings.mlSaveNow")}
          </button>
        </div>
        {error && (
          <div className="st-row off">
            <div className="st-text">
              <div className="st-desc">{error}</div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
