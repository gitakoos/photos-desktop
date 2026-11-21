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
import { rpc } from "../lib/rpc";
import { cachedPreview, loadPreview, prefetchPreviews } from "../lib/previewStore";
import { cachedThumbnail, thumbUrl } from "../lib/thumbStore";
import { clipBlob } from "../lib/motion";
import {
  SLIDE_IDLE_MS,
  SLIDE_SECONDS,
  readSlideSeconds,
  slideDurationMs,
  slideProgress,
  slidesAhead,
  stepSlide,
  writeSlideSeconds,
} from "../lib/slideshow";
import { useT } from "../lib/i18n";
import type { CloudItem } from "../hooks/useCloudMedia";
import { ChevronLeftIcon, ChevronRightIcon, CloseIcon, PauseIcon, PlayArrowIcon } from "./icons";
import "../styles/Slideshow.css";

type VideoState = "none" | "loading" | "playing" | "failed";

/** The best picture of a photo already at hand: the preview, else the grid thumbnail. */
function sourceAtHand(uid: string): string | null {
  return cachedPreview(uid) ?? cachedThumbnail(uid) ?? thumbUrl(uid) ?? null;
}

/**
 * One photo as a slide. The grid's thumbnail is up at once and the large preview replaces it
 * when it arrives; `onShown` fires when something is on screen, which is what starts the
 * slide's time, so a slow photo is never moved on from before it was seen.
 */
function SlideImage({ uid, onShown }: { uid: string; onShown?: () => void }) {
  const [src, setSrc] = useState<string | null>(() => sourceAtHand(uid));
  const shownRef = useRef(false);
  const onShownRef = useRef(onShown);
  onShownRef.current = onShown;
  const report = useCallback(() => {
    if (shownRef.current) return;
    shownRef.current = true;
    onShownRef.current?.();
  }, []);

  useEffect(() => {
    let live = true;
    void loadPreview(uid).then((url) => {
      if (!live) return;
      if (url) setSrc(url);
      else if (!sourceAtHand(uid)) report();
    });
    return () => {
      live = false;
    };
  }, [uid, report]);

  return src ? <img className="ss-pic" src={src} alt="" draggable={false} onLoad={report} onError={report} /> : null;
}

/** A video slide: played muted from its bytes until it ends. Falls back to the photo's picture. */
function SlideVideo({
  uid,
  playing,
  onState,
  onEnded,
}: {
  uid: string;
  playing: boolean;
  onState: (state: VideoState) => void;
  onEnded: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const ref = useRef<HTMLVideoElement | null>(null);
  const stateRef = useRef(onState);
  stateRef.current = onState;

  useEffect(() => {
    let live = true;
    let made: string | null = null;
    stateRef.current("loading");
    void rpc<{ base64: string; mime: string }>("getVideo", { uid }).then(
      (v) => {
        if (!live) return;
        made = URL.createObjectURL(clipBlob(v));
        setUrl(made);
        stateRef.current("playing");
      },
      () => live && stateRef.current("failed"),
    );
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [uid]);

  useEffect(() => {
    const video = ref.current;
    if (!video || !url) return;
    if (playing) void video.play().catch(() => {});
    else video.pause();
  }, [playing, url]);

  if (!url) return null;
  return (
    <video
      ref={ref}
      className="ss-pic ss-video"
      src={url}
      muted
      autoPlay
      playsInline
      disablePictureInPicture
      onEnded={onEnded}
      onError={() => stateRef.current("failed")}
    />
  );
}

/**
 * A full-window slideshow over the list the viewer walks.
 *
 * Photos stay for the chosen time, and a video plays muted to its end (at most a minute)
 * before the show moves on. The show loops. Moving the mouse brings the bar back for a
 * moment; Escape leaves and hands back the photo it stopped on.
 */
export function Slideshow({
  items,
  start,
  onExit,
}: {
  items: CloudItem[];
  start: number;
  onExit: (index: number) => void;
}) {
  const t = useT();
  const count = items.length;
  const [index, setIndex] = useState(() => Math.min(Math.max(start, 0), Math.max(count - 1, 0)));
  const [fading, setFading] = useState<number | null>(null);
  const [playing, setPlaying] = useState(true);
  const [idle, setIdle] = useState(false);
  const [seconds, setSeconds] = useState(readSlideSeconds);
  const [shown, setShown] = useState<string | null>(null);
  const [video, setVideo] = useState<VideoState>("none");

  const indexRef = useRef(index);
  const elapsed = useRef(0);
  const bar = useRef<HTMLDivElement | null>(null);
  const idleTimer = useRef<number | null>(null);

  const item = items[index];
  const isVideo = !!item?.video;
  const ready = shown === item?.uid;

  const move = useCallback(
    (step: number) => {
      const next = stepSlide(indexRef.current, count, step);
      if (next === indexRef.current) return;
      setFading(indexRef.current);
      indexRef.current = next;
      elapsed.current = 0;
      setVideo("none");
      setIndex(next);
    },
    [count],
  );

  const wake = useCallback(() => {
    setIdle(false);
    if (idleTimer.current !== null) window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setIdle(true), SLIDE_IDLE_MS);
  }, []);

  useEffect(() => {
    wake();
    return () => {
      if (idleTimer.current !== null) window.clearTimeout(idleTimer.current);
    };
  }, [wake]);

  // A paused show keeps its bar, since there is nothing to see through it.
  useEffect(() => {
    if (!playing) {
      if (idleTimer.current !== null) window.clearTimeout(idleTimer.current);
      setIdle(false);
    } else wake();
  }, [playing, wake]);

  useEffect(() => {
    if (fading === null) return;
    const id = window.setTimeout(() => setFading(null), 900);
    return () => window.clearTimeout(id);
  }, [fading, index]);

  // The slide's time runs only while it is on screen and the show is playing. A video that
  // is ready gets its cap and moves on when it ends; one still loading when the pause runs
  // out is skipped.
  const videoPlays = isVideo && video === "playing";
  useEffect(() => {
    if (!playing || !ready || (isVideo && video === "none")) return;
    const duration = slideDurationMs(seconds, videoPlays);
    let last = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      elapsed.current += now - last;
      last = now;
      if (bar.current) bar.current.style.width = `${slideProgress(elapsed.current, duration) * 100}%`;
      if (elapsed.current >= duration) {
        move(1);
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, ready, isVideo, video, videoPlays, seconds, index, move]);

  useEffect(() => {
    if (videoPlays) elapsed.current = 0;
  }, [videoPlays]);

  useEffect(() => {
    if (bar.current) bar.current.style.width = "0%";
  }, [index]);

  // The next pictures are fetched while this one shows.
  useEffect(() => {
    const ahead = slidesAhead(index, count)
      .map((i) => items[i])
      .filter((it) => it && !it.video)
      .map((it) => it.uid);
    prefetchPreviews(ahead);
  }, [index, count, items]);

  const exit = useCallback(() => onExit(indexRef.current), [onExit]);

  // Taken before the viewer's own keys, so Escape and the arrows belong to the show.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey || e.key === "F11" || e.key === "F12") return;
      e.stopImmediatePropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        exit();
      } else if (e.key === " ") {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        move(1);
        wake();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        move(-1);
        wake();
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [exit, move, wake]);

  if (!item) return null;
  const previous = fading !== null ? items[fading] : null;

  return (
    <div
      className={`ss${idle ? " idle" : ""}${playing ? "" : " paused"}`}
      role="dialog"
      aria-modal="true"
      onMouseMove={wake}
      onClick={(e) => {
        e.stopPropagation();
        setPlaying((p) => !p);
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {previous && (
        <div className="ss-slide out" key={`out-${fading}`}>
          <SlideImage uid={previous.uid} />
        </div>
      )}
      <div className="ss-slide in" key={item.uid}>
        <SlideImage uid={item.uid} onShown={() => setShown(item.uid)} />
        {isVideo && video !== "failed" && (
          <SlideVideo
            uid={item.uid}
            playing={playing}
            onState={setVideo}
            onEnded={() => move(1)}
          />
        )}
      </div>

      <div className="ss-paused" aria-hidden>
        <PauseIcon size={36} />
      </div>

      <div className="ss-ui">
        <div className="ss-top">
          <span className="ss-name">{item.name ?? ""}</span>
          <span className="ss-keys">{t("slideshow.hint")}</span>
        </div>
        <div className="ss-bar" onClick={(e) => e.stopPropagation()}>
          <button className="ss-btn" onClick={() => move(-1)} title={t("slideshow.prev")} aria-label={t("slideshow.prev")}>
            <ChevronLeftIcon size={22} />
          </button>
          <button
            className="ss-btn"
            onClick={() => setPlaying((p) => !p)}
            title={playing ? t("slideshow.pause") : t("slideshow.play")}
            aria-label={playing ? t("slideshow.pause") : t("slideshow.play")}
          >
            {playing ? <PauseIcon size={20} /> : <PlayArrowIcon size={22} />}
          </button>
          <button className="ss-btn" onClick={() => move(1)} title={t("slideshow.next")} aria-label={t("slideshow.next")}>
            <ChevronRightIcon size={22} />
          </button>
          <span className="ss-count">{t("viewer.position", { n: index + 1, total: count })}</span>
          <div className="ss-seconds" role="group" aria-label={t("slideshow.interval")}>
            {SLIDE_SECONDS.map((s) => (
              <button
                key={s}
                className={`ss-sec${seconds === s ? " on" : ""}`}
                aria-pressed={seconds === s}
                onClick={() => {
                  setSeconds(s);
                  writeSlideSeconds(s);
                }}
              >
                {t("slideshow.seconds", { n: s })}
              </button>
            ))}
          </div>
          <button className="ss-btn" onClick={exit} title={t("slideshow.exit")} aria-label={t("slideshow.exit")}>
            <CloseIcon size={18} />
          </button>
        </div>
      </div>
      <div className="ss-prog" ref={bar} />
    </div>
  );
}
