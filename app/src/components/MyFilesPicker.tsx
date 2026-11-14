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

import { useEffect, useState } from "react";
import { useT } from "../lib/i18n";
import { rpc } from "../lib/rpc";
import { CheckIcon, ChevronRightIcon, CloseIcon, FolderOpenIcon, ImageIcon, PlayArrowIcon } from "./icons";
import "../styles/Confirm.css";
import "../styles/Settings.css";
import "../styles/AlbumDialogs.css";
import "../styles/LabelPicker.css";
import "../styles/MyFilesPicker.css";
import { backdropClose } from "../lib/backdrop";

type FileEntry = { uid: string; name: string; size: number; modifiedMs: number | null };
type Listing = { uid: string; name: string; folders: { uid: string; name: string; holds?: boolean }[]; files: FileEntry[] };
type Folder = { uid: string; name: string };
/** A file chosen on its own, with the name of the folder it is in, which becomes its album. */
export type ChosenFile = { uid: string; folder: string };

const VIDEO = /\.(mp4|mov|m4v|3gp|webm|mkv|avi)$/i;
/** Previews asked for at once: a few, so each call is short and the window's own calls get between them. */
const THUMB_BATCH = 12;
/** Sub-folders looked into per call, for whether they hold a photo. */
const CHECK_BATCH = 16;

/**
 * Folders and photos of My files to bring into Photos. Only the folders that hold a photo or
 * video somewhere are shown; inside one, its photos and videos show as previews and can be
 * picked one by one, or the folder can be taken whole with everything under it. Moving sends
 * each original to the Drive trash once its photo is in Photos; copying leaves them be.
 */
export function MyFilesPicker({
  onStart,
  onClose,
}: {
  onStart: (folders: Folder[], files: ChosenFile[], move: boolean) => void;
  onClose: () => void;
}) {
  const t = useT();
  /** The way down from the top of My files to the folder shown. */
  const [path, setPath] = useState<Folder[]>([]);
  const [listing, setListing] = useState<Listing | null>(null);
  const [failed, setFailed] = useState(false);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [files, setFiles] = useState<Map<string, ChosenFile>>(new Map());
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  /** Which sub-folders of the folder shown hold a photo, as the look through them finds out. */
  const [holds, setHolds] = useState<Record<string, boolean>>({});
  const [move, setMove] = useState(true);
  const here = path[path.length - 1];

  useEffect(() => {
    let live = true;
    setListing(null);
    setFailed(false);
    setHolds({});
    rpc<Listing>("myFilesList", { uid: here?.uid })
      .then(async (l) => {
        if (!live) return;
        setListing(l);
        setHolds(Object.fromEntries(l.folders.filter((f) => f.holds !== undefined).map((f) => [f.uid, f.holds!])));
        // The sub-folders are looked into a few at a time, in the order they are listed, so the
        // ones that hold photos appear one after another while the rest is still being looked at.
        void (async () => {
          // Each call answers what it settled in its short time; the rest is asked again.
          let open = l.folders.filter((f) => f.holds === undefined).map((f) => f.uid);
          let idle = 0;
          while (live && open.length > 0) {
            const asked = open.slice(0, CHECK_BATCH);
            const got = await rpc<Record<string, boolean>>("myFilesCheck", { uids: asked }).catch(
              () => Object.fromEntries(asked.map((uid) => [uid, true])),
            );
            // Asked again and again with no answer: shown, rather than looked at for ever.
            idle = Object.keys(got).length === 0 ? idle + 1 : 0;
            const settled = idle >= 20 ? Object.fromEntries(asked.map((uid) => [uid, true])) : got;
            if (live) setHolds((before) => ({ ...before, ...settled }));
            open = open.filter((uid) => !(uid in settled));
          }
        })();
        const missing = l.files.map((f) => f.uid);
        for (let i = 0; live && i < missing.length; i += THUMB_BATCH) {
          const got = await rpc<Record<string, string>>("myFilesThumbs", { uids: missing.slice(i, i + THUMB_BATCH) }).catch(
            () => ({}),
          );
          if (live) setThumbs((before) => ({ ...before, ...got }));
        }
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [here?.uid]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (path.length > 0) setPath(path.slice(0, -1));
      else onClose();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [path, onClose]);

  const checked = listing ? listing.folders.filter((f) => holds[f.uid] !== undefined).length : 0;
  const isChosen = (uid: string) => folders.some((f) => f.uid === uid);
  // What is under a chosen folder comes with it, so it shows as chosen and is not picked on its own.
  const underChosen = path.some((f) => isChosen(f.uid));
  const toggleFolder = (folder: Folder) =>
    setFolders((list) => (list.some((f) => f.uid === folder.uid) ? list.filter((f) => f.uid !== folder.uid) : [...list, folder]));
  const toggleFile = (file: FileEntry) =>
    setFiles((before) => {
      const next = new Map(before);
      if (next.has(file.uid)) next.delete(file.uid);
      else next.set(file.uid, { uid: file.uid, folder: here?.name ?? "" });
      return next;
    });
  const allHere = !!listing && listing.files.length > 0 && listing.files.every((f) => files.has(f.uid));
  const toggleAll = () =>
    setFiles((before) => {
      const next = new Map(before);
      for (const f of listing?.files ?? []) {
        if (allHere) next.delete(f.uid);
        else next.set(f.uid, { uid: f.uid, folder: here?.name ?? "" });
      }
      return next;
    });

  const folderRow = (folder: Folder, label: string, open?: () => void) => {
    const on = underChosen || isChosen(folder.uid);
    return (
      <div className={`lp-row mf-row${on ? " on" : ""}`} key={folder.uid}>
        <button
          className={`lp-mark ${on ? "all" : "none"} mf-check`}
          aria-pressed={on}
          aria-label={label}
          disabled={underChosen}
          onClick={() => toggleFolder(folder)}
        >
          {on ? <CheckIcon size={12} /> : null}
        </button>
        <button className="mf-open" onClick={open ?? (() => toggleFolder(folder))} disabled={!open && underChosen}>
          <FolderOpenIcon size={16} />
          <span className="lp-name">{label}</span>
          {open && <ChevronRightIcon size={18} />}
        </button>
      </div>
    );
  };

  return (
    <div
      className="cf-backdrop"
      {...backdropClose(onClose)}
    >
      <div className="cf-panel ad-picker lp-picker mf-picker" role="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ad-picker-head">
          <div className="ad-picker-titles">
            <h3 className="cf-title">{t("myFiles.title")}</h3>
            <p className="cf-msg">{t("myFiles.selection", { folders: folders.length, files: files.size })}</p>
          </div>
          <button className="ad-close" onClick={onClose} title={t("common.close")} aria-label={t("common.close")}>
            <CloseIcon size={18} />
          </button>
        </div>

        <nav className="mf-path" aria-label={t("myFiles.root")}>
          <button className="mf-crumb" onClick={() => setPath([])} disabled={path.length === 0}>
            {t("myFiles.root")}
          </button>
          {path.map((f, i) => (
            <span className="mf-crumbwrap" key={f.uid}>
              <ChevronRightIcon size={14} />
              <button className="mf-crumb" onClick={() => setPath(path.slice(0, i + 1))} disabled={i === path.length - 1}>
                {f.name}
              </button>
            </span>
          ))}
        </nav>

        <div className="lp-list mf-list">
          {failed && <div className="ad-hint">{t("myFiles.loadFailed")}</div>}
          {!failed && !listing && <div className="ad-hint">{t("myFiles.looking")}</div>}
          {listing && here && folderRow(here, t("myFiles.thisFolder"))}
          {listing && checked < listing.folders.length && (
            <div className="mf-checking">
              <span className="mf-checkbar">
                <span style={{ width: `${Math.round((checked / listing.folders.length) * 100)}%` }} />
              </span>
              {t("myFiles.checking", { done: checked, total: listing.folders.length })}
            </div>
          )}
          {listing?.folders.filter((f) => holds[f.uid]).map((f) => folderRow(f, f.name, () => setPath([...path, f])))}
          {listing && listing.files.length > 0 && (
            <>
              <div className="mf-fileshead">
                <span>{t("myFiles.mediaCount", { count: listing.files.length })}</span>
                {!underChosen && (
                  <button className="mf-all" onClick={toggleAll}>
                    {t(allHere ? "myFiles.selectNone" : "myFiles.selectAll")}
                  </button>
                )}
              </div>
              <div className="mf-grid">
                {listing.files.map((f) => {
                  const on = underChosen || files.has(f.uid);
                  return (
                    <button
                      key={f.uid}
                      className={`mf-tile${on ? " on" : ""}`}
                      aria-pressed={on}
                      disabled={underChosen}
                      title={f.name}
                      onClick={() => toggleFile(f)}
                    >
                      <span className="mf-thumb">
                        {thumbs[f.uid] ? (
                          <img src={thumbs[f.uid]} alt="" draggable={false} />
                        ) : (
                          <ImageIcon size={26} />
                        )}
                        {VIDEO.test(f.name) && (
                          <span className="mf-video" aria-hidden>
                            <PlayArrowIcon size={14} />
                          </span>
                        )}
                        <span className={`lp-mark ${on ? "all" : "none"} mf-tilemark`} aria-hidden>
                          {on ? <CheckIcon size={12} /> : null}
                        </span>
                      </span>
                      <span className="mf-tilename">{f.name}</span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
          {listing && checked === listing.folders.length && !listing.folders.some((f) => holds[f.uid]) && listing.files.length === 0 && (
            <div className="ad-hint">{t("myFiles.empty")}</div>
          )}
        </div>

        <div className="mf-foot">
          <div className="st-seg mf-mode" role="group">
            <button className={`st-seg-btn${move ? " on" : ""}`} aria-pressed={move} onClick={() => setMove(true)}>
              {t("myFiles.move")}
            </button>
            <button className={`st-seg-btn${!move ? " on" : ""}`} aria-pressed={!move} onClick={() => setMove(false)}>
              {t("myFiles.copy")}
            </button>
          </div>
          <p className="mf-modedesc">{t(move ? "myFiles.moveDesc" : "myFiles.copyDesc")}</p>
          <div className="cf-actions">
            <button className="cf-btn" onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button
              className="cf-btn primary"
              disabled={folders.length === 0 && files.size === 0}
              onClick={() => onStart(folders, [...files.values()], move)}
            >
              {t("myFiles.start")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
