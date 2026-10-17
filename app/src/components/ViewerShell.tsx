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

import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { setLightboxOpen } from "../lib/lightboxSignal";
import { PhotoViewer } from "./PhotoViewer";
import { ViewerContents, ViewerFilmstrip } from "./ViewerFilmstrip";
import { VideoControls } from "./VideoControls";
import { WindowButtons } from "./Titlebar";
import { ContextMenu, type MenuAction } from "./ContextMenu";
import { CloseIcon, InfoIcon, ListIcon, MoreHorizIcon } from "./icons";
import { useT } from "../lib/i18n";
import "../styles/Lightbox.css";

/** What the stage draws, which is the whole of what the two viewers disagree on. */
export type ViewerStage =
  | { kind: "image"; src?: string; loading?: boolean }
  /** `url` null means the video cannot play yet, and `note` says why. */
  | { kind: "video"; url: string | null; poster?: string; note?: string | null }
  /** Nothing to draw, only something to say: the file would not open at all. */
  | { kind: "message"; text: string; detail?: string };

/** One neighbour, as little of it as the strip and the contents list need. */
export type ViewerItem = {
  /** Stable identity: a uid in Proton, a path on this disk. */
  key: string;
  name?: string;
  /** Bytes, or null when the source knows there is no answer rather than none yet. */
  size?: number | null;
  video?: boolean;
};

/**
 * What the viewer is stepping through, however the caller happens to hold it.
 *
 * Deliberately not an array. The cloud viewer has its whole list in hand already, but a
 * folder on disk is read a page at a time and may hold fifty thousand files, so the
 * contract is "how many, which one, and what is at index i", which both can answer and
 * only one of them could answer by handing over everything at once.
 *
 * `at` returning undefined means that page has not arrived, not that the item is missing.
 */
export type ViewerList = {
  count: number;
  index: number;
  at: (i: number) => ViewerItem | undefined;
  /**
   * Subscribe to one item's picture; the returned function unsubscribes. Called as a
   * tile appears and dropped as it leaves, so it must be stable across renders.
   */
  thumb: (key: string, cb: (url: string | null) => void) => () => void;
  go: (i: number) => void;
};

type Props = {
  /**
   * Which item is on the stage. The fit resets on a change and a half-typed
   * rename is dropped, so it must name the item rather than the source: one
   * item goes through several sources as it upgrades to full resolution.
   */
  itemKey: string;
  /** Shown in the middle of the bar, and the thing the rename edits. */
  name: string;
  stage: ViewerStage;
  /** The caller's own named actions along the bar. */
  toolbar?: ReactNode;
  /** Extra entries for the bar's overflow menu, below the built-in Details and Contents. */
  menuItems?: MenuAction[];
  /**
   * The rows of the details panel. Giving anything at all is what puts the
   * details button in the bar, so a caller still fetching them passes its own
   * loading line rather than nothing.
   */
  details?: ReactNode;
  error?: string;
  busy?: boolean;
  hasPrev?: boolean;
  hasNext?: boolean;
  onPrev?: () => void;
  onNext?: () => void;
  /**
   * The neighbours, for the filmstrip and the contents list. Both are absent when this
   * is, which is what a viewer over a single item wants.
   */
  list?: ViewerList | null;
  /** The range the strip and the list are showing, so the caller can fetch behind them. */
  onRange?: (from: number, to: number) => void;
  onClose: () => void;
  /**
   * Whether this viewer is the whole of what its window shows.
   *
   * A viewer over the app covers everything, the app's own title bar included, and
   * closing gives it back. A viewer that IS the window has no title bar behind it,
   * so this bar has to be one: the region that drags the window, and the controls
   * that minimise, maximise and close it. Its own round close goes in that case
   * rather than sitting beside a second one that does the same thing.
   */
  ownsWindow?: boolean;
  /**
   * Rename the item. Rejecting keeps the editor open with what was typed, which
   * is what a caller wants when the rename itself failed.
   */
  onRename?: (name: string) => void | Promise<void>;
  /** Keys this shell did not claim, for the caller's own shortcuts. */
  onKey?: (e: KeyboardEvent) => void;
  onVideoError?: () => void;
  /** Right-click on the stage, so the caller can raise a context menu. Called with the
   *  native menu already prevented and the shell's own dead menu suppressed. */
  onContextMenu?: (e: MouseEvent) => void;
  /** Dialogs and notices that belong over the whole viewer. */
  children?: ReactNode;
};

/**
 * Everything a viewer has that is not its source: the stage, the navigation,
 * the keyboard shell, the title with its rename, and the details panel around
 * rows somebody else supplies.
 *
 * Both viewers are this component with a different toolbar and a different
 * place the details come from. A cloud photo reads them back from the SDK; a
 * file on this machine reads them off the file, which is why the second one can
 * open with nobody signed in.
 */
export function ViewerShell({
  itemKey,
  name,
  stage,
  toolbar,
  menuItems,
  details,
  error,
  busy = false,
  hasPrev = false,
  hasNext = false,
  onPrev,
  onNext,
  list,
  onRange,
  onClose,
  ownsWindow = false,
  onRename,
  onKey,
  onVideoError,
  onContextMenu,
  children,
}: Props) {
  const t = useT();
  const [showDetails, setShowDetails] = useState(false);
  const [showContents, setShowContents] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState("");
  // State rather than a ref: the controls are a child, and this is what tells them
  // the element exists once it has mounted.
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const [moreAt, setMoreAt] = useState<{ x: number; y: number } | null>(null);
  // A click that dismisses the overflow menu lands on the backdrop the instant after, so
  // this brief window swallows it: the menu closing must never also close the viewer.
  const closeGuard = useRef(0);
  const guardedClose = () => {
    if (Date.now() < closeGuard.current) return;
    onClose();
  };

  // While a viewer is up it owns the single sidecar channel: the background grid
  // and eager loaders read this and hold off starting a new thumbnail batch, so
  // an item opening (and its neighbours) never queues behind one.
  useEffect(() => {
    setLightboxOpen(true);
    return () => setLightboxOpen(false);
  }, []);

  // A name typed against the item just stepped away from must not be carried on
  // to the next one.
  useEffect(() => {
    setRenaming(false);
  }, [itemKey]);

  // No dependency list: every handler below closes over the current props, and
  // re-binding each render is what keeps them from going stale.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (renaming) {
        if (e.key === "Escape") setRenaming(false);
        return;
      }
      // Escape takes back the last thing opened, and only closes the viewer once
      // nothing is over it: dismissing a panel is what the key is for while one is up.
      if (e.key === "Escape") {
        if (showContents) setShowContents(false);
        else if (showDetails) setShowDetails(false);
        else onClose();
      } else if (e.key === "ArrowRight" && hasNext) onNext?.();
      else if (e.key === "ArrowLeft" && hasPrev) onPrev?.();
      else if (e.key.toLowerCase() === "i" && details) setShowDetails((s) => !s);
      else if (e.key.toLowerCase() === "l" && list) setShowContents((s) => !s);
      else onKey?.(e);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  async function commitRename() {
    const next = draftName.trim();
    if (!next || next === name) {
      setRenaming(false);
      return;
    }
    try {
      await onRename?.(next);
      setRenaming(false);
    } catch {
      /* the caller reports it; the editor stays open to try again */
    }
  }

  const strip = list && list.count > 1;

  // The bar's overflow menu: the contents list the shell owns, then whatever the caller
  // adds. Details has its own button on the bar, as in Windows Photos.
  const moreActions: MenuAction[] = [
    ...(list && list.count > 1
      ? [
          {
            key: "contents",
            label: t("viewer.contents"),
            icon: <ListIcon size={14} />,
            onSelect: () => setShowContents((s) => !s),
          },
        ]
      : []),
    ...(menuItems ?? []),
  ];

  return (
    <div
      className={`lbx${ownsWindow ? " owns-window" : ""}${strip ? " with-strip" : ""}${
        showDetails && details ? " with-aside" : ""
      }`}
      onClick={guardedClose}
    >
      {/* The attribute has to sit on whatever the pointer actually lands on, which
          is why the bar carries it and the controls on it do not: a button is its
          own target, so it stays a button rather than a handful of the window. */}
      <div
        className="lbx-bar"
        data-tauri-drag-region={ownsWindow || undefined}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Three fixed zones, as in Windows Photos: the name on the left, the actions in
            the middle, close on the right. The name never moves with how many actions a
            photo has, because it no longer shares their column. */}
        <div className="lbx-left">
          {renaming ? (
            <input
              autoFocus
              className="lbx-rename"
              value={draftName}
              onChange={(e) => setDraftName(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void commitRename();
              }}
              onBlur={() => setRenaming(false)}
            />
          ) : (
            <button
              className="lbx-title"
              title={onRename && name ? t("viewer.rename") : name}
              disabled={!onRename || !name || busy}
              onClick={() => {
                setDraftName(name);
                setRenaming(true);
              }}
            >
              {name || "…"}
            </button>
          )}
          {list && list.count > 1 && (
            <span className="lbx-position">
              {t("viewer.position", { n: list.index + 1, total: list.count })}
            </span>
          )}
        </div>

        <div className="lbx-center">
          {toolbar}
          {details && (
            <>
              <span className="lbx-sep" />
              <button
                className={`lbx-ibtn ${showDetails ? "sel" : ""}`}
                onClick={() => setShowDetails((s) => !s)}
                title={t("viewer.detailsShortcut")}
                aria-label={t("viewer.details")}
              >
                <InfoIcon size={17} />
              </button>
            </>
          )}
          {moreActions.length > 0 && (
            <button
              className={`lbx-ibtn ${showContents ? "sel" : ""}`}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setMoreAt({ x: r.left, y: r.bottom + 4 });
              }}
              title={t("albums.more")}
              aria-label={t("albums.more")}
            >
              <MoreHorizIcon size={17} />
            </button>
          )}
        </div>

        <div className="lbx-right">
          {ownsWindow ? (
            <WindowButtons />
          ) : (
            <button className="lbx-ibtn" onClick={onClose} title={t("viewer.closeShortcut")}>
              <CloseIcon />
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="lbx-error" onClick={(e) => e.stopPropagation()}>
          {error}
        </div>
      )}

      <div
        className="lbx-stage"
        onClick={guardedClose}
        onContextMenu={
          onContextMenu &&
          ((e) => {
            e.preventDefault();
            // Stop it here so the shell's document listener does not also answer this
            // right-click with its own (Reload / More soon) menu behind the viewer.
            e.stopPropagation();
            onContextMenu(e);
          })
        }
      >
        {hasPrev && (
          <button
            className="lbx-nav prev"
            onClick={(e) => {
              e.stopPropagation();
              onPrev?.();
            }}
            title={t("viewer.prev")}
          >
            ‹
          </button>
        )}

        {stage.kind === "video" ? (
          stage.url ? (
            /* No `controls`: the bar below is the player, and it draws what the Android
               viewer draws rather than what this browser happens to. The two blocks that
               remain were always about the offers around that bar rather than the bar
               itself. A photo from Drive plays from a blob, but a file opened from
               Explorer plays from a real URL, and picture-in-picture and the video's own
               menu each led out of the app with a copy of a file already on the disk.

               The element is handed up as state rather than held in a ref, so the
               controls are given the real thing on the render after it mounts. */
            <>
              <video
                className="lbx-video"
                ref={setVideoEl}
                src={stage.url}
                poster={stage.poster}
                disablePictureInPicture
                onContextMenu={(e) => e.preventDefault()}
                autoPlay
                onClick={(e) => e.stopPropagation()}
                onError={onVideoError}
              />
              <VideoControls video={videoEl} />
            </>
          ) : (
            <div className="lbx-video-fallback" onClick={(e) => e.stopPropagation()}>
              {stage.poster && <img className="lbx-video-poster" src={stage.poster} alt="" />}
              {stage.note && <div className="lbx-video-note">{stage.note}</div>}
            </div>
          )
        ) : stage.kind === "message" ? (
          <div className="lbx-stage-msg" onClick={(e) => e.stopPropagation()}>
            <p className="lbx-stage-msg-text">{stage.text}</p>
            {stage.detail && <p className="lbx-stage-msg-detail">{stage.detail}</p>}
          </div>
        ) : (
          <PhotoViewer src={stage.src} loading={stage.loading} photoKey={itemKey} />
        )}

        {hasNext && (
          <button
            className="lbx-nav next"
            onClick={(e) => {
              e.stopPropagation();
              onNext?.();
            }}
            title={t("viewer.next")}
          >
            ›
          </button>
        )}
      </div>

      {list && strip && <ViewerFilmstrip list={list} onRange={onRange} />}

      {showContents && list && (
        <ViewerContents list={list} onRange={onRange} onClose={() => setShowContents(false)} />
      )}

      {showDetails && details && (
        // Docked beside the picture, which narrows to make room, as Windows Photos does.
        // Stopped here: the whole viewer closes on a click, and a click in this panel is
        // never meant to take the photo with it.
        <aside className="lbx-aside" onClick={(e) => e.stopPropagation()}>
          <div className="lbx-details-head">
            <h3>{t("viewer.details")}</h3>
            <button
              className="lbx-ibtn"
              onClick={() => setShowDetails(false)}
              title={t("common.close")}
              aria-label={t("common.close")}
            >
              <CloseIcon size={14} />
            </button>
          </div>
          {details}
        </aside>
      )}

      {moreAt && (
        <ContextMenu
          x={moreAt.x}
          y={moreAt.y}
          actions={moreActions}
          onClose={() => {
            closeGuard.current = Date.now() + 350;
            setMoreAt(null);
          }}
        />
      )}

      {children}
    </div>
  );
}
