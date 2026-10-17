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

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { rpc } from "../lib/rpc";
import { downloadPhotos, explorerMode } from "../lib/download";
import { pinOffline, unpinOffline } from "../lib/offline";
import { cachedPreview, dropPreview, loadPreview } from "../lib/previewStore";
import { fetchOriginal, releaseOriginal } from "../lib/originalStore";
import { useCloudMedia, type CloudItem } from "../hooks/useCloudMedia";
import { useProgressiveImage } from "../hooks/useProgressiveImage";
import { formatBytes, formatDate, dimensionsOf } from "../lib/format";
import { Confirm } from "./Confirm";
import { ShareDialog } from "./ShareDialog";
import { AlbumPicker } from "./AlbumDialogs";
import { ContextMenu, type MenuAction } from "./ContextMenu";
import { ViewerShell, type ViewerStage } from "./ViewerShell";
import {
  CloudIcon,
  DownloadIcon,
  FolderOpenIcon,
  HeartIcon,
  LibraryAddIcon,
  OfflinePinIcon,
  PencilIcon,
  ShareIcon,
  TrashIcon,
} from "./icons";
import { PhotoEditor } from "./PhotoEditor";
import { cloudEditorSource, isEditableImage, saveCloudEdit } from "../lib/cloudEditor";
import { TAG, withFavorite } from "../lib/tags";
import { useT } from "../lib/i18n";
import "../styles/Lightbox.css";

type Details = {
  uid: string;
  name: string;
  type: string;
  mediaType: string | null;
  captureTime: number | null;
  creationTime: number;
  modificationTime: number | null;
  size: number | null;
  storageSize: number | null;
  sha1: string | null;
  sha1Verified: boolean | null;
  extra: Record<string, unknown> | null;
  tags: number[];
  albumCount: number;
  isShared: boolean;
  isSharedPublicly: boolean;
  owner: string | null;
};

type Props = {
  uid: string;
  fallbackUrl: string | null;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
  onTrashed: (uid: string) => void;
  onRenamed: (uid: string, name: string) => void;
  /** A saved edit created a new timeline photo, so the caller reloads to show it. */
  onEdited?: () => void;
  /** Whether the edit control is offered. Off for shared photos this account cannot edit. */
  editable?: boolean;
  /** Whether this photo is downloaded (hydrated), which drives Download vs Free up. */
  isLocal?: boolean;
  /** Whether the app holds its own encrypted copy, a different place from `isLocal`. */
  isOffline?: boolean;
  /**
   * What the caller already knows this node to be, from the timeline tags. When
   * given, the viewer branches image/video and starts the preview (or the video)
   * immediately, without waiting for the details lookup. Callers with a plain photo
   * list omit it, and the details settle the media type instead, as before.
   */
  kind?: "image" | "video";
  /**
   * The caller's cached favourite state, so the heart is right on the first frame.
   * Callers without cached tags omit it and the details lookup settles it instead.
   */
  isFavorite?: boolean;
  onFavoriteChanged?: (uid: string, isFavorite: boolean) => void;
  /**
   * The list this photo sits in, for the filmstrip and the contents list. The caller
   * already holds it, so it is passed rather than fetched; without it the viewer is
   * exactly what it was, one photo and two arrows.
   *
   * `index` is where `uid` sits in it, and `onJump` is handed the index to move to.
   */
  items?: CloudItem[];
  index?: number;
  onJump?: (i: number) => void;
};

/**
 * How long a photo has to be the one on screen before the calls that are not its
 * picture go out for it.
 *
 * Those calls are the full-resolution upgrade, the details behind the name and the info
 * panel, and a video's own bytes. Each is worth having for a photo somebody is looking
 * at and worth nothing at all for one passed through on the way to another. The
 * sidecar answers one call at a time, so a run through fifty photos would put three
 * rounds of them in front of the one photo the reader stopped on. Waiting for the photo
 * to settle means a photo passed through never asks for any of them.
 *
 * Long enough to cover a held arrow key, short enough that stopping does not read as a
 * pause: the picture is already up by then either way, because the preview is
 * deliberately NOT behind this and goes out the instant the photo opens, exactly as it
 * always has.
 */
const SETTLE_MS = 250;

/** Decode base64 video bytes (from the sidecar) into a playable Blob. */
function b64ToBlob(b64: string, mime: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/**
 * The viewer for a photo in Proton. The stage, the navigation, the keyboard and
 * the panel around the rows are the shared shell; what is left here is the
 * actions that need an account and the SDK lookup that fills the rows.
 */
export function Lightbox({
  uid,
  fallbackUrl,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  onClose,
  onTrashed,
  onRenamed,
  onEdited,
  editable = true,
  isLocal = false,
  isOffline = false,
  kind,
  isFavorite,
  onFavoriteChanged,
  items,
  index = -1,
  onJump,
}: Props) {
  const t = useT();
  const neighbours = useCloudMedia(items, index, onJump);
  // Both carry the photo they belong to. A uid change re-renders before the effect
  // below can clear them, so an untagged value would spend that render paired with the
  // new photo — showing the one just stepped away from under the new photo's name.
  const [preview, setPreview] = useState<{ uid: string; url: string | null } | null>(null);
  const [original, setOriginal] = useState<{ uid: string; url: string | null } | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(true);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoState, setVideoState] = useState<"idle" | "loading" | "ready" | "toolarge" | "error">(
    "idle",
  );
  const [details, setDetails] = useState<Details | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  // Our own optimistic flip, which outranks both sources below until the uid
  // changes. Cleared on failure, so the heart falls back to the truth.
  const [favOverride, setFavOverride] = useState<boolean | null>(null);
  // The right-click menu, and the "add to album" picker it can open.
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [pickingAlbum, setPickingAlbum] = useState(false);
  // A menu dismissed by a click-away must not also close the viewer: the menu closes on
  // the mousedown, so this brief window swallows the click that lands right after it.
  const suppressCloseUntil = useRef(0);

  // The caller's kind wins when it has one, so the video branch fires on open
  // without waiting for the details. Without it, the media type comes from the
  // details as before (the fallback path fetches them on open).
  const isVideo =
    kind === "video" || (kind === undefined && (details?.mediaType ?? "").startsWith("video/"));

  // The caller's cached tags win when it has them (instant, and it is the state
  // the grid renders); callers without them fall back to the details lookup.
  // `null` means not known yet, which keeps the heart disabled rather than lying.
  const fav: boolean | null =
    favOverride ?? isFavorite ?? (details ? details.tags.includes(TAG.Favorite) : null);

  // The cloud editor opens what sharp can decode; HEIC and RAW keep only the viewer, so
  // the Edit control is hidden for those rather than offering an edit that would fail.
  const canEdit = editable && !isVideo && !!details && isEditableImage(details.mediaType, details.name);

  useEffect(() => {
    setError("");
    setConfirming(false);
    setSharing(false);
    setDetails(null);
    setFavOverride(null);
    setVideoUrl(null);
    setVideoState("idle");

    let cancelled = false;
    // Resolves true once this photo has been the one on screen for long enough to be
    // worth more than its picture, and false the moment the viewer leaves it. Both
    // outcomes settle, so nothing below is left suspended on a photo nobody is on.
    let onSettle: (stayed: boolean) => void = () => {};
    const settled = new Promise<boolean>((resolve) => {
      onSettle = resolve;
    });
    const settleTimer = setTimeout(() => onSettle(true), SETTLE_MS);

    // A prefetched neighbour is already here, so stepping across is instant.
    const cached = cachedPreview(uid) ?? null;
    setPreview({ uid, url: cached });
    setOriginal(null);
    setLoadingPreview(cached === null);

    // The HD still is what the user is waiting for, so it goes out on its own and
    // never queues behind the details lookup on the single channel. (A video shows
    // this as its poster while its bytes load in the effect below.)
    (async () => {
      try {
        const hd = await loadPreview(uid);
        if (!cancelled) setPreview({ uid, url: hd });
      } finally {
        // Whether the HD arrived or not, the load attempt is over — stop the
        // spinner. A failed preview simply falls back to the grid thumbnail
        // instead of spinning forever.
        if (!cancelled) setLoadingPreview(false);
      }

      // Then, and only then, the photo's own bytes. The preview is a thumbnail, so it
      // is as sharp as this viewer could ever get before this step; the full file
      // replaces it in place once it has decoded.
      //
      // Deliberately after the preview rather than alongside it: both are served by the
      // one sidecar, and nothing may make the fast path slower. Behind the settle as
      // well, because a preview already in the cache resolves instantly and would
      // otherwise let a photo being stepped past start a transfer of its own. It
      // resolves to null for a format the engine cannot draw, for a video reaching here
      // before the details have settled its type, and for a transfer that fails. In
      // every one of those the preview simply stays, which is what the viewer showed
      // before.
      if (!cancelled && kind !== "video" && (await settled)) {
        const full = await fetchOriginal(uid, () => cancelled);
        if (!cancelled) setOriginal({ uid, url: full });
      }
    })();

    // The details carry the filename shown in the top bar and everything in the
    // info panel. They go out once the photo has settled, so a photo being passed
    // through never asks for them and the one the reader stops on is not queued behind
    // the lookups of everything before it. Re-runs per photo, so stepping keeps the name
    // in sync. `kind` (when the caller has it) already drives the image/video branch
    // below, so the preview never waits on these details to start.
    (async () => {
      if (!(await settled)) return;
      try {
        const meta = await rpc<Details>("getNodeDetails", { uid });
        if (!cancelled) setDetails(meta);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(settleTimer);
      onSettle(false);
      // The staged original is a decrypted photo sitting on disk, so it goes as soon as
      // the viewer steps off this one or closes, rather than lingering until the next
      // photo displaces it. A photo left before it ever asked for one has nothing to
      // drop, and the release knows it.
      releaseOriginal(uid);
    };
  }, [uid, kind]);

  // A video: fetch its bytes (kept in memory) and wrap them in a Blob to play.
  // Images skip this entirely and keep using the HD still above.
  //
  // Behind the same settle, and this is where it matters most: a video crosses the one
  // channel as a whole file in a single call, so one stepped past would hold the
  // viewer up for every photo after it. The poster is the preview and it is already
  // showing, so what the wait actually delays is the first frame becoming playable.
  //
  // Only when the caller told us this was a video, which is the case that fires on open.
  // Reaching here off the details instead means the photo has already sat still long
  // enough to have asked for them, and charging it a second wait would be paying twice.
  useEffect(() => {
    if (!isVideo) return;
    let url: string | null = null;
    let cancelled = false;
    setVideoState("loading");
    const settle = setTimeout(() => {
      void (async () => {
        try {
          const v = await rpc<{ base64: string; mime: string }>("getVideo", { uid });
          if (cancelled) return;
          url = URL.createObjectURL(b64ToBlob(v.base64, v.mime));
          setVideoUrl(url);
          setVideoState("ready");
        } catch (e) {
          if (!cancelled) {
            setVideoState(String(e).includes("VIDEO_TOO_LARGE") ? "toolarge" : "error");
          }
        }
      })();
    }, kind === "video" ? SETTLE_MS : 0);
    return () => {
      cancelled = true;
      clearTimeout(settle);
      if (url) URL.revokeObjectURL(url);
    };
  }, [uid, isVideo, kind]);

  async function trash() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const results = await rpc<{ uid: string; ok: boolean; error?: string }[]>("trashPhotos", {
        uids: [uid],
      });
      const failure = results.find((r) => !r.ok);
      if (failure) {
        setError(failure.error ?? t("viewer.trashFailed"));
      } else {
        dropPreview(uid);
        onTrashed(uid);
      }
    } catch (e) {
      setError(String(e));
    }
    setBusy(false);
  }

  async function toggleFavorite() {
    if (busy || fav === null) return;
    const next = !fav;
    setBusy(true);
    setError("");
    setFavOverride(next); // flip now; the server call only has to confirm it
    try {
      const results = await rpc<{ uid: string; ok: boolean; error?: string }[]>("setFavorite", {
        uids: [uid],
        favorite: next,
      });
      const failure = results.find((r) => !r.ok);
      if (failure) {
        setFavOverride(null);
        setError(failure.error ?? t("viewer.favoriteFailed"));
      } else {
        onFavoriteChanged?.(uid, next);
        setDetails((d) => (d ? { ...d, tags: withFavorite(d.tags, next) } : d));
      }
    } catch (e) {
      setFavOverride(null);
      setError(String(e));
    }
    setBusy(false);
  }

  /** Rethrows so the shell keeps the editor open on a name the server refused. */
  async function rename(name: string) {
    setBusy(true);
    setError("");
    try {
      const res = await rpc<{ uid: string; name: string }>("renamePhoto", { uid, name });
      setDetails((d) => (d ? { ...d, name: res.name } : d));
      onRenamed(uid, res.name);
    } catch (e) {
      setError(String(e));
      throw e;
    } finally {
      setBusy(false);
    }
  }

  // Which mode Download is in, so the button says where the file will actually land
  // rather than naming the Proton Photos folder and then writing somewhere else.
  const [explorer, setExplorer] = useState(false);
  useEffect(() => {
    void explorerMode().then(setExplorer);
  }, []);

  // Download the photo in whichever mode is active: into the Proton Photos folder
  // (hydrate its placeholder, and the grid's poll refreshes the badge and this
  // button), or into a folder the user picks. Both wait for the real transfer, so
  // they hold `busy`, because a second click would otherwise start the photo over.
  // Only a failure is worth a banner: the badge and the file itself confirm the rest.
  async function download() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await downloadPhotos([uid]);
      if (result.mode === "explorer" && result.kept === 0) setError(t("download.doneNone"));
      if (result.mode === "saved" && result.failed > 0) setError(t("viewer.downloadFailed"));
    } catch (e) {
      setError(String(e));
    }
    setBusy(false);
  }
  // Free the photo up (dehydrate every copy back to cloud-only).
  async function freeUp() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if ((await invoke<number>("free_up_selected", { uids: [uid] })) === 0) {
        setError(t("download.freedUpNone"));
      }
    } catch (e) {
      setError(String(e));
    }
    setBusy(false);
  }

  // Keep the app's own encrypted copy, or drop it. Separate from Download above: this
  // one never touches the Proton Photos folder. The grid's watcher refreshes the badge
  // and this button, so neither needs its own reply.
  async function toggleOffline() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (isOffline) await unpinOffline([uid]);
      else await pinOffline([uid]);
    } catch {
      setError(t("offline.failed"));
    }
    setBusy(false);
  }

  // Add this photo to an album, from the right-click menu's picker.
  async function addToAlbum(albumUid: string) {
    setBusy(true);
    setError("");
    try {
      await rpc("addPhotosToAlbum", { albumUid, uids: [uid] });
      setPickingAlbum(false);
    } catch (e) {
      setError(String(e));
      setPickingAlbum(false);
    } finally {
      setBusy(false);
    }
  }

  const dims = dimensionsOf(details?.extra ?? null);

  // The photo, at the best quality that has arrived: the grid thumbnail the caller
  // already had, then the preview, then the full-resolution file. Each step waits until
  // it can be painted, so the picture only ever gets sharper and never blinks. Anything
  // still tagged with the previous photo counts as not yet arrived.
  const stillSrc = useProgressiveImage(uid, [
    fallbackUrl,
    preview?.uid === uid ? preview.url : null,
    original?.uid === uid ? original.url : null,
  ]);

  const stage: ViewerStage = isVideo
    ? {
        kind: "video",
        url: videoState === "ready" ? videoUrl : null,
        poster: stillSrc,
        note:
          videoState === "toolarge"
            ? t("viewer.videoTooLarge")
            : videoState === "error"
              ? t("viewer.videoError")
              : t("viewer.videoLoading"),
      }
    : { kind: "image", src: stillSrc, loading: loadingPreview };

  // The right-click menu on the stage: the same actions the toolbar carries, plus
  // "add to album", since the stage is where the reader spends most time.
  const menuActions: MenuAction[] = [
    {
      key: "favorite",
      label: t(fav ? "selection.unfavorite" : "selection.favorite"),
      icon: <HeartIcon size={14} filled={!!fav} />,
      disabled: fav === null || busy,
      onSelect: () => void toggleFavorite(),
    },
    ...(canEdit
      ? [
          {
            key: "edit",
            label: t("editor.edit"),
            icon: <PencilIcon size={14} />,
            disabled: busy,
            onSelect: () => setEditing(true),
          },
        ]
      : []),
    {
      key: "album",
      label: t("selection.addToAlbum"),
      icon: <LibraryAddIcon size={14} />,
      onSelect: () => setPickingAlbum(true),
    },
    {
      key: "offline",
      label: t(isOffline ? "selection.offlineRemove" : "selection.offlineAdd"),
      icon: <OfflinePinIcon size={14} />,
      disabled: busy,
      onSelect: () => void toggleOffline(),
    },
    {
      key: "download",
      label: isLocal
        ? t("viewer.freeUp")
        : explorer
          ? t("viewer.download")
          : t("viewer.saveToFolder"),
      icon: isLocal ? <CloudIcon size={14} /> : <DownloadIcon size={14} />,
      disabled: busy,
      onSelect: () => void (isLocal ? freeUp() : download()),
    },
    ...(isLocal
      ? [
          {
            key: "reveal",
            label: t("selection.showInFolder"),
            icon: <FolderOpenIcon size={14} />,
            onSelect: () => void invoke("reveal_photo", { uid }).catch(() => {}),
          },
        ]
      : []),
    {
      key: "share",
      label: t("selection.share"),
      icon: <ShareIcon size={14} />,
      onSelect: () => setSharing(true),
    },
    {
      key: "trash",
      label: t("selection.trash"),
      icon: <TrashIcon size={14} />,
      separator: true,
      danger: true,
      onSelect: () => setConfirming(true),
    },
  ];

  const downloadLabel = isLocal
    ? t("viewer.freeUp")
    : explorer
      ? t("viewer.download")
      : t("viewer.saveToFolder");

  return (
    <ViewerShell
      itemKey={uid}
      name={details?.name ?? ""}
      stage={stage}
      error={error}
      busy={busy}
      hasPrev={hasPrev}
      hasNext={hasNext}
      onPrev={onPrev}
      onNext={onNext}
      list={neighbours.list}
      onRange={neighbours.onRange}
      onClose={() => {
        if (Date.now() < suppressCloseUntil.current) return;
        onClose();
      }}
      onRename={rename}
      onVideoError={() => setVideoState("error")}
      onContextMenu={(e) => setMenuAt({ x: e.clientX, y: e.clientY })}
      onKey={(e) => {
        if (e.key === "Delete") setConfirming(true);
        else if (e.key.toLowerCase() === "f") void toggleFavorite();
        else if (e.key.toLowerCase() === "s") setSharing(true);
      }}
      toolbar={
        <>
          {/* Icons alone, named in their tooltips, as in Windows Photos: the bar keeps one
              width whatever the language. Favourite colours in when held, as a state. */}
          <button
            className={`lbx-ibtn ${fav ? "sel" : ""}`}
            disabled={busy || fav === null}
            onClick={() => void toggleFavorite()}
            title={`${fav ? t("selection.unfavorite") : t("selection.favorite")} (F)`}
            aria-label={fav ? t("selection.unfavorite") : t("selection.favorite")}
          >
            <HeartIcon size={17} filled={!!fav} />
          </button>
          {canEdit && (
            <button
              className="lbx-ibtn"
              disabled={busy}
              onClick={() => setEditing(true)}
              title={t("editor.edit")}
              aria-label={t("editor.edit")}
            >
              <PencilIcon size={16} />
            </button>
          )}
          <button
            className="lbx-ibtn"
            onClick={() => setPickingAlbum(true)}
            title={t("selection.addToAlbum")}
            aria-label={t("selection.addToAlbum")}
          >
            <LibraryAddIcon size={17} />
          </button>
          <button
            className="lbx-ibtn"
            disabled={busy}
            onClick={() => void (isLocal ? freeUp() : download())}
            title={downloadLabel}
            aria-label={downloadLabel}
          >
            {isLocal ? <CloudIcon size={17} /> : <DownloadIcon size={17} />}
          </button>
          <button
            className="lbx-ibtn"
            onClick={() => setSharing(true)}
            title={`${t("selection.share")} (S)`}
            aria-label={t("selection.share")}
          >
            <ShareIcon size={17} />
          </button>
          <button
            className="lbx-ibtn danger"
            disabled={busy}
            onClick={() => setConfirming(true)}
            title={`${t("selection.trash")} (Del)`}
            aria-label={t("selection.trash")}
          >
            <TrashIcon size={17} />
          </button>
        </>
      }
      menuItems={[
        {
          key: "offline",
          label: isOffline ? t("selection.offlineRemove") : t("selection.offlineAdd"),
          icon: <OfflinePinIcon size={14} />,
          disabled: busy,
          onSelect: () => void toggleOffline(),
        },
      ]}
      details={
        !details ? (
          <p className="lbx-dim">{t("common.loading")}</p>
        ) : (
          <dl>
            <dt>{t("viewer.name")}</dt>
            <dd>{details.name || "—"}</dd>
            <dt>{t("viewer.type")}</dt>
            <dd>{details.mediaType ?? details.type}</dd>
            {dims && (
              <>
                <dt>{t("viewer.dimensions")}</dt>
                <dd>{dims}</dd>
              </>
            )}
            <dt>{t("viewer.taken")}</dt>
            <dd>{formatDate(details.captureTime)}</dd>
            <dt>{t("viewer.added")}</dt>
            <dd>{formatDate(details.creationTime)}</dd>
            <dt>{t("viewer.modified")}</dt>
            <dd>{formatDate(details.modificationTime)}</dd>
            <dt>{t("viewer.size")}</dt>
            <dd>{formatBytes(details.size)}</dd>
            <dt>{t("viewer.onServer")}</dt>
            <dd>{formatBytes(details.storageSize)}</dd>
            <dt>{t("viewer.albums")}</dt>
            <dd>{details.albumCount}</dd>
            <dt>{t("viewer.shared")}</dt>
            <dd>
              {details.isSharedPublicly
                ? t("viewer.sharedPublic")
                : details.isShared
                  ? t("viewer.sharedPeople")
                  : t("viewer.sharedNo")}
            </dd>
            {details.sha1 && (
              <>
                <dt>SHA-1</dt>
                <dd className="lbx-mono">{details.sha1}</dd>
              </>
            )}
          </dl>
        )
      }
    >
      {menuAt && (
        <ContextMenu
          x={menuAt.x}
          y={menuAt.y}
          actions={menuActions}
          onClose={() => {
            suppressCloseUntil.current = Date.now() + 350;
            setMenuAt(null);
          }}
        />
      )}

      {pickingAlbum && (
        <AlbumPicker
          count={1}
          busy={busy}
          onPick={(albumUid) => void addToAlbum(albumUid)}
          onCancel={() => setPickingAlbum(false)}
        />
      )}

      {sharing && (
        <ShareDialog
          uid={uid}
          title={details?.name ?? ""}
          onClose={() => setSharing(false)}
          // The toolbar's share button lights up once something is shared, and the
          // details panel says so in words, so both follow the dialog.
          onChanged={() =>
            void rpc<Details>("getNodeDetails", { uid })
              .then(setDetails)
              .catch(() => {})
          }
        />
      )}

      {confirming && (
        <Confirm
          title={t("confirm.trashTitle")}
          message={t("confirm.trashName", { name: details?.name ?? t("confirm.thisPhoto") })}
          confirmLabel={t("confirm.trashConfirm")}
          danger
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            void trash();
          }}
        />
      )}

      {/* Saving writes a NEW timeline photo carrying this one's date, place and camera;
          the original is left untouched. The caller reloads so the copy appears. */}
      {editing && details && (
        <PhotoEditor
          sourceKey={uid}
          loadSource={() => cloudEditorSource(uid)}
          saveEdit={(jpeg, src) =>
            saveCloudEdit(jpeg, {
              name: details.name,
              captureTime: src.captureTime,
              camera: src.camera,
              latitude: src.latitude,
              longitude: src.longitude,
            }).then(() => null)
          }
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            onEdited?.();
          }}
        />
      )}
    </ViewerShell>
  );
}
