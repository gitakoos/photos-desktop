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

import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { requestThumbnail } from "../hooks/useFolderMedia";
import { clearImportThumbnails, requestImportThumbnail } from "../lib/importThumbs";
import { isWindows } from "../lib/platform";

/** The system draws a file's picture on Windows; elsewhere the sidecar draws it from the export. */
const askThumbnail = isWindows ? requestThumbnail : requestImportThumbnail;
import type { ImportState, ReviewCheck, ReviewItem, ReviewReason } from "../hooks/useUploads";
import { locale } from "../lib/format";
import { VirtualSections } from "./VirtualSections";
import { useT } from "../lib/i18n";
import { CheckIcon, CloseIcon, HeartIcon, MotionPhotoIcon, PlayArrowIcon } from "./icons";
import "../styles/AlbumAddPhotos.css";
import "../styles/ImportReview.css";

type Props = {
  items: ReviewItem[];
  checks: ReviewCheck[];
  reasons: (ReviewReason | null)[];
  progress: ImportState | undefined;
  /** `probable`: upload every item probably in the library already too; `upload`: just these. */
  onConfirm: (exclude: number[], albums: boolean, probable: boolean, upload: number[]) => void;
  onDiscard: () => void;
};

/** The tile size of the album picker, which this sits beside in look and use. */
const CELL = 148;

/** A capture date as a tile shows it: the day, in the reader's own format. */
function dayOf(ms: number | undefined): string | null {
  return ms ? new Date(ms).toLocaleDateString(locale) : null;
}

/**
 * The step between picking an export and uploading it, as on Android, in the album
 * picker's frame: everything the export holds, by the album it goes into, each with the
 * day it will be filed under. Every item starts ticked; a click leaves one out and a
 * second puts it back, Shift+click does a run. A Live Photo is one tile, and uploads as
 * one. Nothing uploads until the import button.
 */
export function ImportReview({ items, checks, reasons, progress, onConfirm, onDiscard }: Props) {
  const t = useT();
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [albums, setAlbums] = useState(true);
  // What is probably in the library already stays out unless asked for; only the new ones on
  // screen, to look them over before they go up.
  const [uploadProbable, setUploadProbable] = useState(false);
  // The probable ones picked one by one to upload anyway.
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [onlyNew, setOnlyNew] = useState(false);
  const [copied, setCopied] = useState(false);
  // Checked by name and bytes only (the library's content hashes could not be had): a renamed
  // copy is not found that way, so Import waits for a yes.
  const [weakOk, setWeakOk] = useState(false);
  // The pictures belong to this export: gone with the review.
  useEffect(() => () => clearImportThumbnails(), []);
  const anchor = useRef<number | null>(null);

  const albumCount = useMemo(
    () => new Set(items.flatMap((i) => [i.album, ...(i.alsoIn ?? [])]).filter(Boolean)).size,
    [items],
  );
  const liveCount = useMemo(() => items.filter((i) => i.live).length, [items]);

  // One section per album, the timeline's first; with albums off, one section for all.
  // A photo copied into several albums shows in each, since it will be in each, and is
  // still one item: counted once, and left out everywhere by one click.
  const shown = useMemo(
    () => (onlyNew ? items.filter((i) => checks[i.id] !== "already" && checks[i.id] !== "probable") : items),
    [items, checks, onlyNew],
  );
  const sections = useMemo(() => {
    if (!albums || albumCount === 0) return [{ album: null as string | null, list: shown }];
    const byAlbum = new Map<string, ReviewItem[]>();
    for (const item of shown) {
      for (const key of [item.album ?? "", ...(item.alsoIn ?? [])]) {
        const list = byAlbum.get(key);
        if (list) list.push(item);
        else byAlbum.set(key, [item]);
      }
    }
    const timeline = byAlbum.get("") ?? [];
    byAlbum.delete("");
    return [
      ...(timeline.length > 0 ? [{ album: null as string | null, list: timeline }] : []),
      ...[...byAlbum.entries()].map(([album, list]) => ({ album: album as string | null, list })),
    ];
  }, [shown, albums, albumCount]);
  const order = useMemo(() => sections.flatMap((s) => s.list.map((i) => i.id)), [sections]);
  const virtualSections = useMemo(
    () => sections.map((s) => ({ key: s.album ?? "", items: s.list })),
    [sections],
  );
  const headed = sections.length > 1 || sections[0]?.album !== null;

  const checking = (progress?.checked ?? 0) < (progress?.items ?? items.length);
  const summary = [
    t("importReview.statItems", { n: items.length }),
    ...(albumCount > 0 ? [t("importReview.statAlbums", { n: albumCount })] : []),
    ...(liveCount > 0 ? [t("importReview.statLive", { n: liveCount })] : []),
    ...(checking
      ? [t("importReview.checking", { done: progress?.checked ?? 0, total: progress?.items ?? items.length })]
      : [
          t("importReview.statAlready", { n: progress?.already ?? 0 }),
          ...((progress?.probable ?? 0) > 0 ? [t("importReview.statProbable", { n: progress?.probable ?? 0 })] : []),
        ]),
  ].join(" · ");
  const kept = items.length - excluded.size;
  const probableCount = progress?.probable ?? 0;

  /** The review as text, one line per item: what the check found, why, its album and name. */
  async function copyList() {
    const lines = items.map((i) => {
      const check = checks[i.id] ?? "pending";
      const why = reasons[i.id];
      const out = excluded.has(i.id) ? "left out" : "";
      const plain = (text: string) => text.replace(/[\t\r\n]+/g, " ");
      return [check, why ?? "", out, plain([i.album, ...(i.alsoIn ?? [])].filter(Boolean).join(", ")), plain(i.name)].join("\t");
    });
    try {
      await navigator.clipboard.writeText(["check\treason\tchoice\talbums\tname", ...lines].join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* nothing to copy into */
    }
  }

  function toggle(id: number, e: MouseEvent) {
    // A probable one is picked to upload anyway, or unpicked.
    if (checks[id] === "probable" && !e.shiftKey) {
      setChosen((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      return;
    }
    const from = e.shiftKey && anchor.current !== null ? order.indexOf(anchor.current) : -1;
    const to = order.indexOf(id);
    setExcluded((prev) => {
      const next = new Set(prev);
      if (from >= 0 && to >= 0) {
        // A run follows the item it started from: left out together, or back together.
        const leave = prev.has(anchor.current!);
        const [lo, hi] = from < to ? [from, to] : [to, from];
        for (let i = lo; i <= hi; i++) {
          if (leave) next.add(order[i]);
          else next.delete(order[i]);
        }
      } else if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    anchor.current = id;
  }

  return (
    <div className="ap-veil">
      <div className="ap-card" onContextMenu={(e) => e.preventDefault()}>
        <div className="ap-head">
          <span className="ap-title">{t("importReview.title")}</span>
          <span className="ap-sub">{summary}</span>
          <span className="ap-spacer" />
          <button className="ap-x" onClick={onDiscard} title={t("importReview.discard")}>
            <CloseIcon size={16} />
          </button>
        </div>

        <div className="ap-body">
          {/* Only the rows near the view are built: an export can hold thousands. */}
          <VirtualSections
            scroller=".ap-body"
            sections={virtualSections}
            cellSize={CELL}
            header={
              headed
                ? (section) => (
                    <div className="g-monthhdr">
                      <span className="g-monthtitle">{section.key || t("importReview.timeline")}</span>
                      <span className="g-monthcount">{section.items.length}</span>
                    </div>
                  )
                : undefined
            }
            grid={(_, list) => (
              <div
                className="g-grid"
                style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${CELL}px, 1fr))` }}
              >
                {list.map((item) => (
                  <ReviewCell
                    key={item.id}
                    item={item}
                    check={checks[item.id]}
                    reason={reasons[item.id] ?? null}
                    kept={
                      checks[item.id] === "probable"
                        ? uploadProbable || chosen.has(item.id)
                        : !excluded.has(item.id)
                    }
                    onClick={(e) => toggle(item.id, e)}
                  />
                ))}
              </div>
            )}
          />
        </div>

        {progress?.byContent === false && !checking && (
          <div className="ir-warn">
            <span>{t("importReview.noContentCheck")}</span>
            <label className="ir-option">
              <input type="checkbox" className="st-switch" checked={weakOk} onChange={(e) => setWeakOk(e.currentTarget.checked)} />
              <span>{t("importReview.importAnyway")}</span>
            </label>
          </div>
        )}
        <div className="ap-foot ir-foot">
          {albumCount > 0 && (
            <label className="ir-option">
              <input
                type="checkbox"
                className="st-switch"
                checked={albums}
                onChange={(e) => setAlbums(e.currentTarget.checked)}
              />
              <span>{t("importReview.albumsToggle")}</span>
            </label>
          )}
          {probableCount > 0 && (
            <label className="ir-option" title={t("importReview.uploadProbableDesc")}>
              <input
                type="checkbox"
                className="st-switch"
                checked={uploadProbable}
                onChange={(e) => setUploadProbable(e.currentTarget.checked)}
              />
              <span>{t("importReview.uploadProbable", { n: probableCount })}</span>
            </label>
          )}
          <label className="ir-option">
            <input
              type="checkbox"
              className="st-switch"
              checked={onlyNew}
              onChange={(e) => setOnlyNew(e.currentTarget.checked)}
            />
            <span>{t("importReview.onlyNew")}</span>
          </label>
          <span className="ap-spacer" />
          <span className="ir-hint">{t("importReview.hint")}</span>
          <button className="ap-cancel" disabled={checking} onClick={() => void copyList()}>
            {copied ? t("importReview.copied") : t("importReview.copyList")}
          </button>
          <button className="ap-cancel" onClick={onDiscard}>
            {t("common.cancel")}
          </button>
          {/* Held until the check is done: confirmed early, an item not checked yet could go
              up although the library has it. */}
          <button
            className="ap-add"
            disabled={kept === 0 || checking || (progress?.byContent === false && !weakOk)}
            title={checking ? t("importReview.waitForCheck") : undefined}
            onClick={() => onConfirm([...excluded], albums, uploadProbable, [...chosen])}
          >
            {t("importReview.confirm", { n: kept })}
          </button>
        </div>
      </div>
    </div>
  );
}

/** One item, drawn like a timeline tile: its picture once on screen, a tick while kept. */
function ReviewCell({
  item,
  check,
  reason,
  kept,
  onClick,
}: {
  item: ReviewItem;
  check: ReviewCheck | undefined;
  reason: ReviewReason | null;
  kept: boolean;
  onClick: (e: MouseEvent) => void;
}) {
  const already = check === "already";
  const probable = check === "probable";
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string | null>(null);

  // Asked for only near the screen, and let go far from it: an export can hold tens of
  // thousands of files, and only what is in view should hold a picture.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let stop: (() => void) | undefined;
    const seen = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          if (!stop) stop = askThumbnail(item.path, setUrl);
        } else if (stop) {
          stop();
          stop = undefined;
          setUrl(null);
        }
      },
      { rootMargin: "600px" },
    );
    seen.observe(el);
    return () => {
      seen.disconnect();
      stop?.();
    };
  }, [item.path]);

  const day = dayOf(item.takenMs);
  const albumsOf = [item.album, ...(item.alsoIn ?? [])].filter(Boolean).join(", ");
  const name = [
    item.live ? `${item.name} + ${item.live.name}` : item.name,
    ...(day ? [day] : []),
    ...(item.alsoIn?.length ? [`${t("viewer.albums")}: ${albumsOf}`] : []),
    ...(reason ? [t(`importReview.why.${reason}`)] : []),
    ...(probable ? [t("importReview.probableClick")] : []),
  ].join("\n");
  return (
    <div
      ref={ref}
      className={`g-cell ir-cell${kept ? " kept" : " out"}`}
      onClick={onClick}
      title={name}
    >
      {/* Shown once it has loaded, as every grid tile's picture is (see `.g-cell img`). */}
      {url ? (
        <img
          src={url}
          alt=""
          draggable={false}
          onLoad={(e) => {
            e.currentTarget.dataset.ok = "1";
          }}
        />
      ) : (
        <div className="g-cell-ph" />
      )}

      <span className="g-seldot">{kept ? <CheckIcon size={11} /> : null}</span>

      {item.video && (
        <div className="g-play">
          <PlayArrowIcon size={17} />
        </div>
      )}

      <div className="g-badgerow">
        <span className={`g-tilebadge ir-day${day ? "" : " none"}`}>{day ?? t("importReview.noDate")}</span>
        {already && <span className="g-tilebadge ir-already">{t("importReview.alreadyBadge")}</span>}
        {probable && <span className="g-tilebadge ir-probable">{t("importReview.probableBadge")}</span>}
      </div>

      {(item.live || item.favorite) && (
        <div className="g-tilebadge g-typepill">
          {item.favorite && (
            <span title={t("badge.favorite")}>
              <HeartIcon size={11} filled />
            </span>
          )}
          {item.live && (
            <span title={t("importReview.liveJoined")}>
              <MotionPhotoIcon size={11} />
            </span>
          )}
        </div>
      )}
    </div>
  );
}
