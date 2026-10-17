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

import { useCallback, useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useFolderMedia } from "../hooks/useFolderMedia";
import { useUploads } from "../hooks/useUploads";
import { formatBytes, formatDate, dimensionsOf } from "../lib/format";
import {
  baseName,
  canUpload,
  classifyFailure,
  decodePreview,
  deleteLocalFile,
  isMissingCodec,
  localEditorSource,
  localFileInfo,
  localFileUrl,
  looksLikeVideo,
  needsDecode,
  renameLocalFile,
  saveLocalEdit,
  toMillis,
  type LocalFileInfo,
  type OpenFailure,
} from "../lib/localFile";
import { Confirm } from "./Confirm";
import { PhotoEditor } from "./PhotoEditor";
import { ViewerShell, type ViewerStage } from "./ViewerShell";
import { PencilIcon, TrashIcon, UploadArrowIcon } from "./icons";
import { useT } from "../lib/i18n";

const APP_TITLE = "Photos for Proton";

type Props = {
  /** The file to show. Changing it swaps the viewer over to the new one. */
  path: string;
  /**
   * Which delivery this path arrived on. The viewer can be stepped along to another file
   * in the same folder, so the same path arriving a second time is a request to come back
   * to it, not the nothing that comparing the two strings would make it.
   */
  delivery?: number;
  onClose: () => void;
  /** Bring up the app, where signing in is possible. */
  onSignIn: () => void;
  /** A rename moves the file, so the caller has to follow it to the new path. */
  onRetarget: (path: string) => void;
};

/** What the engine makes of a URL, which is the only reliable way to ask. */
function engineCanDraw(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = new Image();
    probe.addEventListener("load", () => resolve(true), { once: true });
    probe.addEventListener("error", () => resolve(false), { once: true });
    probe.src = url;
  });
}

/** Something about the file itself the viewer has to say instead of drawing it. */
type MediaProblem = "nocodec" | "failed" | "videoUnsupported";

/**
 * The viewer for a file on this machine.
 *
 * It shares the whole shell with the cloud viewer and differs in exactly two
 * places: one action instead of seven, and details read off the file rather
 * than fetched from the SDK. That second difference is the point of it, because
 * it is what lets this open with nobody signed in.
 */
export function LocalViewer({ path, delivery = 0, onClose, onSignIn, onRetarget }: Props) {
  const t = useT();
  // The live path, which a rename moves. Seeded from the prop and pushed back up
  // to it, so the two never disagree about which file is on screen.
  const [current, setCurrent] = useState(path);
  const [info, setInfo] = useState<LocalFileInfo | null>(null);
  const [failure, setFailure] = useState<{ kind: OpenFailure; reason: string } | null>(null);
  const [src, setSrc] = useState<string | undefined>(undefined);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [problem, setProblem] = useState<MediaProblem | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  // Whether an upload has been asked for at all, so a record left over from
  // earlier in the session is not reported as this file's own result.
  const [sent, setSent] = useState(false);
  const [signInDismissed, setSignInDismissed] = useState(false);

  useEffect(() => {
    setCurrent(path);
    // `delivery` and not only `path`: opening the file this window was launched with a
    // second time has to bring it back, even after the folder has been stepped through.
  }, [path, delivery]);

  // Nothing here refreshes a grid: this viewer has none behind it.
  const onUploadFinished = useCallback(() => {}, []);
  const uploads = useUploads(onUploadFinished);

  // A window opened over one file still has the rest of its folder to step through, and
  // this is where that list comes from. Stepping stays inside this component: the path
  // the caller opened is not disturbed, so a rename still reports back to it as before.
  const folder = useFolderMedia(current, setCurrent);

  const name = info?.name ?? baseName(current);
  // The extension answers immediately, so the stage starts on the right branch
  // without waiting for the host; the real media type settles it once it lands.
  const isVideo = info ? info.mime.startsWith("video/") : looksLikeVideo(current);

  // The taskbar and Alt+Tab name the file being viewed, so a window opened from
  // Explorer says what it holds before it is even focused.
  useEffect(() => {
    const win = getCurrentWindow();
    void win.setTitle(`${name} - ${APP_TITLE}`).catch(() => {});
    return () => {
      void win.setTitle(APP_TITLE).catch(() => {});
    };
  }, [name]);

  useEffect(() => {
    setSent(false);
    setSignInDismissed(false);
  }, [current]);

  useEffect(() => {
    let cancelled = false;
    setInfo(null);
    setFailure(null);
    setError("");
    (async () => {
      try {
        const meta = await localFileInfo(current);
        if (!cancelled) setInfo(meta);
      } catch (e) {
        if (!cancelled) setFailure({ kind: classifyFailure(e), reason: String(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [current]);

  useEffect(() => {
    let cancelled = false;
    setSrc(undefined);
    setVideoUrl(null);
    setProblem(null);
    setLoading(true);

    (async () => {
      let url: string;
      try {
        url = await localFileUrl(current);
      } catch (e) {
        if (!cancelled) {
          setFailure({ kind: classifyFailure(e), reason: String(e) });
          setLoading(false);
        }
        return;
      }
      if (cancelled) return;

      // A video plays from the file itself. The base64 route the cloud viewer
      // uses exists only because those bytes live in the sidecar.
      if (isVideo) {
        setVideoUrl(url);
        setLoading(false);
        return;
      }

      // A format the engine draws itself paints straight from the file, and the
      // probe that follows is only the safety net for one whose extension lied.
      if (!needsDecode(current)) {
        setSrc(url);
        setLoading(false);
        if (await engineCanDraw(url)) return;
        if (cancelled) return;
        setSrc(undefined);
        setLoading(true);
      }

      try {
        const decoded = await decodePreview(current);
        if (!cancelled) {
          setSrc(decoded);
          setLoading(false);
        }
      } catch (e) {
        if (cancelled) return;
        setLoading(false);
        setProblem(isMissingCodec(e) ? "nocodec" : "failed");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [current, isVideo]);

  // A drop anywhere on the window uploads too, and that deserves the same line
  // of feedback as the button does.
  useEffect(() => {
    if (uploads.running) setSent(true);
  }, [uploads.running]);

  /**
   * The queue's record of this file. Matching on the name rather than counting
   * is what keeps an earlier upload in the same session from being read as this
   * one's result; the last match is always the most recent.
   */
  const queued = useMemo(() => {
    const items = uploads.status.items;
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].name === name) return items[i];
    }
    return null;
  }, [uploads.status, name]);

  // Uploading needs an account, and this viewer deliberately does not have one,
  // so the refusal becomes an offer to sign in rather than an error nobody can act on.
  const needsSignIn = /not signed in/i.test(uploads.error) && !signInDismissed;

  const uploadable = canUpload(current);

  function upload() {
    setSent(true);
    setSignInDismissed(false);
    void uploads.start([current]);
  }

  /**
   * Send the open file to the recycle bin, then move off it.
   *
   * Stepping to a neighbour rather than closing, because the viewer walks the folder
   * and clearing one file out of the way is a thing done mid-walk. Only the last file
   * in the folder closes it, since by then there is nothing left to be looking at.
   *
   * "cancelled" comes back when the shell warned that the file could not be recycled
   * and the answer was no. Nothing was deleted, so nothing moves and nothing is said.
   */
  async function remove() {
    setConfirmDelete(false);
    setBusy(true);
    setError("");
    try {
      await deleteLocalFile(current);
      if (folder.hasNext) folder.next();
      else if (folder.hasPrev) folder.prev();
      else onClose();
    } catch (e) {
      if (String(e).includes("cancelled")) return;
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  /** Rethrows so the shell keeps the editor open on a name the file system refused. */
  async function rename(next: string) {
    setBusy(true);
    setError("");
    try {
      const moved = await renameLocalFile(current, next);
      setCurrent(moved);
      onRetarget(moved);
    } catch (e) {
      setError(String(e));
      throw e;
    } finally {
      setBusy(false);
    }
  }

  const problemText =
    problem === "nocodec"
      ? t("local.noCodec")
      : problem === "videoUnsupported"
        ? t("local.videoUnsupported")
        : problem === "failed"
          ? // Not the same thing as a file that would not open: this one opened, and the
            // picture inside it is what the decoder could make nothing of.
            t("local.decodeFailed")
          : null;

  const failureText =
    failure?.kind === "missing"
      ? t("local.notFound")
      : failure?.kind === "unreadable"
        ? t("local.unreadable")
        : t("local.openFailed");

  const stage: ViewerStage = failure
    ? {
        kind: "message",
        text: failureText,
        detail: failure.kind === "unknown" ? failure.reason : current,
      }
    : isVideo
      ? { kind: "video", url: videoUrl, note: problemText ?? t("viewer.videoLoading") }
      : problemText && !src
        ? { kind: "message", text: problemText }
        : { kind: "image", src, loading };

  // Editing is offered only for a still image that has actually drawn: never a video, a
  // file that would not open, or one still resolving.
  const canEdit = !failure && !isVideo && stage.kind === "image" && !!src;

  const notice =
    !sent || needsSignIn
      ? null
      : queued?.status === "done"
        ? t("local.uploaded")
        : queued?.status === "skipped"
          ? t("local.uploadSkipped")
          : queued?.status === "failed"
            ? t("local.uploadFailed")
            : uploads.running || !queued
              ? t("local.uploading")
              : null;

  const uploadLabel = uploadable ? t("local.upload") : t("local.uploadUnsupported");
  const captureTime = toMillis(info?.captureTime);
  const dims = dimensionsOf(info ? { width: info.width, height: info.height } : null);

  return (
    <ViewerShell
      // The file on screen, not the one the window was opened with: stepping through the
      // folder has to reset the fit and drop a half-typed rename, exactly as arriving at
      // a new file from Explorer does.
      itemKey={current}
      name={name}
      stage={stage}
      error={error || (needsSignIn ? "" : uploads.error)}
      busy={busy}
      list={folder.list}
      onRange={folder.onRange}
      hasPrev={folder.hasPrev}
      hasNext={folder.hasNext}
      onPrev={folder.prev}
      onNext={folder.next}
      onClose={onClose}
      // This viewer is the whole of its window, so there is no app title bar to move
      // it by or close it with: its own bar has to be both.
      ownsWindow
      onRename={rename}
      onVideoError={() => {
        setVideoUrl(null);
        setProblem("videoUnsupported");
      }}
      toolbar={
        // The reason this is unavailable is the whole point of the label, and the
        // button carrying it is disabled in exactly that case. The engine draws no
        // tooltip on a disabled control, so the title sits on a wrapper that is
        // never disabled and the button keeps its own accessible name.
        <>
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
          <span className="lbx-ibtn-wrap" title={uploadLabel}>
            <button
              className="lbx-ibtn"
              disabled={busy || !uploadable}
              onClick={upload}
              aria-label={uploadLabel}
            >
              <UploadArrowIcon size={17} />
            </button>
          </span>
          <button
            className="lbx-ibtn"
            disabled={busy || !!failure}
            onClick={() => setConfirmDelete(true)}
            title={t("local.delete")}
            aria-label={t("local.delete")}
          >
            <TrashIcon size={17} />
          </button>
        </>
      }
      details={
        !info ? (
          <p className="lbx-dim">{failure ? failureText : t("common.loading")}</p>
        ) : (
          <dl>
            <dt>{t("viewer.name")}</dt>
            <dd>{info.name || "—"}</dd>
            <dt>{t("viewer.type")}</dt>
            <dd>{info.mime || "—"}</dd>
            {dims && (
              <>
                <dt>{t("viewer.dimensions")}</dt>
                <dd>{dims}</dd>
              </>
            )}
            {captureTime && (
              <>
                <dt>{t("viewer.taken")}</dt>
                <dd>{formatDate(captureTime)}</dd>
              </>
            )}
            {info.camera && (
              <>
                <dt>{t("local.camera")}</dt>
                <dd>{info.camera}</dd>
              </>
            )}
            <dt>{t("viewer.modified")}</dt>
            <dd>{formatDate(toMillis(info.modified))}</dd>
            <dt>{t("local.created")}</dt>
            <dd>{formatDate(toMillis(info.created))}</dd>
            <dt>{t("viewer.size")}</dt>
            <dd>{formatBytes(info.size)}</dd>
            <dt>{t("local.path")}</dt>
            <dd className="lbx-mono">{info.path}</dd>
          </dl>
        )
      }
    >
      {notice && (
        <div className="lbx-notice" onClick={(e) => e.stopPropagation()}>
          {notice}
        </div>
      )}

      {needsSignIn && (
        <Confirm
          title={t("local.signInTitle")}
          message={t("local.signInBody")}
          confirmLabel={t("local.signInAction")}
          onCancel={() => setSignInDismissed(true)}
          // The app comes up in its own window and this one stays as it is, so the
          // dialog goes: it has been answered, and the file behind it is still here.
          onConfirm={() => {
            setSignInDismissed(true);
            onSignIn();
          }}
        />
      )}

      {confirmDelete && (
        <Confirm
          title={t("local.deleteTitle")}
          message={t("local.deleteMessage", { name })}
          confirmLabel={t("local.delete")}
          danger
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => void remove()}
        />
      )}

      {/* Over the whole viewer while it is up. Saving writes a new copy beside the
          original, so the viewer is retargeted onto it, exactly as a rename does. */}
      {editing && (
        <PhotoEditor
          sourceKey={current}
          loadSource={() => localEditorSource(current)}
          saveEdit={(jpegBase64) => saveLocalEdit(current, jpegBase64)}
          onClose={() => setEditing(false)}
          onSaved={(p) => {
            setEditing(false);
            if (p) {
              setCurrent(p);
              onRetarget(p);
            }
          }}
        />
      )}
    </ViewerShell>
  );
}
