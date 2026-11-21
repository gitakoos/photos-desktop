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
import { CloseIcon } from "./icons";
import { rpc } from "../lib/rpc";
import { useT } from "../lib/i18n";
import {
  GIF_EDGES,
  GIF_MAX_SECONDS,
  gifPlacement,
  gifRatio,
  gifSize,
  gifTimes,
  gifWindow,
  type GifAspect,
} from "../lib/gifFrame";
import "../styles/GifMaker.css";

function b64ToBlob(base64: string, mime: string): Blob {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function seek(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      video.removeEventListener("seeked", done);
      clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(done, 3000);
    video.addEventListener("seeked", done);
    video.currentTime = t;
  });
}

const fmt = (s: number) => {
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(1).padStart(4, "0")}`;
};

/**
 * Turns a part of a video into a looping GIF, as the phone's GIF maker does: a window of at most
 * ten seconds, the frame's shape (the video's own or square) with zoom and drag to frame it, and
 * the size; a live, muted, looping preview shows exactly what is saved. Saved as a new photo with
 * the video's date.
 */
export function GifMaker({ uid, onClose, onSaved }: { uid: string; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [duration, setDuration] = useState(0);
  const [dims, setDims] = useState({ w: 0, h: 0 });
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [aspect, setAspect] = useState<GifAspect>("original");
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [edge, setEdge] = useState<number>(720);
  const [saving, setSaving] = useState<{ done: number; total: number } | null>(null);
  const frame = useRef({ start: 0, end: 0, aspect: "original" as GifAspect, zoom: 1, pan: { x: 0, y: 0 } });
  frame.current = { start, end, aspect, zoom, pan };

  useEffect(() => {
    let made: string | null = null;
    let live = true;
    void rpc<{ base64: string; mime: string }>("getVideo", { uid })
      .then((v) => {
        if (!live) return;
        made = URL.createObjectURL(b64ToBlob(v.base64, v.mime));
        setUrl(made);
      })
      .catch((e) => live && setError(String(e).includes("VIDEO_TOO_LARGE") ? t("gif.tooLarge") : t("gif.failedOpen")));
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [uid]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, saving]);

  // The preview: the playing video drawn into the frame, looping inside the window.
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const video = videoRef.current;
      const canvas = canvasRef.current;
      const stage = stageRef.current;
      if (!video || !canvas || !stage || !video.videoWidth) return;
      const f = frame.current;
      if (!saving && f.end > f.start && (video.currentTime >= f.end || video.currentTime < f.start - 0.05)) {
        video.currentTime = f.start;
      }
      const ratio = gifRatio(video.videoWidth, video.videoHeight, f.aspect);
      const box = stage.getBoundingClientRect();
      const cssW = Math.min(box.width, box.height * ratio);
      const cssH = cssW / ratio;
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(2, Math.round(cssW * dpr));
      const h = Math.max(2, Math.round(cssH * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        canvas.style.width = `${cssW}px`;
        canvas.style.height = `${cssH}px`;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const p = gifPlacement(video.videoWidth, video.videoHeight, w, h, f.zoom, f.pan.x, f.pan.y);
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(video, p.x, p.y, p.w, p.h);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [saving]);

  function onLoaded() {
    const video = videoRef.current;
    if (!video) return;
    const total = Number.isFinite(video.duration) ? video.duration : 0;
    setDuration(total);
    setDims({ w: video.videoWidth, h: video.videoHeight });
    const w = gifWindow(0, Math.min(total, 3), total);
    setStart(w.start);
    setEnd(w.end);
    void video.play().catch(() => {});
  }

  function setRange(nextStart: number, nextEnd: number, moved: "start" | "end") {
    let s = nextStart;
    let e = nextEnd;
    if (moved === "start" && e - s > GIF_MAX_SECONDS) e = s + GIF_MAX_SECONDS;
    if (moved === "end" && e - s > GIF_MAX_SECONDS) s = e - GIF_MAX_SECONDS;
    const w = gifWindow(s, e, duration);
    setStart(w.start);
    setEnd(w.end);
    const video = videoRef.current;
    if (video) video.currentTime = moved === "start" ? w.start : Math.max(w.start, w.end - 0.5);
  }

  // Drag on the preview moves the picture within what spills over the frame.
  const drag = useRef<{ x: number; y: number; pan: { x: number; y: number } } | null>(null);
  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (saving) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, pan };
  }
  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const d = drag.current;
    const canvas = canvasRef.current;
    if (!d || !canvas || !dims.w) return;
    const rect = canvas.getBoundingClientRect();
    const p = gifPlacement(dims.w, dims.h, rect.width, rect.height, zoom, 0, 0);
    const spillX = Math.max(0, p.w - rect.width);
    const spillY = Math.max(0, p.h - rect.height);
    const clamp = (v: number) => Math.max(-1, Math.min(1, v));
    setPan({
      x: spillX > 0 ? clamp(d.pan.x + (2 * (e.clientX - d.x)) / spillX) : 0,
      y: spillY > 0 ? clamp(d.pan.y + (2 * (e.clientY - d.y)) / spillY) : 0,
    });
  }
  function onPointerUp() {
    drag.current = null;
  }

  async function save() {
    const video = videoRef.current;
    if (!video || !dims.w || saving) return;
    const ratio = gifRatio(dims.w, dims.h, aspect);
    const size = gifSize(ratio, edge);
    const times = gifTimes(start, end);
    setSaving({ done: 0, total: times.length });
    setError("");
    video.pause();
    let job = "";
    try {
      job = (await rpc<{ job: string }>("gifBegin", { width: size.width, height: size.height })).job;
      const out = document.createElement("canvas");
      out.width = size.width;
      out.height = size.height;
      const ctx = out.getContext("2d");
      if (!ctx) throw new Error("canvas");
      const p = gifPlacement(dims.w, dims.h, size.width, size.height, zoom, pan.x, pan.y);
      for (let i = 0; i < times.length; i++) {
        await seek(video, times[i]);
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, size.width, size.height);
        ctx.drawImage(video, p.x, p.y, p.w, p.h);
        const blob = await new Promise<Blob | null>((r) => out.toBlob(r, "image/jpeg", 0.92));
        if (!blob) throw new Error("frame");
        await rpc("gifFrame", { job, index: i, data: await blobToBase64(blob) });
        setSaving({ done: i + 1, total: times.length });
      }
      await rpc("gifFinish", { job, uid });
      job = "";
      onSaved();
    } catch {
      setError(t("gif.failedSave"));
      setSaving(null);
      void video.play().catch(() => {});
    } finally {
      if (job) void rpc("gifCancel", { job }).catch(() => {});
    }
  }

  const span = Math.max(0, end - start);
  const pct = (v: number) => (duration > 0 ? (100 * v) / duration : 0);

  return (
    <div className="gm-backdrop" role="dialog" aria-label={t("gif.title")}>
      <div className="gm-head">
        <button className="gm-close" onClick={onClose} disabled={!!saving} title={t("common.close")} aria-label={t("common.close")}>
          <CloseIcon size={18} />
        </button>
        <h2 className="gm-title">{t("gif.title")}</h2>
        <button className="gm-save" onClick={() => void save()} disabled={!url || !dims.w || !!saving}>
          {saving ? t("gif.saving", { done: saving.done, total: saving.total }) : t("gif.save")}
        </button>
      </div>

      <div className="gm-stage" ref={stageRef}>
        {error && <p className="gm-error">{error}</p>}
        {!url && !error && <p className="gm-note">{t("gif.loading")}</p>}
        {url && (
          <>
            <video
              ref={videoRef}
              className="gm-video"
              src={url}
              muted
              playsInline
              preload="auto"
              onLoadedMetadata={onLoaded}
              onEnded={() => {
                const video = videoRef.current;
                if (video && !saving) {
                  video.currentTime = frame.current.start;
                  void video.play().catch(() => {});
                }
              }}
            />
            <canvas
              ref={canvasRef}
              className={`gm-canvas${zoom > 1 ? " movable" : ""}`}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            />
          </>
        )}
      </div>

      <div className="gm-controls">
        <div className="gm-range">
          <div className="gm-track">
            <div className="gm-fill" style={{ left: `${pct(start)}%`, width: `${pct(span)}%` }} />
            <input
              className="gm-handle"
              type="range"
              min={0}
              max={duration || 1}
              step={0.05}
              value={start}
              disabled={!duration || !!saving}
              aria-label={t("gif.start")}
              onChange={(e) => setRange(Number(e.currentTarget.value), end, "start")}
            />
            <input
              className="gm-handle"
              type="range"
              min={0}
              max={duration || 1}
              step={0.05}
              value={end}
              disabled={!duration || !!saving}
              aria-label={t("gif.end")}
              onChange={(e) => setRange(start, Number(e.currentTarget.value), "end")}
            />
          </div>
          <div className="gm-times">
            <span>0:00.0</span>
            <span className="gm-span">{t("gif.window", { start: fmt(start), end: fmt(end), seconds: span.toFixed(1) })}</span>
            <span>{fmt(duration)}</span>
          </div>
        </div>

        <div className="gm-row">
          <div className="st-seg" role="group" aria-label={t("gif.aspect")}>
            {(["original", "square"] as GifAspect[]).map((a) => (
              <button
                key={a}
                className={`st-seg-btn${aspect === a ? " on" : ""}`}
                aria-pressed={aspect === a}
                disabled={!!saving}
                onClick={() => {
                  setAspect(a);
                  setPan({ x: 0, y: 0 });
                }}
              >
                {t(a === "original" ? "gif.aspectOriginal" : "gif.aspectSquare")}
              </button>
            ))}
          </div>
          <label className="gm-zoom">
            <span>{t("gif.zoom")}</span>
            <input
              type="range"
              min={1}
              max={4}
              step={0.05}
              value={zoom}
              disabled={!!saving}
              onChange={(e) => setZoom(Number(e.currentTarget.value))}
            />
          </label>
          <div className="st-seg" role="group" aria-label={t("gif.size")}>
            {GIF_EDGES.map((px) => (
              <button
                key={px}
                className={`st-seg-btn${edge === px ? " on" : ""}`}
                aria-pressed={edge === px}
                disabled={!!saving}
                onClick={() => setEdge(px)}
              >
                {px} px
              </button>
            ))}
          </div>
        </div>
        <p className="gm-note">{t("gif.note")}</p>
      </div>
    </div>
  );
}
