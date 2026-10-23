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

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { rpc } from "../lib/rpc";
import { useT } from "../lib/i18n";
import { isWindows } from "../lib/platform";
import { isNewer } from "../lib/version";
import { autoUpdateOn } from "../lib/updatePrefs";
import logo from "../assets/applogo.png";
import "../styles/UpdateOverlay.css";

/** Asks the overlay to start an update now, from Settings' "Check for updates". */
export const START_UPDATE_EVENT = "pfp-start-update";

type Job = { phase: "idle" | "downloading" | "ready" | "failed"; received: number; total: number; error: string };
type Step = "none" | "downloading" | "waiting" | "installing" | "failed";

const LAST_VERSION_KEY = "pfp.lastVersion";
/** How long a check stands before the window coming back asks again. */
const RECHECK_MS = 6 * 60 * 60 * 1000;

function megabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(0);
}

/**
 * The app's own updater, drawn over the window: when a newer release is out, the app
 * dims and the card in the middle downloads it, installs it and restarts into it. The
 * download runs in the background process, off the channel the app draws from, so the
 * library stays usable underneath until the install itself.
 */
export function UpdateOverlay() {
  const t = useT();
  const [step, setStep] = useState<Step>("none");
  const [version, setVersion] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [updated, setUpdated] = useState("");
  // The host refused the staged installer: its signature or its version did not hold.
  const [refused, setRefused] = useState(false);
  const running = useRef(false);
  // Which run is current: "Later" or a new run makes an older one stop where it is.
  const generation = useRef(0);

  const run = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setRefused(false);
    const mine = ++generation.current;
    const stale = () => generation.current !== mine;
    let latest: { version: string } | null = null;
    try {
      const current = await getVersion();
      latest = await rpc<{ version: string } | null>("checkUpdate");
      if (latest && !isNewer(latest.version, current)) latest = null;
    } catch {
      // Offline, or GitHub unreachable: nothing to offer, and nothing to say about it.
    }
    if (!latest) {
      running.current = false;
      return;
    }
    try {
      setVersion(latest.version);
      setStep("downloading");
      let state = await rpc<Job>("startUpdateDownload");
      while (state.phase === "downloading") {
        if (stale()) return;
        setJob(state);
        await new Promise((r) => setTimeout(r, 400));
        state = await rpc<Job>("updateStatus");
      }
      if (stale()) return;
      setJob(state);
      if (state.phase !== "ready") throw new Error(state.error);
      // Never cut an upload short: the install closes the app.
      for (;;) {
        const uploads = await rpc<{ running: boolean }>("uploadStatus").catch(() => ({ running: false }));
        if (!uploads.running) break;
        if (stale()) return;
        setStep("waiting");
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (stale()) return;
      setStep("installing");
      await new Promise((r) => setTimeout(r, 700));
      // The app exits here and the installer takes over, unless the host refuses it.
      await invoke("run_updater").catch((e) => {
        setRefused(true);
        throw e;
      });
    } catch {
      if (stale()) return;
      setStep("failed");
      running.current = false;
    }
  }, []);

  // Checked once the window is actually on screen: a start into the tray waits until
  // it is opened, so nobody is updated out from under a window they cannot see. An app
  // kept in the tray for days checks again when its window comes back, at most every
  // RECHECK_MS. With automatic updates off, only Settings starts one.
  useEffect(() => {
    if (!isWindows) return;
    let timer: number | undefined;
    let checked = 0;
    const go = () => {
      if (!autoUpdateOn()) return;
      if (document.visibilityState !== "visible" || timer !== undefined) return;
      if (checked && Date.now() - checked < RECHECK_MS) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        checked = Date.now();
        void run();
      }, 2500);
    };
    go();
    document.addEventListener("visibilitychange", go);
    const manual = () => void run();
    window.addEventListener(START_UPDATE_EVENT, manual);
    return () => {
      document.removeEventListener("visibilitychange", go);
      window.removeEventListener(START_UPDATE_EVENT, manual);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [run]);

  // The first start after an update says so.
  useEffect(() => {
    void getVersion().then((current) => {
      let last: string | null = null;
      try {
        last = localStorage.getItem(LAST_VERSION_KEY);
        localStorage.setItem(LAST_VERSION_KEY, current);
      } catch {
        return;
      }
      if (last && isNewer(current, last)) {
        setUpdated(current);
        window.setTimeout(() => setUpdated(""), 5000);
      }
    }).catch(() => {});
  }, []);

  if (step === "none") {
    return updated ? (
      <div className="uo-toast" role="status">
        {t("update.done", { version: updated })}
      </div>
    ) : null;
  }

  const fraction = job && job.total > 0 ? Math.min(1, job.received / job.total) : 0;
  const hashFailed =
    refused ||
    ["HASH_MISMATCH", "NO_DIGEST", "BAD_ORIGIN", "NO_SIGNATURE", "BAD_SIGNATURE"].includes(job?.error ?? "");

  return (
    <div className="uo-backdrop">
      <div className="uo-card" role="dialog" aria-live="polite" aria-label={t("update.title", { version })}>
        <img className="uo-logo" src={logo} alt="" draggable={false} />
        <h2 className="uo-title">{t("update.title", { version })}</h2>

        {step === "downloading" && (
          <>
            <p className="uo-text">
              {job && job.total > 0
                ? t("update.downloading", { done: megabytes(job.received), total: megabytes(job.total) })
                : t("update.preparing")}
            </p>
            <div className="uo-bar">
              <div className="uo-fill" style={{ width: `${Math.round(fraction * 100)}%` }} />
            </div>
          </>
        )}
        {step === "waiting" && (
          <>
            <p className="uo-text">{t("update.waitUploads")}</p>
            <div className="uo-bar">
              <div className="uo-fill uo-moving" />
            </div>
          </>
        )}
        {step === "installing" && (
          <>
            <p className="uo-text">{t("update.installing")}</p>
            <div className="uo-bar">
              <div className="uo-fill uo-moving" />
            </div>
          </>
        )}
        {step === "failed" && (
          <>
            <p className="uo-text">{hashFailed ? t("update.hashError") : t("update.failed")}</p>
            <div className="uo-actions">
              <button className="uo-btn ghost" onClick={() => setStep("none")}>
                {t("update.later")}
              </button>
              <button className="uo-btn" onClick={() => void run()}>
                {t("update.retry")}
              </button>
            </div>
          </>
        )}
        {(step === "downloading" || step === "waiting") && (
          <button
            className="uo-later"
            onClick={() => {
              generation.current++;
              running.current = false;
              setStep("none");
            }}
          >
            {t("update.later")}
          </button>
        )}
      </div>
    </div>
  );
}
