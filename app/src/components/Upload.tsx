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

import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { UploadStatus } from "../hooks/useUploads";
import { useT } from "../lib/i18n";
import { CheckIcon, CloseIcon, UploadArrowIcon } from "./icons";
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
  onClose: () => void;
};

/**
 * The upload panel. Dropping is handled window-wide by `useUploads`, so this is
 * only the picker plus the queue view; it can be opened and closed mid-upload.
 */
export function Upload({ status, running, error, start, startImport, cancel, clear, onClose }: Props) {
  const t = useT();
  // Only the file picker's own failures. A refused upload belongs to `useUploads`,
  // which every way in shares, so both routes report through the one line below.
  const [pickError, setPickError] = useState("");

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
  const progress = status.total > 0 ? settled / status.total : 0;

  return (
    <div className="up-backdrop" onClick={onClose}>
      <div className="up-panel" onClick={(e) => e.stopPropagation()}>
        <div className="up-head">
          <h2 className="up-title">{t("upload.title")}</h2>
          <button className="up-x" onClick={onClose} title={t("common.close")}>
            <CloseIcon size={12} />
          </button>
        </div>

        <div className="up-drop">
          <div className="up-dropicon">
            <UploadArrowIcon size={20} />
          </div>
          <p className="up-droptitle">{t("upload.dropHint")}</p>
          <p className="up-dropsub">{t("upload.dropSub")}</p>
          <div className="up-actions center">
            <button className="up-btn" onClick={() => pick(false)}>
              {t("upload.chooseFiles")}
            </button>
            <button className="up-btn ghost" onClick={() => pick(true)}>
              {t("upload.chooseFolder")}
            </button>
          </div>
        </div>

        {/* An export from another service: its dates, places and albums come with it. */}
        <div className="up-import">
          <div className="up-importtext">
            <p className="up-importtitle">{t("upload.importTitle")}</p>
            <p className="up-importsub">{t("upload.importSub")}</p>
          </div>
          <div className="up-actions">
            <button className="up-btn ghost" disabled={!!importing} onClick={() => pickExport(false)}>
              {t("upload.importZip")}
            </button>
            <button className="up-btn ghost" disabled={!!importing} onClick={() => pickExport(true)}>
              {t("upload.importFolder")}
            </button>
          </div>
          {importing && (
            <div className="up-importstate">
              <span>{importLine}</span>
              <button className="up-link" onClick={cancel}>
                {t("common.cancel")}
              </button>
            </div>
          )}
        </div>

        {status.total > 0 && (
          <>
            <div className="up-bar">
              <div className="up-barfill" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            <div className="up-counts">
              <span>
                {settled} / {status.total}
              </span>
              {status.skipped > 0 && (
                <span className="up-dim">{t("upload.alreadyThere", { count: status.skipped })}</span>
              )}
              {status.failed > 0 && (
                <span className="up-bad">{t("upload.failedCount", { count: status.failed })}</span>
              )}
              <span className="up-spacer" />
              {running ? (
                <button className="up-link" onClick={cancel}>
                  {t("common.cancel")}
                </button>
              ) : (
                <button className="up-link" onClick={clear}>
                  {t("upload.clear")}
                </button>
              )}
            </div>

            {(status.itemsTotal ?? 0) > status.items.length && (
              <p className="up-dim up-rows">
                {t("upload.showingRows", { shown: status.items.length, total: status.itemsTotal ?? 0 })}
              </p>
            )}
            <ul className="up-list">
              {status.items.map((it, i) => (
                <li className={`up-item ${it.status}`} key={`${it.name}-${i}`}>
                  <span className="up-name" title={it.name}>
                    {it.name}
                  </span>
                  {it.album && <span className="up-album">{it.album}</span>}
                  <span className="up-state">
                    {it.status === "done"
                      ? <CheckIcon size={11} />
                      : it.status === "uploading"
                        ? t("upload.statusUploading")
                        : it.status === "skipped"
                          ? t("upload.statusSkipped")
                          : it.status === "failed"
                            ? t("upload.statusFailed")
                            : t("upload.statusQueued")}
                  </span>
                  {it.status === "failed" && it.error && <span className="up-reason">{it.error}</span>}
                </li>
              ))}
            </ul>
          </>
        )}

        {(error || pickError || status.importError) && (
          <p className="up-error">{error || pickError || status.importError}</p>
        )}
      </div>
    </div>
  );
}
