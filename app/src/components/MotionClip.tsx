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
import { useT } from "../lib/i18n";
import {
  HOLD_PLAY_MS,
  clipBlob,
  isHold,
  readClipSound,
  writeClipSound,
  type ClipPayload,
  type MotionKind,
} from "../lib/motion";
import { MotionPhotoIcon, PauseIcon, VolumeOffIcon, VolumeUpIcon } from "./icons";
import "../styles/MotionClip.css";

type Phase = "idle" | "loading" | "playing" | "failed";

/**
 * The clip of a Live Photo or a motion photo, played over the still in the viewer.
 *
 * It sits on the stage as a pill at the bottom: a click or Space plays the clip and again
 * stops it, and pressing and holding the picture plays it for as long as the press lasts.
 * The clip is fetched on the first play and kept for the photo. Its sound is off until the
 * speaker button turns it on, and the choice is remembered.
 */
export function MotionClip({
  itemKey,
  kind,
  load,
}: {
  /** The photo the clip belongs to; a new one drops the clip held for the last. */
  itemKey: string;
  kind: MotionKind;
  /** Fetches the clip: null when the file turns out to hold none. */
  load: () => Promise<ClipPayload | null>;
}) {
  const t = useT();
  const root = useRef<HTMLDivElement | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [url, setUrl] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(3);
  const [sound, setSound] = useState(readClipSound);
  const loadRef = useRef(load);
  loadRef.current = load;
  const urlRef = useRef<string | null>(null);
  const wantPlay = useRef(false);
  const keyRef = useRef(itemKey);
  keyRef.current = itemKey;

  // A new photo starts clean: nothing playing, and no clip held from the last one.
  useEffect(() => {
    wantPlay.current = false;
    setPhase("idle");
    setUrl(null);
    urlRef.current = null;
    return () => {
      wantPlay.current = false;
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, [itemKey]);

  const stop = useCallback(() => {
    wantPlay.current = false;
    video.current?.pause();
    setPhase((p) => (p === "playing" || p === "loading" ? "idle" : p));
  }, []);

  const play = useCallback(async () => {
    wantPlay.current = true;
    if (urlRef.current) {
      const el = video.current;
      if (el) {
        el.currentTime = 0;
        void el.play().catch(() => {});
      }
      setPhase("playing");
      return;
    }
    setPhase("loading");
    const asked = keyRef.current;
    try {
      const clip = await loadRef.current();
      // The reader moved on to another photo while the clip was on its way.
      if (keyRef.current !== asked) return;
      if (!clip) throw new Error("no clip");
      const made = URL.createObjectURL(clipBlob(clip));
      urlRef.current = made;
      setUrl(made);
      // Playing starts once the video element has the clip; `onLoadedData` below sees the wish.
    } catch {
      if (keyRef.current !== asked) return;
      wantPlay.current = false;
      setPhase("failed");
    }
  }, []);

  useEffect(() => {
    if (video.current) video.current.muted = !sound;
  }, [sound, url]);

  useEffect(() => {
    if (phase !== "failed") return;
    const id = window.setTimeout(() => setPhase("idle"), 3000);
    return () => window.clearTimeout(id);
  }, [phase]);

  const toggle = useCallback(() => {
    if (phase === "playing" || phase === "loading") stop();
    else void play();
  }, [phase, play, stop]);
  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;

  // The picture hides under the playing clip, as the stage reads this class.
  useEffect(() => {
    const stage = root.current?.parentElement;
    if (!stage) return;
    stage.classList.toggle("clip-playing", phase === "playing");
    return () => stage.classList.remove("clip-playing");
  }, [phase]);

  // Space plays and stops; a press held on the picture plays while it lasts.
  useEffect(() => {
    const stage = root.current?.parentElement;
    function onKey(e: KeyboardEvent) {
      if (e.key !== " " || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("button, input, textarea, select, a, [contenteditable]")) return;
      e.preventDefault();
      toggleRef.current();
    }
    let timer = 0;
    let held = false;
    let at: { x: number; y: number } | null = null;
    const cancel = () => window.clearTimeout(timer);
    function onDown(e: PointerEvent) {
      if (e.button !== 0 || !(e.target as HTMLElement).closest(".pv")) return;
      at = { x: e.clientX, y: e.clientY };
      timer = window.setTimeout(() => {
        held = true;
        void play();
      }, HOLD_PLAY_MS);
    }
    function onMove(e: PointerEvent) {
      if (at && !held && !isHold(e.clientX - at.x, e.clientY - at.y)) cancel();
    }
    function onUp() {
      cancel();
      at = null;
      if (held) {
        held = false;
        stop();
      }
    }
    window.addEventListener("keydown", onKey);
    stage?.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      cancel();
      window.removeEventListener("keydown", onKey);
      stage?.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [play, stop]);

  const label =
    phase === "playing"
      ? t("motion.stop")
      : phase === "loading"
        ? t("common.loading")
        : t(kind === "live" ? "motion.live" : "motion.motion");

  return (
    <div className="lbx-motion" ref={root} onClick={(e) => e.stopPropagation()}>
      {url && (
        <video
          ref={video}
          className={`lbx-motion-video${phase === "playing" ? " on" : ""}`}
          src={url}
          muted={!sound}
          playsInline
          disablePictureInPicture
          onLoadedMetadata={(e) => setSeconds(Math.max(0.5, e.currentTarget.duration || 3))}
          onLoadedData={(e) => {
            if (wantPlay.current) {
              void e.currentTarget.play().catch(() => {});
              setPhase("playing");
            }
          }}
          onEnded={stop}
          onError={() => {
            wantPlay.current = false;
            setPhase("failed");
          }}
        />
      )}
      {phase === "idle" && <span className="lbx-motion-hint">{t("motion.hint")}</span>}
      {phase === "failed" && <span className="lbx-motion-hint err">{t("motion.failed")}</span>}
      <button className={`lbx-motion-pill${phase === "playing" ? " playing" : ""}`} onClick={toggle}>
        <span className="lbx-motion-ring">
          <svg className="r" width="22" height="22" viewBox="0 0 24 24" fill="none" strokeWidth="2.4" aria-hidden>
            <circle className="t" cx="12" cy="12" r="10" />
            {phase === "playing" && (
              <circle className="f" cx="12" cy="12" r="10" style={{ animationDuration: `${seconds}s` }} />
            )}
          </svg>
          {phase === "playing" ? <PauseIcon size={10} /> : <MotionPhotoIcon size={14} />}
        </span>
        {label}
      </button>
      <button
        className="lbx-motion-snd"
        onClick={() => {
          writeClipSound(!sound);
          setSound(!sound);
        }}
        title={sound ? t("motion.soundOn") : t("motion.soundOff")}
        aria-label={sound ? t("motion.soundOn") : t("motion.soundOff")}
        aria-pressed={sound}
      >
        {sound ? <VolumeUpIcon size={17} /> : <VolumeOffIcon size={17} />}
      </button>
    </div>
  );
}
