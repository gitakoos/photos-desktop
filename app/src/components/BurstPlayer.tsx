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

import { useEffect, useMemo, useRef, useState } from "react";

import { useThumbnails } from "../hooks/useThumbnails";
import { useT } from "../lib/i18n";
import { loadPreview } from "../lib/previewStore";
import { PauseIcon, PlayArrowIcon } from "./icons";

/** Frames a second while a burst plays. */
const FPS = 8;
/**
 * The most frames played: a longer burst plays every other shot or so. The previews are kept
 * in a small cache shared with the viewer, and a burst of a hundred would push out the rest.
 */
const MAX_FRAMES = 40;

/**
 * A burst stacked in the timeline, over the viewer's picture: a strip of its shots, a play
 * button that runs them as a short animation, and a way to show every shot in the timeline
 * again. A shot picked in the strip, or the one a play is paused on, becomes the photo the
 * viewer shows and acts on (`onPick`); while playing, the frames are drawn over the picture.
 */
export function BurstPlayer({
  uids,
  viewing,
  onPick,
  onUnstack,
}: {
  uids: string[];
  /** The shot the viewer has open. */
  viewing: string;
  onPick: (uid: string) => void;
  onUnstack: () => void;
}) {
  const t = useT();
  const thumbs = useThumbnails(uids);
  const frames = useMemo(() => {
    if (uids.length <= MAX_FRAMES) return uids;
    const step = uids.length / MAX_FRAMES;
    return Array.from({ length: MAX_FRAMES }, (_, k) => uids[Math.floor(k * step)]);
  }, [uids]);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [playing, setPlaying] = useState(false);
  /** The frame drawn over the picture while playing. */
  const [frame, setFrame] = useState<string | null>(null);
  const seen = useRef({ previews, thumbs });
  seen.current = { previews, thumbs };
  const strip = useRef<HTMLDivElement>(null);

  // The previews, one at a time once played, so the viewer's own picture goes first. One that
  // did not come is asked again at the next play.
  useEffect(() => {
    if (!playing) return;
    let live = true;
    void (async () => {
      for (const uid of frames) {
        if (!live) return;
        if (seen.current.previews[uid]) continue;
        const url = await loadPreview(uid).catch(() => null);
        if (!live) return;
        if (url) setPreviews((p) => ({ ...p, [uid]: url }));
      }
    })();
    return () => {
      live = false;
    };
  }, [playing, frames]);

  // The frames that have come in so far, in a loop, carrying on from where it was.
  useEffect(() => {
    if (!playing) return;
    let k = Math.max(0, frames.indexOf(viewing));
    const id = setInterval(() => {
      const { previews: p, thumbs: th } = seen.current;
      for (let tries = 0; tries < frames.length; tries++) {
        const uid = frames[k % frames.length];
        k++;
        if (p[uid] || th[uid]) {
          setFrame(uid);
          return;
        }
      }
    }, 1000 / FPS);
    return () => clearInterval(id);
    // Started from the shot open when play was pressed, not restarted as the viewer follows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, frames]);

  const lit = playing ? frame : viewing;
  // The lit shot kept in sight in the strip.
  useEffect(() => {
    if (!lit) return;
    strip.current?.querySelector(`[data-uid="${CSS.escape(lit)}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [lit]);

  const pause = () => {
    setPlaying(false);
    if (frame) onPick(frame);
    setFrame(null);
  };
  const shown = playing && frame ? (previews[frame] ?? thumbs[frame] ?? null) : null;

  return (
    <>
      {shown && <img className="lbx-burstframe" src={shown} alt="" draggable={false} />}
      {/* Its own clicks: the stage under it closes the viewer on a click. */}
      <div
        className="lbx-burst"
        role="group"
        aria-label={t("burst.title", { count: uids.length })}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <button
          className="lbx-burstplay"
          onClick={() => (playing ? pause() : setPlaying(true))}
          title={t(playing ? "burst.pause" : "burst.play")}
          aria-label={t(playing ? "burst.pause" : "burst.play")}
        >
          {playing ? <PauseIcon size={18} /> : <PlayArrowIcon size={18} />}
        </button>
        <div className="lbx-burststrip" ref={strip}>
          {uids.map((uid, i) => (
            <button
              key={uid}
              data-uid={uid}
              className={`lbx-burstshot${lit === uid ? " on" : ""}`}
              onClick={() => {
                setPlaying(false);
                setFrame(null);
                onPick(uid);
              }}
              aria-pressed={lit === uid}
              aria-label={t("burst.shot", { n: i + 1, count: uids.length })}
              title={t("burst.shot", { n: i + 1, count: uids.length })}
            >
              {thumbs[uid] ? <img src={thumbs[uid]!} alt="" draggable={false} /> : <span />}
            </button>
          ))}
        </div>
        <button className="lbx-burstall" onClick={onUnstack}>
          {t("burst.showAll", { count: uids.length })}
        </button>
      </div>
    </>
  );
}
