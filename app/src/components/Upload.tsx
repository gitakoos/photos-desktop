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

import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { UploadItem, UploadStatus } from "../hooks/useUploads";
import { useT } from "../lib/i18n";
import { ContextMenu, type MenuAt } from "./ContextMenu";
import { CheckIcon, ChevronLeftIcon, SpinnerIcon, UploadArrowIcon } from "./icons";
import type { SyncInfo } from "../lib/mountActivity";
import "../styles/Upload.css";

export const MEDIA_EXTENSIONS = [
  "jpg", "jpeg", "png", "webp", "gif", "avif", "tif", "tiff", "heic", "heif", "dng",
  "mp4", "mov", "m4v", "webm", "mkv", "3gp",
];

/** A byte count in whole megabytes, for the unpacking line. */
function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024)).toLocaleString()} MB`;
}

type Props = {
  status: UploadStatus;
  running: boolean;
  /** A refused upload, from here or from a drop anywhere else in the window. */
  error: string;
  start: (paths: string[]) => Promise<void>;
  /** Imports a Google Takeout or Ente export, from zips or a folder. */
  startImport: (paths: string[]) => Promise<void>;
  cancel: () => void;
  clear: () => void;
  /** What the app is syncing besides uploads, and why; null when nothing. */
  sync: SyncInfo | null;
  onClose: () => void;
};

/** Which of the queue's rows are shown: all of them, or one kind picked from the summary. */
type Show = "all" | "done" | "skipped" | "failed" | "waiting";

/** What is moving first, then what needs a look, then what waits, then what is finished. */
const RANK: Record<UploadItem["status"], number> = { uploading: 0, failed: 1, pending: 2, done: 3, skipped: 3 };

function itemShown(it: UploadItem, show: Show): boolean {
  if (show === "all") return true;
  if (show === "waiting") return it.status === "pending" || it.status === "uploading";
  return it.status === show;
}

/** How far an uploading file is, 0..1, or null before its first block is out. */
function itemProgress(it: UploadItem): number | null {
  return it.status === "uploading" && it.size && it.sent ? Math.min(1, it.sent / it.size) : null;
}

const RING = 2 * Math.PI * 9;

/** The mark at the start of a row: a tick, a ring filling as the file goes, a warning, a dot. */
function StateMark({ item }: { item: UploadItem }) {
  if (item.status === "done" || item.status === "skipped") {
    return (
      <span className={`up-mark ${item.status}`}>
        <CheckIcon size={12} />
      </span>
    );
  }
  if (item.status === "failed") return <span className="up-mark failed">!</span>;
  if (item.status === "uploading") {
    const p = itemProgress(item);
    return (
      <span className="up-mark uploading">
        <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden>
          <circle cx="11" cy="11" r="9" className="up-ringtrack" />
          <circle
            cx="11"
            cy="11"
            r="9"
            className={`up-ringfill ${p === null ? "spin" : ""}`}
            strokeDasharray={RING}
            strokeDashoffset={p === null ? RING * 0.75 : RING * (1 - p)}
          />
        </svg>
      </span>
    );
  }
  return <span className="up-mark waiting" />;
}

/**
 * The upload screen. It takes the whole content area, over the view it was opened from,
 * which stays as it was underneath. Dropping is handled window-wide by `useUploads`, so
 * this is only the pickers plus the queue; it can be opened and left mid-upload.
 *
 * With nothing in the queue it is one large place to drop on, the import from another
 * service under it. Once files are in, the pickers move into the top bar and the screen
 * belongs to the queue: where the whole of it stands, whose counts also pick which rows
 * show, and the files, each with its state at the front.
 */
export function Upload({ status, running, error, start, startImport, cancel, clear, sync, onClose }: Props) {
  const t = useT();
  // Only the file picker's own failures. A refused upload belongs to `useUploads`,
  // which every way in shares, so both routes report through the one line below.
  const [pickError, setPickError] = useState("");
  const [show, setShow] = useState<Show>("all");
  const [importMenu, setImportMenu] = useState<MenuAt<null> | null>(null);

  // Escape goes back, as the crumb does, unless a dialog or a menu of its own is up.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || document.querySelector(".cf-backdrop, .st-backdrop, .ap-veil, .cm")) return;
      onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function pick(directory: boolean) {
    setPickError("");
    try {
      const selected = await open({
        multiple: !directory,
        directory,
        filters: directory
          ? undefined
          : [{ name: t("upload.filterName"), extensions: MEDIA_EXTENSIONS }],
      });
      if (!selected) return;
      await start(Array.isArray(selected) ? selected : [selected as string]);
    } catch (e) {
      setPickError(String(e));
    }
  }

  async function pickExport(directory: boolean) {
    setPickError("");
    try {
      const selected = await open({
        multiple: !directory,
        directory,
        filters: directory ? undefined : [{ name: t("upload.zipFilterName"), extensions: ["zip"] }],
      });
      if (!selected) return;
      await startImport(Array.isArray(selected) ? selected : [selected as string]);
    } catch (e) {
      setPickError(String(e));
    }
  }

  const importing = status.importing;
  const importLine = !importing
    ? ""
    : importing.phase === "unpacking" && importing.total > 0
      ? t("upload.importUnpacking", {
          part: importing.part,
          parts: importing.parts,
          done: megabytes(importing.done),
          total: megabytes(importing.total),
        })
      : t("upload.importReading");

  const settled = status.done + status.skipped + status.failed;
  const waiting = Math.max(0, status.total - settled);
  const progress = status.total > 0 ? settled / status.total : 0;
  const busy = status.total > 0 || status.items.length > 0 || !!importing;
  const message = error || pickError || status.importError;

  const counts: Record<Exclude<Show, "all">, number> = {
    done: status.done,
    waiting,
    skipped: status.skipped,
    failed: status.failed,
  };
  // A count picked from the summary that has since gone to nothing shows everything again.
  const showing: Show = show !== "all" && counts[show] === 0 ? "all" : show;
  const chips: [Exclude<Show, "all">, string][] = [
    ["done", t("upload.doneCount", { count: status.done })],
    ["waiting", t("upload.waitingCount", { count: waiting })],
    ["skipped", t("upload.alreadyThere", { count: status.skipped })],
    ["failed", t("upload.failedCount", { count: status.failed })],
  ];

  const rows = useMemo(
    () =>
      status.items
        .map((it, i) => ({ it, i }))
        .filter(({ it }) => itemShown(it, showing))
        .sort((a, b) => RANK[a.it.status] - RANK[b.it.status] || a.i - b.i),
    [status.items, showing],
  );

  const pickers = (
    <>
      <button className="up-btn ghost" onClick={() => pick(true)}>
        {t("upload.chooseFolder")}
      </button>
      <button className="up-btn" onClick={() => pick(false)}>
        {t("upload.chooseFiles")}
      </button>
    </>
  );

  return (
    <section className="up-page" aria-label={t("upload.title")}>
      <header className="up-head" data-tauri-drag-region>
        <button className="g-back" onClick={onClose} title={t("common.back")}>
          <ChevronLeftIcon />
        </button>
        <h2 className="g-crumbtitle up-title">{t("upload.title")}</h2>
        <div className="up-spacer" data-tauri-drag-region />
        {busy && (
          <div className="up-headactions">
            <button
              className="up-btn ghost"
              disabled={!!importing}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setImportMenu({ x: r.left, y: r.bottom + 6, target: null });
              }}
            >
              {t("upload.import")}
            </button>
            {pickers}
          </div>
        )}
      </header>

      {/* What the app is doing besides uploads, so a "syncing" up top is never left unexplained. */}
      {sync && (
        <div className="up-sync" role="status">
          <span className="up-syncicon">
            <SpinnerIcon size={16} />
          </span>
          <div className="up-synctext">
            <p className="up-synctitle">{sync.title}</p>
            <p className="up-syncwhy">{sync.why}</p>
            {sync.total > 0 && (
              <div className="up-bar">
                <div className="up-barfill" style={{ width: `${Math.round((sync.done / sync.total) * 100)}%` }} />
              </div>
            )}
          </div>
        </div>
      )}

      {!busy ? (
        <div className="up-stage">
          <div className="up-drop">
            <div className="up-dropicon">
              <UploadArrowIcon size={30} />
            </div>
            <p className="up-droptitle">{t("upload.dropHint")}</p>
            <p className="up-dropsub">{t("upload.dropSub")}</p>
            <div className="up-actions">{pickers}</div>
          </div>

          {message && <p className="up-error">{message}</p>}

          {/* An export from another service: its dates, places and albums come with it. */}
          <div className="up-import">
            <p className="up-importtitle">{t("upload.importTitle")}</p>
            <p className="up-importsub">{t("upload.importSub")}</p>
            <div className="up-actions">
              <button className="up-btn ghost" onClick={() => pickExport(false)}>
                {t("upload.importZip")}
              </button>
              <button className="up-btn ghost" onClick={() => pickExport(true)}>
                {t("upload.importFolder")}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="up-body">
          <div className="up-summary">
            <div className="up-sumtop">
              <span className="up-percent">{Math.floor(progress * 100)}%</span>
              <span className="up-sumtext">
                <span className="up-sumtitle">
                  {status.total === 0
                    ? importLine
                    : t(running ? "upload.progressRunning" : "upload.progressFinished", {
                        settled,
                        total: status.total,
                      })}
                </span>
                {importing && status.total > 0 && <span className="up-sumsub">{importLine}</span>}
              </span>
              <span className="up-spacer" />
              <button className="up-btn ghost small" onClick={running || importing ? cancel : clear}>
                {t(running || importing ? "common.cancel" : "upload.clear")}
              </button>
            </div>
            <div className="up-bar">
              <div className="up-barfill" style={{ width: `${progress * 100}%` }} />
            </div>
            {status.total > 0 && (
              <div className="up-chips">
                {chips
                  .filter(([key]) => counts[key] > 0)
                  .map(([key, label]) => (
                    <button
                      key={key}
                      className={`up-chip ${key} ${showing === key ? "on" : ""}`}
                      aria-pressed={showing === key}
                      onClick={() => setShow(showing === key ? "all" : key)}
                    >
                      <span className="up-chipdot" />
                      {label}
                    </button>
                  ))}
              </div>
            )}
          </div>

          {/* Above the list and never inside its height: a long message scrolls in its
              own box, so it can never squeeze the files out of view. */}
          {message && <p className="up-error">{message}</p>}

          <div className="up-queue">
            <div className="up-queuehead">
              <h3 className="up-queuetitle">{t("upload.queue")}</h3>
              <span className="up-spacer" />
              {showing !== "all" ? (
                <button className="up-link" onClick={() => setShow("all")}>
                  {t("upload.showAll")}
                </button>
              ) : (
                (status.itemsTotal ?? 0) > status.items.length && (
                  <span className="up-rows">
                    {t("upload.showingRows", { shown: status.items.length, total: status.itemsTotal ?? 0 })}
                  </span>
                )
              )}
            </div>
            {rows.length === 0 ? (
              <p className="up-empty">{t("upload.queueEmpty")}</p>
            ) : (
              <ul className="up-list">
                {rows.map(({ it, i }) => {
                  const p = itemProgress(it);
                  return (
                    <li className={`up-item ${it.status}`} key={`${it.name}-${i}`}>
                      <StateMark item={it} />
                      <span className="up-itemmain">
                        <span className="up-name" title={it.name}>
                          {it.name}
                        </span>
                        {it.status === "failed" && it.error ? (
                          <span className="up-reason">{it.error}</span>
                        ) : it.album ? (
                          <span className="up-album">{it.album}</span>
                        ) : null}
                      </span>
                      <span className="up-state">
                        {it.status === "uploading"
                          ? p !== null
                            ? `${Math.floor(p * 100)}%`
                            : t("upload.statusUploading")
                          : it.status === "skipped"
                            ? t("upload.statusSkipped")
                            : it.status === "failed"
                              ? t("upload.statusFailed")
                              : it.status === "pending"
                                ? t("upload.statusQueued")
                                : null}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}

      {importMenu && (
        <ContextMenu
          x={importMenu.x}
          y={importMenu.y}
          onClose={() => setImportMenu(null)}
          actions={[
            { key: "zip", label: t("upload.importZip"), onSelect: () => void pickExport(false) },
            { key: "folder", label: t("upload.importFolder"), onSelect: () => void pickExport(true) },
          ]}
        />
      )}
    </section>
  );
}
