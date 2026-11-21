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

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { MIN_CROP_PX, pickHandle, resizeCrop, type CropBox, type CropHandle } from "../lib/editorCrop";
import { GIF_MAX_SECONDS } from "../lib/gifFrame";
import { formatBytes } from "../lib/format";
import { useT } from "../lib/i18n";
import { isCancelled, untilNameFree } from "../lib/localFile";
import {
  FILTERS,
  GIF_RATES,
  GIF_WIDTHS,
  SPEEDS,
  VIDEO_ASPECTS,
  aspectRatio,
  buildEdit,
  canSplitAt,
  cssFilter,
  cutSize,
  estimateGifBytes,
  flipBox,
  formatClock,
  freshEdit,
  gifFits,
  gifFrameSize,
  isEdited,
  isFullBox,
  keepSide,
  lookIsNeutral,
  moveHandle,
  msAtX,
  outputMs,
  playheadIn,
  previewLayout,
  rangesToSave,
  rulerTicks,
  sidewaysTurn,
  startingCrop,
  stripCount,
  turnBoxRight,
  turnRight,
  turnedSize,
  type EditKind,
  type EditState,
  type VideoAspect,
} from "../lib/videoEdit";
import {
  cancelEdit,
  discardStaged,
  downloadDriveVideo,
  onEditProgress,
  openVideo,
  pickAudio,
  runEdit,
  saveEditedMedia,
  saveLocalCopy,
  videoStrip,
  type EditResult,
  type VideoInfo,
} from "../lib/videoEditApi";
import { Confirm } from "./Confirm";
import { CropOverlay, RulerSlider, SideSection } from "./PhotoEditor";
import {
  ArrowBackIcon,
  CheckIcon,
  CloseIcon,
  CloudUploadIcon,
  ContentCopyIcon,
  ContentCutIcon,
  CropRotateIcon,
  FilmstripIcon,
  FlipHorizontalIcon,
  FlipVerticalIcon,
  GifIcon,
  MusicNoteIcon,
  PauseIcon,
  PhotoCameraIcon,
  PlayArrowIcon,
  RestoreIcon,
  RotateRightIcon,
  ScheduleIcon,
  SpinnerIcon,
  TonalityIcon,
  VolumeUpIcon,
  VolumeOffIcon,
} from "./icons";
import "../styles/Editor.css";
import "../styles/VideoEditor.css";

/**
 * `picksPlace`: a local file whose copy cannot go beside it, so the save dialog asks where.
 * `album`: the album a Drive video was opened in, which its copies join.
 */
export type VideoEditSource =
  | { kind: "local"; path: string; picksPlace?: boolean }
  | { kind: "drive"; uid: string; name: string; album?: string };

type Props = {
  source: VideoEditSource;
  onClose: () => void;
  /**
   * A copy was written: the new files' paths (local) or uids (Drive). `missedAlbum` is set when
   * a copy is saved but did not get into the source's album.
   */
  onSaved: (results: string[], missedAlbum?: boolean) => void;
};

type Tab = "trim" | "crop" | "look" | "speed" | "audio" | "gif";

type IconComponent = (props: { size?: number }) => ReactNode;

const TABS: { id: Tab; label: string; Icon: IconComponent }[] = [
  { id: "trim", label: "videoEditor.tab.trim", Icon: FilmstripIcon },
  { id: "crop", label: "videoEditor.tab.crop", Icon: CropRotateIcon },
  { id: "look", label: "videoEditor.tab.look", Icon: TonalityIcon },
  { id: "speed", label: "videoEditor.tab.speed", Icon: ScheduleIcon },
  { id: "audio", label: "videoEditor.tab.audio", Icon: VolumeUpIcon },
  { id: "gif", label: "videoEditor.tab.gif", Icon: GifIcon },
];

const CROP_SLOP_PX = 24;
const SAVED_BEAT_MS = 850;
const STEP_MS = 100;

type Job = { id: string; stage: "making" | "uploading"; value: number; label: string };

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
const seconds1 = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export function VideoEditor({ source, onClose, onSaved }: Props) {
  const t = useT();
  const sourceKey = source.kind === "local" ? source.path : source.uid;
  const [phase, setPhase] = useState<"loading" | "ready" | "failed">("loading");
  const [loadNote, setLoadNote] = useState("");
  const [info, setInfo] = useState<VideoInfo | null>(null);
  const [meta, setMeta] = useState<{
    captureMs: number | null;
    camera: string | null;
    latitude: number | null;
    longitude: number | null;
  }>({ captureMs: null, camera: null, latitude: null, longitude: null });
  const [edit, setEdit] = useState<EditState>(() => freshEdit(0));
  const [tab, setTab] = useState<Tab>("trim");
  const [saveOpen, setSaveOpen] = useState(false);
  const [playMs, setPlayMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [banner, setBanner] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [saved, setSaved] = useState(false);
  const [strip, setStrip] = useState<string | null>(null);
  const [cannotPlay, setCannotPlay] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const [trackWidth, setTrackWidth] = useState(0);

  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const stagedSource = useRef<string | null>(null);
  const outputs = useRef<string[]>([]);
  /** The edit ffmpeg is making now, stopped if the editor closes under it. */
  const runningJob = useRef<string | null>(null);
  const closed = useRef(false);
  const savedResults = useRef<string[]>([]);
  const savedFrames = useRef<string[]>([]);
  const missedAlbum = useRef(false);
  const savedTimer = useRef<number | null>(null);
  const cropDrag = useRef<{ handle: CropHandle; offX: number; offY: number } | null>(null);
  const live = useRef<{ edit: EditState; playing: boolean }>({ edit, playing });
  live.current = { edit, playing };

  const busy = job !== null || saved;
  const durationMs = info?.durationMs ?? 0;
  const sideways = info ? info.rotation === 90 || info.rotation === 270 : false;
  const upright = info ? (sideways ? { w: info.height, h: info.width } : { w: info.width, h: info.height }) : { w: 0, h: 0 };
  const turned = turnedSize(upright.w, upright.h, edit.rotate);
  const dirty = !!info && isEdited(edit, durationMs);
  const cropping = tab === "crop";
  const dropsOwnSound = edit.audio.music?.mode === "replace";

  // ---- Opening the video ------------------------------------------------

  useEffect(() => {
    let alive = true;
    setPhase("loading");
    setLoadNote(source.kind === "drive" ? t("videoEditor.downloading") : t("videoEditor.loading"));
    void (async () => {
      try {
        let path: string;
        let driveMeta: { captureTime: number | null; camera: string | null; latitude: number | null; longitude: number | null } | null =
          null;
        if (source.kind === "local") {
          path = source.path;
        } else {
          const got = await downloadDriveVideo(source.uid, () => !alive);
          if (!got) return;
          if (!alive) {
            void discardStaged(got.path);
            return;
          }
          path = got.path;
          stagedSource.current = got.path;
          driveMeta = got.source;
        }
        const opened = await openVideo(path);
        if (!alive) return;
        setInfo(opened);
        setMeta({
          captureMs: driveMeta?.captureTime ?? opened.captureMs,
          camera: driveMeta?.camera ?? null,
          latitude: driveMeta?.latitude ?? null,
          longitude: driveMeta?.longitude ?? null,
        });
        setEdit(freshEdit(opened.durationMs));
        setPhase("ready");
      } catch {
        if (alive) {
          setLoadNote(t("videoEditor.openFailed"));
          setPhase("failed");
        }
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey]);

  // What is staged goes when the editor does, saved or not, and an edit still being made is
  // stopped, which takes its folder with it.
  useEffect(
    () => () => {
      closed.current = true;
      if (savedTimer.current) window.clearTimeout(savedTimer.current);
      if (runningJob.current) void cancelEdit(runningJob.current).catch(() => {});
      if (stagedSource.current) void discardStaged(stagedSource.current);
      for (const path of outputs.current) void discardStaged(path);
    },
    [],
  );

  // The stage and the track are measured, so the picture fits and the strip has the frames it needs.
  useEffect(() => {
    const watch = (el: HTMLElement | null, set: (w: number, h: number) => void) => {
      if (!el) return () => {};
      const read = () => set(el.clientWidth, el.clientHeight);
      read();
      const observer = new ResizeObserver(read);
      observer.observe(el);
      return () => observer.disconnect();
    };
    const stopStage = watch(stageRef.current, (w, h) => setStage({ w: Math.max(0, w - 32), h: Math.max(0, h - 24) }));
    const stopTrack = watch(trackRef.current, (w) => setTrackWidth(w));
    return () => {
      stopStage();
      stopTrack();
    };
  }, [phase]);

  useEffect(() => {
    if (!info || trackWidth <= 0) return;
    let alive = true;
    const count = stripCount(trackWidth, upright.w, upright.h);
    void videoStrip(info.path, count, info.hdr)
      .then((url) => alive && setStrip(url))
      .catch(() => {});
    return () => {
      alive = false;
    };
    // The strip is made once per video and track width.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info?.path, Math.round(trackWidth / 40)]);

  // ---- The preview ------------------------------------------------------

  // The playhead follows the video, which loops inside the part that is kept.
  useEffect(() => {
    if (phase !== "ready") return;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const video = videoRef.current;
      if (!video) return;
      const { edit: e, playing: isPlaying } = live.current;
      let ms = video.currentTime * 1000;
      if (isPlaying && (ms >= e.endMs || ms < e.startMs - 300)) {
        video.currentTime = e.startMs / 1000;
        ms = e.startMs;
      }
      setPlayMs(Math.round(ms / 40) * 40);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [phase]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = edit.speed;
    video.muted = edit.audio.mute || dropsOwnSound;
    video.volume = Math.min(1, Math.max(0, edit.audio.volume / 100));
  }, [edit.speed, edit.audio.mute, edit.audio.volume, dropsOwnSound, phase]);

  const seek = useCallback((ms: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = ms / 1000;
    setPlayMs(ms);
  }, []);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      const { startMs, endMs } = live.current.edit;
      if (video.currentTime * 1000 >= endMs - 50 || video.currentTime * 1000 < startMs) video.currentTime = startMs / 1000;
      void video
        .play()
        .then(() => setPlaying(true))
        .catch(() => setCannotPlay(true));
    } else {
      video.pause();
      setPlaying(false);
    }
  }, []);

  function pause() {
    videoRef.current?.pause();
    setPlaying(false);
  }

  // ---- Editing ------------------------------------------------------------

  const patch = (changes: Partial<EditState>) => setEdit((e) => ({ ...e, ...changes }));
  const patchAudio = (changes: Partial<EditState["audio"]>) => setEdit((e) => ({ ...e, audio: { ...e.audio, ...changes } }));

  function trimTo(handle: "start" | "end", ms: number) {
    const next = moveHandle(edit, handle, ms, durationMs);
    patch({ ...next, split: edit.split && canSplitAt({ ...edit, ...next }, edit.split.atMs) ? edit.split : null });
    seek(handle === "start" ? next.startMs : next.endMs);
  }

  function resetAll() {
    if (!info || busy) return;
    pause();
    setEdit(freshEdit(info.durationMs));
    seek(0);
  }

  function turn() {
    if (!edit.crop) {
      patch({ rotate: turnRight(edit.rotate), aspect: "free" });
      return;
    }
    patch({ rotate: turnRight(edit.rotate), aspect: "free", crop: turnBoxRight(edit.crop, turned.h) });
  }

  function flip(horizontal: boolean) {
    const crop = edit.crop ? flipBox(edit.crop, turned.w, turned.h, horizontal) : null;
    patch(horizontal ? { flipH: !edit.flipH, crop } : { flipV: !edit.flipV, crop });
  }

  function pickAspect(aspect: VideoAspect) {
    patch({ aspect, crop: startingCrop(aspect, turned.w, turned.h) });
  }

  const layout = previewLayout(turned, edit.crop, stage, cropping);
  const shownCrop: CropBox = edit.crop ?? { left: 0, top: 0, right: turned.w, bottom: turned.h };

  function pointerToFrame(e: ReactPointerEvent): { bx: number; by: number } {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const bx = ((e.clientX - rect.left) / rect.width) * turned.w;
    const by = ((e.clientY - rect.top) / rect.height) * turned.h;
    return { bx: Math.min(turned.w, Math.max(0, bx)), by: Math.min(turned.h, Math.max(0, by)) };
  }

  function onCropDown(e: ReactPointerEvent) {
    if (!turned.w || !layout.wrapW) return;
    const { bx, by } = pointerToFrame(e);
    const handle = pickHandle(shownCrop, bx, by, CROP_SLOP_PX * (turned.w / layout.wrapW));
    if (!handle) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    cropDrag.current = { handle, offX: bx - shownCrop.left, offY: by - shownCrop.top };
  }

  function onCropMove(e: ReactPointerEvent) {
    const drag = cropDrag.current;
    if (!drag) return;
    const { bx, by } = pointerToFrame(e);
    const ratio = aspectRatio(edit.aspect);
    setEdit((cur) => {
      const box = cur.crop ?? { left: 0, top: 0, right: turned.w, bottom: turned.h };
      const next = resizeCrop(box, drag.handle, bx, by, ratio, turned.w, turned.h, MIN_CROP_PX, drag.offX, drag.offY);
      return { ...cur, crop: isFullBox(next, turned.w, turned.h) ? null : next };
    });
  }

  function onCropUp() {
    cropDrag.current = null;
  }

  async function chooseMusic() {
    try {
      const picked = await pickAudio(t("videoEditor.musicPickTitle"));
      if (!picked) return;
      patchAudio({
        music: { path: picked.path, name: picked.name, durationMs: picked.durationMs, volume: 100, mode: "mix", looped: true },
      });
      setBanner(null);
    } catch {
      setBanner({ kind: "error", text: t("videoEditor.musicFailed") });
    }
  }

  // ---- Making and saving ----------------------------------------------------

  const context = { src: info?.path ?? "", creationMs: meta.captureMs };

  async function produce(kind: EditKind, range: { startMs: number; endMs: number }, frameMs: number): Promise<EditResult | null> {
    const id = crypto.randomUUID();
    setJob({ id, stage: "making", value: 0, label: t(kind === "frame" ? "videoEditor.makingFrame" : "videoEditor.making") });
    const stop = await onEditProgress(id, (value) =>
      setJob((j) => (j && j.id === id && j.stage === "making" ? { ...j, value } : j)),
    );
    runningJob.current = id;
    try {
      const result = await runEdit(id, buildEdit(edit, context, upright, kind, range, frameMs));
      // Finished just as the editor closed: nothing will save it.
      if (closed.current) {
        void discardStaged(result.path);
        return null;
      }
      outputs.current.push(result.path);
      return result;
    } catch (e) {
      if (String(e).includes("cancelled")) return null;
      throw e;
    } finally {
      runningJob.current = null;
      stop();
    }
  }

  /** Puts a made file where the copy goes: beside the original, or into the library. */
  async function deliver(result: EditResult): Promise<string> {
    let where: string;
    if (source.kind === "local") {
      const path = source.path;
      where = await untilNameFree(
        () => saveLocalCopy(path, result.path, meta.captureMs, t("editor.saveCopyWhereLinux")),
        () => setBanner({ kind: "error", text: t("editor.nameTakenLinux") }),
      );
    } else {
      setJob((j) => (j ? { ...j, stage: "uploading", value: -1, label: t("videoEditor.uploading") } : j));
      const done = await saveEditedMedia({
        path: result.path,
        thumb: result.thumb,
        name: source.name,
        captureTime: meta.captureMs,
        camera: meta.camera,
        latitude: meta.latitude,
        longitude: meta.longitude,
        width: result.width,
        height: result.height,
        durationMs: result.durationMs,
        albumUid: source.album,
      });
      if (done.albumFailed) missedAlbum.current = true;
      where = done.uid;
    }
    outputs.current = outputs.current.filter((p) => p !== result.path);
    void discardStaged(result.path);
    (result.kind === "frame" ? savedFrames : savedResults).current.push(where);
    return where;
  }

  function finish() {
    setSaved(true);
    setBanner({ kind: "ok", text: t("editor.saved") });
    savedTimer.current = window.setTimeout(
      () => onSaved([...savedResults.current, ...savedFrames.current], missedAlbum.current),
      SAVED_BEAT_MS,
    );
  }

  async function saveParts(kind: "video" | "gif") {
    if (busy || !info) return;
    pause();
    setBanner(null);
    setSaveOpen(false);
    try {
      for (const range of rangesToSave(edit)) {
        const made = await produce(kind, range, 0);
        if (!made) {
          setJob(null);
          return;
        }
        await deliver(made);
      }
      setJob(null);
      finish();
    } catch (e) {
      setJob(null);
      // A dismissed save dialog writes nothing and loses nothing: the edit stays open.
      if (!isCancelled(e)) setBanner({ kind: "error", text: t("videoEditor.saveFailed") });
    }
  }

  async function grabFrame() {
    if (busy || !info) return;
    pause();
    setBanner(null);
    try {
      const made = await produce("frame", { startMs: 0, endMs: durationMs }, playMs);
      if (made) {
        await deliver(made);
        setBanner({ kind: "ok", text: t("videoEditor.grabbed") });
      }
    } catch (e) {
      if (!isCancelled(e)) setBanner({ kind: "error", text: t("videoEditor.saveFailed") });
    } finally {
      setJob(null);
    }
  }

  function stopJob() {
    if (job) void cancelEdit(job.id);
  }

  const leave = useCallback(() => {
    const all = [...savedResults.current, ...savedFrames.current];
    if (all.length > 0) onSaved(all, missedAlbum.current);
    else onClose();
  }, [onClose, onSaved]);

  const requestCancel = useCallback(() => {
    if (busy) return;
    if (dirty) setConfirmDiscard(true);
    else leave();
  }, [busy, dirty, leave]);

  // ---- Keyboard -------------------------------------------------------------
  // Captured and swallowed here so the viewer underneath never steps to another file mid-edit.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (confirmDiscard) return;
      e.stopPropagation();
      const meta = e.ctrlKey || e.metaKey;
      if (e.key === "Escape") {
        e.preventDefault();
        if (job) return;
        if (saveOpen) setSaveOpen(false);
        else requestCancel();
      } else if (meta && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (!busy && phase === "ready") setSaveOpen((o) => !o);
      } else if (e.key === " " && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        if (phase === "ready") togglePlay();
      } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && phase === "ready" && !(e.target instanceof HTMLElement && e.target.getAttribute("role") === "slider")) {
        e.preventDefault();
        const step = (e.shiftKey ? 1000 : 1000 / Math.max(1, info?.fps ?? 25)) * (e.key === "ArrowLeft" ? -1 : 1);
        pause();
        seek(playheadIn(edit, playMs + step));
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  // ---- The timeline -----------------------------------------------------------

  const pct = (ms: number) => (durationMs > 0 ? (100 * ms) / durationMs : 0);
  const track = useRef<{ target: "start" | "end" | "play" } | null>(null);

  function onTrackDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (busy || !trackRef.current) return;
    const grabbed = (e.target as HTMLElement).closest<HTMLElement>("[data-handle]")?.dataset.handle;
    track.current = { target: grabbed === "start" || grabbed === "end" ? grabbed : "play" };
    e.currentTarget.setPointerCapture(e.pointerId);
    onTrackMove(e);
  }

  function onTrackMove(e: ReactPointerEvent<HTMLDivElement>) {
    const drag = track.current;
    const el = trackRef.current;
    if (!drag || !el) return;
    const rect = el.getBoundingClientRect();
    const ms = msAtX(e.clientX, rect.left, rect.width, durationMs);
    if (drag.target === "play") {
      pause();
      seek(playheadIn(edit, ms));
    } else {
      pause();
      trimTo(drag.target, ms);
    }
  }

  function onTrackUp() {
    track.current = null;
  }

  function onHandleKey(handle: "start" | "end", e: React.KeyboardEvent) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    e.stopPropagation();
    const step = (e.shiftKey ? 1000 : STEP_MS) * (e.key === "ArrowLeft" ? -1 : 1);
    trimTo(handle, (handle === "start" ? edit.startMs : edit.endMs) + step);
  }

  // ---- Panels -----------------------------------------------------------------

  const ranges = rangesToSave(edit);
  const keptOutMs = ranges.reduce((sum, r) => sum + outputMs(r, edit.speed), 0);
  const gifRange = { startMs: edit.startMs, endMs: edit.endMs };
  const cut = cutSize(edit.crop, turned.w, turned.h);
  const gifSize = gifFrameSize(cut.w, cut.h, edit.gifWidth);
  const gifSeconds = outputMs(gifRange, edit.speed) / 1000;
  const gifOk = gifFits(gifRange, edit.speed);

  function adjust(label: string, value: number, set: (v: number) => void) {
    return (
      <div className={`ed-adj ${value !== 0 ? "on" : ""}`}>
        <div className="ed-adj-head" onDoubleClick={() => set(0)}>
          <span className="ed-adj-name">{label}</span>
          <span className="ed-adj-val">{signed(value)}</span>
          <button className="ed-adj-reset" onClick={() => set(0)} disabled={value === 0} title={t("editor.reset")} aria-label={`${t("editor.reset")}: ${label}`}>
            <RestoreIcon size={14} />
          </button>
        </div>
        <RulerSlider label={label} value={value} min={-100} max={100} compact onChange={(v) => set(Math.round(v))} />
      </div>
    );
  }

  function trimPanel() {
    const at = playMs;
    return (
      <>
        <SideSection title={t("videoEditor.trim")}>
          <div className="ve-facts">
            <span>{t("videoEditor.start")}</span>
            <b>{formatClock(edit.startMs)}</b>
            <span>{t("videoEditor.end")}</span>
            <b>{formatClock(edit.endMs)}</b>
            <span>{t("videoEditor.length")}</span>
            <b>{formatClock(edit.endMs - edit.startMs)}</b>
          </div>
          <div className="ed-side-row">
            <button className="ed-side-btn" onClick={() => trimTo("start", playheadIn({ startMs: 0, endMs: edit.endMs - 100 }, at))} disabled={busy}>
              <span>{t("videoEditor.setStart")}</span>
            </button>
            <button className="ed-side-btn" onClick={() => trimTo("end", Math.max(at, edit.startMs + 100))} disabled={busy}>
              <span>{t("videoEditor.setEnd")}</span>
            </button>
          </div>
          <button
            className="ed-side-btn"
            onClick={() => patch({ startMs: 0, endMs: durationMs, split: null })}
            disabled={busy || (edit.startMs === 0 && edit.endMs === durationMs)}
          >
            <RestoreIcon size={15} />
            <span>{t("videoEditor.resetTrim")}</span>
          </button>
        </SideSection>
        <SideSection title={t("videoEditor.split")} value={edit.split ? formatClock(edit.split.atMs) : undefined}>
          {edit.split ? (
            <>
              <div className="ed-chips">
                <button className="ed-chip" onClick={() => patch(keepSide(edit, "first"))} disabled={busy}>
                  {t("videoEditor.splitFirst")}
                </button>
                <button className="ed-chip" onClick={() => patch(keepSide(edit, "second"))} disabled={busy}>
                  {t("videoEditor.splitSecond")}
                </button>
                <button
                  className={`ed-chip ${edit.split.both ? "sel" : ""}`}
                  aria-pressed={edit.split.both}
                  onClick={() => patch({ split: { ...edit.split!, both: !edit.split!.both } })}
                  disabled={busy}
                >
                  {t("videoEditor.splitBoth")}
                </button>
              </div>
              {edit.split.both && <p className="ed-side-desc">{t("videoEditor.splitBothNote")}</p>}
              <button className="ed-side-btn" onClick={() => patch({ split: null })} disabled={busy}>
                <span>{t("videoEditor.splitRemove")}</span>
              </button>
            </>
          ) : (
            <button
              className="ed-side-btn"
              onClick={() => patch({ split: { atMs: at, both: false } })}
              disabled={busy || !canSplitAt(edit, at)}
            >
              <ContentCutIcon size={15} />
              <span>{t("videoEditor.splitHere")}</span>
            </button>
          )}
        </SideSection>
      </>
    );
  }

  function cropPanel() {
    return (
      <>
        <SideSection title={t("editor.ratio")}>
          <div className="ed-chips">
            {VIDEO_ASPECTS.map((a) => (
              <button key={a} className={`ed-chip ${edit.aspect === a ? "sel" : ""}`} onClick={() => pickAspect(a)} disabled={busy}>
                {a === "free" ? t("videoEditor.free") : a}
              </button>
            ))}
          </div>
          <p className="ed-side-desc">{edit.crop ? `${cut.w} x ${cut.h}` : t("videoEditor.cropHint")}</p>
        </SideSection>
        <SideSection title={t("videoEditor.turn")}>
          <div className="ed-side-row">
            <button className="ed-side-btn" onClick={turn} disabled={busy}>
              <RotateRightIcon size={16} />
              <span>{t("editor.rotate")}</span>
            </button>
            <button className="ed-side-btn" onClick={() => flip(true)} disabled={busy} aria-pressed={edit.flipH}>
              <FlipHorizontalIcon size={16} />
              <span>{t("editor.flipH")}</span>
            </button>
            <button className="ed-side-btn" onClick={() => flip(false)} disabled={busy} aria-pressed={edit.flipV}>
              <FlipVerticalIcon size={16} />
              <span>{t("editor.flipV")}</span>
            </button>
          </div>
        </SideSection>
        <button
          className="ed-side-btn"
          disabled={busy || (!edit.crop && edit.rotate === 0 && !edit.flipH && !edit.flipV)}
          onClick={() => patch({ crop: null, aspect: "free", rotate: 0, flipH: false, flipV: false })}
        >
          <RestoreIcon size={15} />
          <span>{t("editor.reset")}</span>
        </button>
      </>
    );
  }

  function lookPanel() {
    return (
      <>
        <SideSection title={t("editor.tab.filters")}>
          <div className="ed-chips">
            {FILTERS.map((f) => (
              <button key={f.id} className={`ed-chip ${edit.filter === f.id ? "sel" : ""}`} onClick={() => patch({ filter: f.id })} disabled={busy}>
                {t(f.label)}
              </button>
            ))}
          </div>
        </SideSection>
        <SideSection title={t("editor.tab.tone")}>
          {adjust(t("editor.adj.brightness"), edit.brightness, (v) => patch({ brightness: v }))}
          {adjust(t("editor.adj.contrast"), edit.contrast, (v) => patch({ contrast: v }))}
          {adjust(t("editor.adj.saturation"), edit.saturation, (v) => patch({ saturation: v }))}
        </SideSection>
        {info?.hdr && <p className="ed-side-desc">{t(lookIsNeutral(edit) ? "videoEditor.hdrKept" : "videoEditor.hdrMapped")}</p>}
        <button
          className="ed-side-btn"
          disabled={busy || lookIsNeutral(edit)}
          onClick={() => patch({ filter: "none", brightness: 0, contrast: 0, saturation: 0 })}
        >
          <RestoreIcon size={15} />
          <span>{t("editor.reset")}</span>
        </button>
      </>
    );
  }

  function speedPanel() {
    return (
      <SideSection title={t("videoEditor.tab.speed")}>
        <div className="ed-chips">
          {SPEEDS.map((s) => (
            <button key={s} className={`ed-chip ${edit.speed === s ? "sel" : ""}`} onClick={() => patch({ speed: s })} disabled={busy}>
              {s}x
            </button>
          ))}
        </div>
        <p className="ed-side-desc">{t("videoEditor.speedLength", { time: formatClock(outputMs({ startMs: edit.startMs, endMs: edit.endMs }, edit.speed)) })}</p>
      </SideSection>
    );
  }

  function audioPanel() {
    const music = edit.audio.music;
    return (
      <>
        {info && !info.hasAudio && <p className="ed-side-desc">{t("videoEditor.noSound")}</p>}
        <SideSection title={t("videoEditor.sound")}>
          <div className="ed-chips">
            <button
              className={`ed-chip ${edit.audio.mute ? "sel" : ""}`}
              aria-pressed={edit.audio.mute}
              onClick={() => patchAudio({ mute: !edit.audio.mute })}
              disabled={busy || !info?.hasAudio}
            >
              {t("videoEditor.mute")}
            </button>
          </div>
          <div className="ed-adj">
            <div className="ed-adj-head">
              <span className="ed-adj-name">{t("videoEditor.volume")}</span>
              <span className="ed-adj-val">{edit.audio.volume}%</span>
            </div>
            <RulerSlider
              label={t("videoEditor.volume")}
              value={edit.audio.volume}
              min={0}
              max={200}
              compact
              onChange={(v) => patchAudio({ volume: Math.round(v / 5) * 5 })}
            />
          </div>
          {(["fadeInMs", "fadeOutMs"] as const).map((key) => {
            const label = t(key === "fadeInMs" ? "videoEditor.fadeIn" : "videoEditor.fadeOut");
            return (
              <div className="ed-adj" key={key}>
                <div className="ed-adj-head">
                  <span className="ed-adj-name">{label}</span>
                  <span className="ed-adj-val">{seconds1(edit.audio[key])}</span>
                </div>
                <RulerSlider
                  label={label}
                  value={edit.audio[key] / 1000}
                  min={0}
                  max={5}
                  compact
                  onChange={(v) => patchAudio({ [key]: Math.round(v * 10) * 100 })}
                />
              </div>
            );
          })}
        </SideSection>
        <SideSection title={t("videoEditor.music")}>
          {music ? (
            <>
              <div className="ve-music">
                <MusicNoteIcon size={16} />
                <span className="ve-music-name" title={music.name}>
                  {music.name}
                </span>
                <button className="ed-adj-reset ve-music-remove" onClick={() => patchAudio({ music: null })} disabled={busy} title={t("videoEditor.removeMusic")} aria-label={t("videoEditor.removeMusic")}>
                  <CloseIcon size={14} />
                </button>
              </div>
              <div className="ed-chips">
                {(["mix", "replace"] as const).map((mode) => (
                  <button
                    key={mode}
                    className={`ed-chip ${music.mode === mode ? "sel" : ""}`}
                    onClick={() => patchAudio({ music: { ...music, mode } })}
                    disabled={busy}
                  >
                    {t(mode === "mix" ? "videoEditor.musicMix" : "videoEditor.musicReplace")}
                  </button>
                ))}
              </div>
              <div className="ed-adj">
                <div className="ed-adj-head">
                  <span className="ed-adj-name">{t("videoEditor.musicVolume")}</span>
                  <span className="ed-adj-val">{music.volume}%</span>
                </div>
                <RulerSlider
                  label={t("videoEditor.musicVolume")}
                  value={music.volume}
                  min={0}
                  max={200}
                  compact
                  onChange={(v) => patchAudio({ music: { ...music, volume: Math.round(v / 5) * 5 } })}
                />
              </div>
              <div className="ed-chips">
                {([true, false] as const).map((looped) => (
                  <button
                    key={String(looped)}
                    className={`ed-chip ${music.looped === looped ? "sel" : ""}`}
                    onClick={() => patchAudio({ music: { ...music, looped } })}
                    disabled={busy}
                  >
                    {t(looped ? "videoEditor.musicLoop" : "videoEditor.musicOnce")}
                  </button>
                ))}
              </div>
              <p className="ed-side-desc">{t("videoEditor.musicNote")}</p>
            </>
          ) : (
            <button className="ed-side-btn" onClick={() => void chooseMusic()} disabled={busy}>
              <MusicNoteIcon size={15} />
              <span>{t("videoEditor.chooseMusic")}</span>
            </button>
          )}
        </SideSection>
      </>
    );
  }

  function gifPanel() {
    return (
      <>
        <SideSection title={t("videoEditor.gifWidth")}>
          <div className="ed-chips">
            {GIF_WIDTHS.map((w) => (
              <button key={w} className={`ed-chip ${edit.gifWidth === w ? "sel" : ""}`} onClick={() => patch({ gifWidth: w })} disabled={busy}>
                {w} px
              </button>
            ))}
          </div>
        </SideSection>
        <SideSection title={t("videoEditor.gifRate")}>
          <div className="ed-chips">
            {GIF_RATES.map((r) => (
              <button key={r} className={`ed-chip ${edit.gifRate === r ? "sel" : ""}`} onClick={() => patch({ gifRate: r })} disabled={busy}>
                {r}
              </button>
            ))}
          </div>
        </SideSection>
        <p className="ed-side-desc">
          {gifOk
            ? t("videoEditor.gifEstimate", {
                size: formatBytes(estimateGifBytes(gifSize.w, gifSize.h, edit.gifRate, gifSeconds)),
                dims: `${gifSize.w} x ${gifSize.h}`,
                seconds: gifSeconds.toFixed(1),
              })
            : t("videoEditor.gifTooLong", { seconds: GIF_MAX_SECONDS })}
        </p>
        <button className="ed-save-option" onClick={() => void saveParts("gif")} disabled={busy || !gifOk}>
          <span className="ed-save-option-icon">
            <GifIcon size={20} />
          </span>
          <span className="ed-save-option-text">
            <span className="ed-save-option-title">{t("videoEditor.makeGif")}</span>
            <span className="ed-save-option-sub">{t(source.kind === "drive" ? "videoEditor.gifDriveSub" : "videoEditor.gifComputerSub")}</span>
          </span>
        </button>
      </>
    );
  }

  const savePanel = (
    <aside className="ed-side" aria-label={t("editor.saveSheet.title")}>
      <div className="ed-side-head">
        <span className="ed-side-title">{t("editor.saveSheet.title")}</span>
      </div>
      <div className="ed-side-body">
        <p className="ed-side-desc">
          {t(
            source.kind === "drive"
              ? "videoEditor.saveDrive"
              : source.picksPlace
                ? "videoEditor.saveComputerPickLinux"
                : "videoEditor.saveComputer",
          )}
        </p>
        {ranges.length > 1 && <p className="ed-side-desc">{t("videoEditor.splitBothNote")}</p>}
        <p className="ed-side-desc">{t("videoEditor.saveLength", { time: formatClock(keptOutMs) })}</p>
        <button className="ed-save-option" onClick={() => void saveParts("video")} disabled={busy || !dirty}>
          <span className="ed-save-option-icon">{source.kind === "drive" ? <CloudUploadIcon size={20} /> : <ContentCopyIcon size={20} />}</span>
          <span className="ed-save-option-text">
            <span className="ed-save-option-title">{t(source.kind === "drive" ? "editor.saveSheet.copyDrive" : "editor.saveSheet.copyComputer")}</span>
            <span className="ed-save-option-sub">{t(source.kind === "drive" ? "videoEditor.copyDriveSub" : "videoEditor.copyComputerSub")}</span>
          </span>
        </button>
        <button className="ed-side-btn wide" onClick={() => setSaveOpen(false)} disabled={busy}>
          <span>{t("common.cancel")}</span>
        </button>
      </div>
    </aside>
  );

  const panels: Record<Tab, ReactNode> = {
    trim: trimPanel(),
    crop: cropPanel(),
    look: lookPanel(),
    speed: speedPanel(),
    audio: audioPanel(),
    gif: gifPanel(),
  };
  const sidePanel = saveOpen ? (
    savePanel
  ) : (
    <aside className="ed-side" aria-label={t(TABS.find((x) => x.id === tab)!.label)}>
      <div className="ed-side-head">
        <span className="ed-side-title">{t(TABS.find((x) => x.id === tab)!.label)}</span>
      </div>
      <div className="ed-side-body">{panels[tab]}</div>
    </aside>
  );

  // ---- Render -------------------------------------------------------------------

  const ready = phase === "ready" && !!info;
  const videoBox = sidewaysTurn(edit.rotate) ? { w: layout.frameH, h: layout.frameW } : { w: layout.frameW, h: layout.frameH };
  const splitAt = edit.split?.atMs ?? null;

  return (
    <div className="ed-root ve-root" onClick={(e) => e.stopPropagation()}>
      <div className="ed-topbar">
        <button className="ed-bubble" onClick={requestCancel} disabled={busy} title={t("editor.back")} aria-label={t("editor.back")}>
          <ArrowBackIcon size={20} />
        </button>
        <div className="ed-topbar-right">
          <button className="ed-bubble dim" onClick={resetAll} disabled={busy || !dirty} title={t("editor.reset")} aria-label={t("editor.reset")}>
            <RestoreIcon size={18} />
          </button>
          <button
            className={`ed-save ${saveOpen ? "open" : ""}`}
            onClick={() => setSaveOpen((o) => !o)}
            disabled={busy || !ready}
            title={t("editor.save")}
            aria-label={t("editor.save")}
            aria-expanded={saveOpen}
          >
            {busy && !saved ? (
              <span className="ed-spin">
                <SpinnerIcon size={16} />
              </span>
            ) : (
              <CheckIcon size={20} />
            )}
          </button>
        </div>
      </div>

      <div className="ed-main">
        <div className="ed-stage" ref={stageRef}>
          {banner && <div className={`ed-banner ${banner.kind}`}>{banner.text}</div>}
          {ready && info ? (
            <div className="ed-canvas-wrap ve-wrap" style={{ width: layout.wrapW, height: layout.wrapH }}>
              <div
                className="ve-frame"
                style={{
                  width: layout.frameW,
                  height: layout.frameH,
                  left: layout.offX,
                  top: layout.offY,
                  transform: `scale(${edit.flipH ? -1 : 1}, ${edit.flipV ? -1 : 1})`,
                }}
              >
                <video
                  ref={videoRef}
                  className="ve-video"
                  src={info.url}
                  playsInline
                  preload="auto"
                  style={{
                    width: videoBox.w,
                    height: videoBox.h,
                    transform: `translate(-50%, -50%) rotate(${edit.rotate}deg)`,
                    filter: cssFilter(edit),
                  }}
                  onError={() => setCannotPlay(true)}
                  onPause={() => setPlaying(false)}
                  onPlay={() => setPlaying(true)}
                />
              </div>
              {cropping && layout.wrapW > 0 && (
                <div className="ed-overlay crop" onPointerDown={onCropDown} onPointerMove={onCropMove} onPointerUp={onCropUp}>
                  <CropOverlay box={shownCrop} boundsW={turned.w} boundsH={turned.h} dispW={layout.wrapW} dispH={layout.wrapH} />
                </div>
              )}
            </div>
          ) : (
            <p className="ed-stage-msg">{loadNote}</p>
          )}
          {cannotPlay && ready && <div className="ed-banner error ve-noplay">{t("videoEditor.cannotPlay")}</div>}
          {job && (
            <div className="ve-job" role="status">
              <span className="ve-job-label">
                {job.label}
                {job.value >= 0 ? ` ${Math.round(job.value * 100)}%` : ""}
              </span>
              <div className={`ve-bar ${job.value < 0 ? "wait" : ""}`}>
                <i style={{ width: job.value >= 0 ? `${Math.round(job.value * 100)}%` : "40%" }} />
              </div>
              {job.stage === "making" && (
                <button className="ed-side-btn" onClick={stopJob}>
                  <span>{t("common.cancel")}</span>
                </button>
              )}
            </div>
          )}
        </div>
        {ready && <div className="ed-side-slot">{sidePanel}</div>}
      </div>

      <div className="ed-bottom">
        {ready && (
          <div className="ve-dock">
            <div className="ve-row">
              <button className="ed-bubble" onClick={togglePlay} disabled={busy} title={`${t(playing ? "videoEditor.pause" : "videoEditor.play")} (Space)`} aria-label={t(playing ? "videoEditor.pause" : "videoEditor.play")}>
                {playing ? <PauseIcon size={20} /> : <PlayArrowIcon size={20} />}
              </button>
              <span className="ve-time">
                <b>{formatClock(playMs)}</b> / {formatClock(durationMs)}
              </span>
              <span className="ve-grow" />
              <span className="ve-time ve-range">
                {t("videoEditor.start")} <b>{formatClock(edit.startMs)}</b> {t("videoEditor.end")} <b>{formatClock(edit.endMs)}</b> {t("videoEditor.length")}{" "}
                <b>{formatClock(edit.endMs - edit.startMs)}</b>
              </span>
              <span className="ve-grow" />
              <button
                className="ve-tool"
                onClick={() => {
                  setTab("trim");
                  setSaveOpen(false);
                  if (canSplitAt(edit, playMs)) patch({ split: { atMs: playMs, both: false } });
                }}
                disabled={busy || !canSplitAt(edit, playMs)}
                title={t("videoEditor.splitHere")}
              >
                <ContentCutIcon size={15} />
                {t("videoEditor.split")}
              </button>
              <button className="ve-tool" onClick={() => void grabFrame()} disabled={busy} title={t("videoEditor.grab")}>
                <PhotoCameraIcon size={15} />
                {t("videoEditor.grab")}
              </button>
              <button
                className="ve-tool"
                onClick={() => patchAudio({ mute: !edit.audio.mute })}
                disabled={busy || !info?.hasAudio}
                aria-pressed={edit.audio.mute}
                title={t("videoEditor.mute")}
                aria-label={t("videoEditor.mute")}
              >
                {edit.audio.mute ? <VolumeOffIcon size={16} /> : <VolumeUpIcon size={16} />}
              </button>
            </div>
            <div className="ve-track-wrap">
              <div
                className="ve-track"
                ref={trackRef}
                onPointerDown={onTrackDown}
                onPointerMove={onTrackMove}
                onPointerUp={onTrackUp}
                onPointerCancel={onTrackUp}
              >
                <div className="ve-frames" style={strip ? { backgroundImage: `url(${strip})` } : undefined} />
                <div className="ve-dim" style={{ left: 0, width: `${pct(edit.startMs)}%` }} />
                <div className="ve-dim" style={{ left: `${pct(edit.endMs)}%`, right: 0 }} />
                <div className="ve-sel" style={{ left: `${pct(edit.startMs)}%`, width: `${pct(edit.endMs - edit.startMs)}%` }} />
                {splitAt != null && <div className="ve-split" style={{ left: `${pct(splitAt)}%` }} />}
                <div
                  className="ve-handle start"
                  data-handle="start"
                  style={{ left: `${pct(edit.startMs)}%` }}
                  role="slider"
                  tabIndex={0}
                  aria-label={t("videoEditor.start")}
                  aria-valuemin={0}
                  aria-valuemax={durationMs}
                  aria-valuenow={edit.startMs}
                  aria-valuetext={formatClock(edit.startMs)}
                  onKeyDown={(e) => onHandleKey("start", e)}
                />
                <div
                  className="ve-handle end"
                  data-handle="end"
                  style={{ left: `${pct(edit.endMs)}%` }}
                  role="slider"
                  tabIndex={0}
                  aria-label={t("videoEditor.end")}
                  aria-valuemin={0}
                  aria-valuemax={durationMs}
                  aria-valuenow={edit.endMs}
                  aria-valuetext={formatClock(edit.endMs)}
                  onKeyDown={(e) => onHandleKey("end", e)}
                />
                <div className="ve-head" style={{ left: `${pct(playMs)}%` }} />
              </div>
              <div className="ve-ruler">
                {rulerTicks(durationMs).map((s) => (
                  <i key={s} style={{ left: `${pct(s * 1000)}%` }}>
                    {s}s
                  </i>
                ))}
              </div>
            </div>
          </div>
        )}
        <div className="ed-tabs" role="tablist">
          {TABS.map(({ id, label, Icon }) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              className={`ed-tab ve-tab ${tab === id ? "sel" : ""}`}
              onClick={() => {
                setTab(id);
                setSaveOpen(false);
              }}
              disabled={!ready}
              title={t(label)}
              aria-label={t(label)}
            >
              <span className="ed-tab-icon">
                <Icon size={24} />
              </span>
              <span className="ed-tab-label">{t(label)}</span>
            </button>
          ))}
        </div>
      </div>

      {confirmDiscard && (
        <Confirm
          title={t("editor.discardTitle")}
          message={t("editor.discardBody")}
          confirmLabel={t("editor.discardConfirm")}
          danger
          onCancel={() => setConfirmDiscard(false)}
          onConfirm={() => {
            setConfirmDiscard(false);
            leave();
          }}
        />
      )}
    </div>
  );
}
