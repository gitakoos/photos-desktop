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

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  PauseIcon,
  PlayArrowIcon,
  VolumeOffIcon,
  VolumeUpIcon,
} from "./icons";
import { formatVideoTime } from "../lib/durations";
import { useT } from "../lib/i18n";

/**
 * How far a single-frame step moves the playhead, in seconds.
 *
 * A true frame step is not on offer here. The web has no frame-accurate seek and no
 * way to read a clip's frame rate, so this is a nominal frame at 30 fps rather than
 * the exact frame boundary the Android client lands on through ExoPlayer. Footage
 * shot at another rate steps by a little less or a little more than one of its own
 * frames, which is the honest limit of what `currentTime` can do.
 */
const FRAME_STEP_S = 1 / 30;

/** How long the bar stays up after the pointer stops moving, while a clip plays. */
const IDLE_HIDE_MS = 2600;

type Props = {
  /** The element to drive. Null until the stage has mounted it. */
  video: HTMLVideoElement | null;
};

/**
 * A length worth putting on screen.
 *
 * A clip still loading reports NaN and one with no declared end reports Infinity.
 * Either would draw a track filled to nowhere and a time made of garbage, so both
 * come back as zero here and every caller reads that as "length not known yet".
 */
function usableDuration(video: HTMLVideoElement | null): number {
  const d = video?.duration ?? Number.NaN;
  return Number.isFinite(d) && d > 0 ? d : 0;
}

/** The same guard for a position, which a torn or unloaded source can report as NaN. */
function safeSeconds(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * The viewer's own video controls.
 *
 * The browser's native bar is off at the stage, so this is the whole of what drives
 * playback, and it is the Android viewer's control pill one for one: play and pause,
 * a scrub track that seeks as it is dragged, the two single-frame steps a genuinely
 * paused clip offers, the running time, and mute.
 *
 * It is handed the element rather than owning it, the way the Android pill is handed
 * an ExoPlayer. The stage keeps its one `<video>`; this keeps only the controls.
 */
export function VideoControls({ video }: Props) {
  const t = useT();
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [positionS, setPositionS] = useState(0);
  const [durationS, setDurationS] = useState(0);
  const [scrubbing, setScrubbing] = useState(false);
  const [scrubRatio, setScrubRatio] = useState(0);
  const [hovering, setHovering] = useState(false);
  const [awake, setAwake] = useState(true);

  const trackRef = useRef<HTMLDivElement | null>(null);
  // Read from listeners that must not be torn down and rebuilt on every drag frame.
  const scrubbingRef = useRef(false);
  const hideTimer = useRef<number | undefined>(undefined);

  // Out of the way while a clip plays untouched, and back on the first movement of
  // the pointer. A paused clip always keeps it, and so does a drag in progress.
  const visible = !playing || scrubbing || hovering || awake;

  /** Show the bar, and start the count towards hiding it again. */
  const wake = useCallback(() => {
    setAwake(true);
    if (hideTimer.current !== undefined) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setAwake(false), IDLE_HIDE_MS);
  }, []);

  const toggle = useCallback(() => {
    if (!video) return;
    // A play() the browser refuses (no gesture yet, source not ready) rejects, and an
    // unhandled rejection in the console is all that would otherwise come of it.
    if (video.paused) void video.play().catch(() => {});
    else video.pause();
  }, [video]);

  const toggleMute = useCallback(() => {
    if (!video) return;
    video.muted = !video.muted; // volumechange mirrors it back into state
  }, [video]);

  const step = useCallback(
    (forward: boolean) => {
      if (!video) return;
      const d = usableDuration(video);
      const target = video.currentTime + (forward ? FRAME_STEP_S : -FRAME_STEP_S);
      video.currentTime = Math.max(0, d > 0 ? Math.min(d, target) : target);
    },
    [video],
  );

  // One listener set for the element, rebuilt only when the stage swaps the element
  // itself. A new source on the same element arrives as loadstart, which is where the
  // previous clip's length and position are dropped rather than left on screen.
  useEffect(() => {
    if (!video) return;
    const readTransport = () => {
      setPlaying(!video.paused && !video.ended);
      setMuted(video.muted);
    };
    const sync = () => {
      readTransport();
      setDurationS(usableDuration(video));
      if (!scrubbingRef.current) setPositionS(video.currentTime);
    };
    // A new source on the same element. The length and position of the clip just
    // stepped away from go with it, rather than sitting on the bar as this one's
    // until the fresh metadata lands.
    const reset = () => {
      readTransport();
      setDurationS(0);
      setPositionS(0);
    };
    const on = (name: string, fn: () => void) => {
      video.addEventListener(name, fn);
      return () => video.removeEventListener(name, fn);
    };
    const offs = [
      on("loadstart", reset),
      on("loadedmetadata", sync),
      on("durationchange", sync),
      on("play", sync),
      on("pause", sync),
      on("ended", sync),
      on("seeked", sync),
      on("timeupdate", sync),
      on("volumechange", sync),
    ];
    sync();
    return () => {
      for (const off of offs) off();
    };
  }, [video]);

  // timeupdate fires a handful of times a second, which is visibly steppy on a scrub
  // track, so a playing clip drives the position from the frame clock instead. It runs
  // only while there is something to see: not behind a hidden bar, and not while a
  // drag owns the position.
  useEffect(() => {
    if (!video || !playing || scrubbing || !visible) return;
    let raf = 0;
    const tick = () => {
      setPositionS(video.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [video, playing, scrubbing, visible]);

  useEffect(() => {
    wake();
    window.addEventListener("pointermove", wake);
    return () => {
      window.removeEventListener("pointermove", wake);
      if (hideTimer.current !== undefined) window.clearTimeout(hideTimer.current);
    };
  }, [wake]);

  // Space, and only space. The shell claims the arrow keys for stepping between
  // photos, so seeking never takes them. Enter still activates a focused control,
  // which is the keyboard route to mute now that space means play everywhere.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.code !== "Space" || e.ctrlKey || e.altKey || e.metaKey || e.repeat) return;
      // A space typed into the rename box is a space, not a command.
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName ?? "";
      if (el?.isContentEditable || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
        return;
      }
      // Stops the page scrolling, and stops a focused button taking the same key as
      // a second activation.
      e.preventDefault();
      toggle();
      wake();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggle, wake]);

  // What a native control bar gives for free: a click on the picture itself plays or
  // pauses. The stage closes the viewer on a click, and the element already stops that
  // one from reaching it.
  useEffect(() => {
    if (!video) return;
    video.addEventListener("click", toggle);
    return () => video.removeEventListener("click", toggle);
  }, [video, toggle]);

  function ratioAt(clientX: number): number {
    const box = trackRef.current?.getBoundingClientRect();
    if (!box || box.width <= 0) return 0;
    return Math.min(1, Math.max(0, (clientX - box.left) / box.width));
  }

  function seekTo(ratio: number): void {
    if (!video || durationS <= 0) return;
    video.currentTime = ratio * durationS;
    setPositionS(ratio * durationS);
  }

  function beginScrub(e: ReactPointerEvent<HTMLDivElement>): void {
    if (durationS <= 0) return;
    // Capture, so the rest of the drag keeps coming here once the pointer leaves the
    // track, and so the click it ends with lands on the track rather than the stage.
    e.currentTarget.setPointerCapture(e.pointerId);
    scrubbingRef.current = true;
    setScrubbing(true);
    const r = ratioAt(e.clientX);
    setScrubRatio(r);
    seekTo(r);
  }

  function moveScrub(e: ReactPointerEvent<HTMLDivElement>): void {
    if (!scrubbingRef.current) return;
    const r = ratioAt(e.clientX);
    setScrubRatio(r);
    seekTo(r);
  }

  function endScrub(e: ReactPointerEvent<HTMLDivElement>): void {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    scrubbingRef.current = false;
    setScrubbing(false);
  }

  const ratio = scrubbing
    ? scrubRatio
    : durationS > 0
      ? Math.min(1, Math.max(0, positionS / durationS))
      : 0;
  const shownS = scrubbing ? scrubRatio * durationS : positionS;
  // Elapsed alone while the length is still unknown, so a clip that is loading counts
  // up honestly instead of claiming a total it has not been told.
  const time =
    durationS > 0
      ? `${formatVideoTime(safeSeconds(shownS) * 1000)} / ${formatVideoTime(durationS * 1000)}`
      : formatVideoTime(safeSeconds(positionS) * 1000);
  // The single-frame steps belong to a clip that is genuinely stopped: not mid-drag,
  // where they would sit under the pointer, and not before a length is known.
  const steps = !playing && !scrubbing && durationS > 0;

  return (
    <div
      className={`lbx-vbar${visible ? "" : " idle"}`}
      // The shell's root and its stage both close the viewer on a click, so every
      // control on this bar has to stop the one it is given, exactly as the video does.
      onClick={(e) => e.stopPropagation()}
      onPointerEnter={() => setHovering(true)}
      onPointerLeave={() => setHovering(false)}
    >
      <button
        type="button"
        className="lbx-vbtn"
        onClick={toggle}
        title={playing ? t("viewer.videoPause") : t("viewer.videoPlay")}
      >
        {playing ? <PauseIcon size={18} /> : <PlayArrowIcon size={18} />}
      </button>

      {steps && (
        <button
          type="button"
          className="lbx-vbtn step"
          onClick={() => step(false)}
          title={t("viewer.videoStepBack")}
        >
          <ChevronLeftIcon size={17} />
        </button>
      )}

      {/* Deliberately not focusable: a slider that takes focus would answer the arrow
          keys, and those belong to the shell for stepping between photos. Drag it or
          click it. */}
      <div
        ref={trackRef}
        className="lbx-vtrack"
        role="slider"
        aria-label={t("viewer.videoSeek")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(ratio * 100)}
        aria-valuetext={time}
        onPointerDown={beginScrub}
        onPointerMove={moveScrub}
        onPointerUp={endScrub}
        onPointerCancel={endScrub}
      >
        <div className="lbx-vtrack-line" />
        <div className="lbx-vtrack-fill" style={{ width: `${ratio * 100}%` }} />
        <div className="lbx-vtrack-knob" style={{ left: `${ratio * 100}%` }} />
      </div>

      {steps && (
        <button
          type="button"
          className="lbx-vbtn step"
          onClick={() => step(true)}
          title={t("viewer.videoStepForward")}
        >
          <ChevronRightIcon size={17} />
        </button>
      )}

      <span className="lbx-vtime">{time}</span>

      <button
        type="button"
        className="lbx-vbtn"
        onClick={toggleMute}
        title={muted ? t("viewer.videoUnmute") : t("viewer.videoMute")}
      >
        {muted ? <VolumeOffIcon size={17} /> : <VolumeUpIcon size={17} />}
      </button>
    </div>
  );
}
