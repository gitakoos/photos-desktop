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

// The album dialogs: naming one, picking one, and the one delete that can cost
// photos. They all key off the window in the capture phase the way `Confirm`
// does, so Escape closes the dialog instead of also clearing the selection or
// the lightbox behind it.
//
// `NameDialog` is the app's one "name this" dialog. Albums were what it was
// written for; the photo rename asks exactly the same question, under the same
// SDK name rules, so it asks it here rather than growing a second copy.

import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";
import { useT } from "../lib/i18n";
import type { Album } from "../views/Albums";
import "../styles/Confirm.css";
import "../styles/AlbumDialogs.css";

/** The SDK refuses an empty name and anything longer than this. */
const MAX_NAME = 255;

/**
 * Names a thing: a new album, an album being renamed, a photo being renamed. The
 * confirm stays out of reach until the name has something in it other than
 * spaces, which is the same bar the SDK sets.
 */
export function NameDialog({
  title,
  confirmLabel,
  initial = "",
  placeholder,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string;
  confirmLabel: string;
  initial?: string;
  placeholder?: string;
  busy?: boolean;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState(initial);
  const name = draft.trim();
  const valid = name.length > 0 && name.length <= MAX_NAME;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      e.stopPropagation();
      if (e.key === "Escape") onCancel();
      else if (e.key === "Enter" && valid && !busy) onConfirm(name);
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel, onConfirm, name, valid, busy]);

  return (
    <div
      className="cf-backdrop"
      onClick={(e) => {
        e.stopPropagation();
        onCancel();
      }}
    >
      <div className="cf-panel" role="dialog" onClick={(e) => e.stopPropagation()}>
        <h3 className="cf-title">{title}</h3>
        <input
          autoFocus
          className="ad-input"
          value={draft}
          maxLength={MAX_NAME}
          placeholder={placeholder ?? t("albums.namePlaceholder")}
          disabled={busy}
          onChange={(e) => setDraft(e.currentTarget.value)}
          onFocus={(e) => e.currentTarget.select()}
        />
        <div className="cf-actions">
          <button className="cf-btn" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button
            className="cf-btn primary"
            disabled={!valid || busy}
            onClick={() => onConfirm(name)}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Picks the album for the selected photos, and makes a new one if none of them
 * fit. Creating is this dialog's own job so the caller only has to know how to
 * add photos to a uid; the new album is handed straight back as the pick.
 */
export function AlbumPicker({
  count,
  busy,
  exclude,
  onPick,
  onCancel,
}: {
  count: number;
  busy?: boolean;
  /** The album the photos are being added from, which is left off the list. */
  exclude?: string;
  onPick: (albumUid: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [albums, setAlbums] = useState<Album[] | null>(null);
  const [naming, setNaming] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await rpc<Album[]>("getAlbums");
        if (!cancelled) setAlbums(exclude ? list.filter((a) => a.uid !== exclude) : list);
      } catch (e) {
        if (!cancelled) {
          setError(String(e));
          setAlbums([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [exclude]);

  useEffect(() => {
    if (naming) return; // the name dialog owns the keys while it is up
    function onKey(e: KeyboardEvent) {
      e.stopPropagation();
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel, naming]);

  async function createAndPick(name: string) {
    setCreating(true);
    setError("");
    try {
      const album = await rpc<Album>("createAlbum", { name });
      setNaming(false);
      onPick(album.uid);
    } catch (e) {
      setError(String(e));
      setNaming(false);
    } finally {
      setCreating(false);
    }
  }

  if (naming) {
    return (
      <NameDialog
        title={t("albums.newTitle")}
        confirmLabel={t("albums.createAndAdd")}
        busy={creating}
        onConfirm={(name) => void createAndPick(name)}
        onCancel={() => setNaming(false)}
      />
    );
  }

  return (
    <div
      className="cf-backdrop"
      onClick={(e) => {
        e.stopPropagation();
        onCancel();
      }}
    >
      <div className="cf-panel" role="dialog" onClick={(e) => e.stopPropagation()}>
        <h3 className="cf-title">{t("albums.addTitle")}</h3>
        <p className="cf-msg">
          {t(count === 1 ? "albums.addCount.one" : "albums.addCount.other", { count })}
        </p>

        {error && <div className="ad-error">{error}</div>}

        <button className="ad-new" disabled={busy} onClick={() => setNaming(true)}>
          <span className="ad-new-plus">+</span>
          {t("albums.newAlbum")}
        </button>

        {albums === null && <div className="ad-hint">{t("common.loading")}</div>}
        {albums !== null && albums.length === 0 && !error && (
          <div className="ad-hint">{t("albums.none")}</div>
        )}

        {albums !== null && albums.length > 0 && (
          <div className="ad-list">
            {albums.map((a) => (
              <button
                className="ad-row"
                key={a.uid}
                disabled={busy}
                onClick={() => onPick(a.uid)}
              >
                <span className="ad-row-name">{a.name || t("albums.untitled")}</span>
                <span className="ad-row-count">
                  {t(a.photoCount === 1 ? "common.photoCount.one" : "common.photoCount.other", {
                    count: a.photoCount,
                  })}
                </span>
              </button>
            ))}
          </div>
        )}

        <div className="cf-actions">
          <button className="cf-btn" onClick={onCancel}>
            {t("common.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The album has stopped keeping itself on this device, and what it already
 * downloaded is still sitting there. Both answers are ordinary — nothing leaves
 * Proton either way, and the photos download again on demand — so both are named
 * outright rather than hidden behind a Cancel that would not say what it cancels.
 * Escape and the backdrop keep the files, which is the answer that changes nothing.
 */
export function AlbumFreeUpDialog({
  count,
  busy,
  onKeep,
  onFreeUp,
}: {
  count: number;
  busy?: boolean;
  onKeep: () => void;
  onFreeUp: () => void;
}) {
  const t = useT();

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      e.stopPropagation();
      if (e.key === "Escape") onKeep();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onKeep]);

  return (
    <div
      className="cf-backdrop"
      onClick={(e) => {
        e.stopPropagation();
        onKeep();
      }}
    >
      <div className="cf-panel" role="dialog" onClick={(e) => e.stopPropagation()}>
        <h3 className="cf-title">{t("albums.freeUpTitle")}</h3>
        <p className="cf-msg">
          {t(count === 1 ? "albums.freeUpCount.one" : "albums.freeUpCount.other", { count })}
        </p>
        <div className="ad-actions">
          <button className="cf-btn" autoFocus onClick={onKeep}>
            {t("albums.freeUpKeep")}
          </button>
          <button className="cf-btn primary" disabled={busy} onClick={onFreeUp}>
            {t("albums.freeUpConfirm")}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The album holds photos that are on no timeline, so deleting it as asked would
 * take them with it. Three ways out, and the two that are not Cancel are far
 * enough apart to be told apart: keeping the photos is the offered one, losing
 * them is spelled out. Enter is bound to nothing here, and the focus rests on
 * Cancel, because one of these buttons cannot be taken back.
 */
export function AlbumPhotoLossDialog({
  count,
  busy,
  onSaveToTimeline,
  onDeletePhotos,
  onCancel,
}: {
  count: number;
  busy?: boolean;
  onSaveToTimeline: () => void;
  onDeletePhotos: () => void;
  onCancel: () => void;
}) {
  const t = useT();

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      e.stopPropagation();
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  return (
    <div
      className="cf-backdrop"
      onClick={(e) => {
        e.stopPropagation();
        onCancel();
      }}
    >
      <div className="cf-panel" role="alertdialog" onClick={(e) => e.stopPropagation()}>
        <h3 className="cf-title">
          {t(count === 1 ? "albums.strandedTitle.one" : "albums.strandedTitle.other", { count })}
        </h3>
        <p className="cf-msg">
          {t(count === 1 ? "albums.strandedMsg.one" : "albums.strandedMsg.other", { count })}
        </p>
        <div className="ad-actions">
          <button className="cf-btn" autoFocus onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button className="cf-btn danger" disabled={busy} onClick={onDeletePhotos}>
            {t("albums.deletePhotosToo")}
          </button>
          <button className="cf-btn primary" disabled={busy} onClick={onSaveToTimeline}>
            {t("albums.savePhotos")}
          </button>
        </div>
      </div>
    </div>
  );
}
