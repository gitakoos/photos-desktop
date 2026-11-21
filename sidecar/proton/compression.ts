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

// Compression on upload, as the phone has it: a photo re-encoded to a lighter JPEG and a video
// transcoded with Windows' own encoders, each only when it comes out smaller, so a lighter copy
// reaches Drive while the file on the PC is never touched. The choices are the phone's: three
// quality levels for each kind, and for videos the codec. Every refusal is an upload of the
// original, never a failed upload.

import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, open, readdir, rm, stat, statfs } from "node:fs/promises";
import { fileHasMotionClip } from "./motionPhoto.ts";
import { basename, extname, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";

import sharp, { type Sharp } from "sharp";

import { diag } from "./diag.ts";
import { hostCall } from "./hostCall.ts";

export type CompressionTier = "high" | "balanced" | "small";
export type VideoCodec = "avc" | "hevc" | "av1";
export type VideoCodecChoice = "auto" | VideoCodec | "keep";

export type CompressionSettings = {
  photos: boolean;
  /** An HDR photo (a JPEG with a gain map) is compressed too, its gain map kept. */
  hdr: boolean;
  tier: CompressionTier;
  videos: boolean;
  videoTier: CompressionTier;
  codec: VideoCodecChoice;
  /**
   * A file put in the Proton Photos folder (File Explorer, or the file-manager drive) is
   * compressed too, and the lighter copy is what the folder then holds. Off, it goes up as it is.
   */
  local: boolean;
};

export const NO_COMPRESSION: CompressionSettings = {
  photos: false,
  hdr: false,
  tier: "balanced",
  videos: false,
  videoTier: "balanced",
  codec: "avc",
  local: false,
};

/**
 * Each level as the phone's: the JPEG quality and longest-edge cap (0 keeps the size) a photo is
 * written at, and the short-side and frame-rate caps (0 and null keep the source's) of a video.
 */
export const TIERS: Record<CompressionTier, { quality: number; maxLongEdge: number; videoMaxShortEdge: number; videoMaxFps: number | null }> = {
  high: { quality: 90, maxLongEdge: 0, videoMaxShortEdge: 0, videoMaxFps: null },
  balanced: { quality: 80, maxLongEdge: 4096, videoMaxShortEdge: 1080, videoMaxFps: null },
  small: { quality: 70, maxLongEdge: 2560, videoMaxShortEdge: 720, videoMaxFps: 30 },
};

const TIER_KEYS = new Set<CompressionTier>(["high", "balanced", "small"]);
const CODEC_KEYS = new Set<VideoCodecChoice>(["auto", "avc", "hevc", "av1", "keep"]);

/** The settings as the window sends them, with anything unknown read as the default. */
export function readCompressionSettings(raw: any): CompressionSettings {
  const tier = (v: unknown, fallback: CompressionTier) => (TIER_KEYS.has(v as CompressionTier) ? (v as CompressionTier) : fallback);
  return {
    photos: raw?.photos === true,
    hdr: raw?.hdr === true,
    tier: tier(raw?.tier, NO_COMPRESSION.tier),
    videos: raw?.videos === true,
    videoTier: tier(raw?.videoTier, NO_COMPRESSION.videoTier),
    codec: CODEC_KEYS.has(raw?.codec) ? raw.codec : NO_COMPRESSION.codec,
    local: raw?.local === true,
  };
}

let current: CompressionSettings = NO_COMPRESSION;

export function setCompression(settings: CompressionSettings): void {
  current = settings;
}

export function compression(): CompressionSettings {
  return current;
}

/** Why a file went up as it was. */
export type SkipReason =
  | "format"
  | "animated"
  | "motion"
  | "transparent"
  | "hdr"
  | "not-smaller"
  | "unreadable"
  | "too-short"
  | "efficient"
  | "codec"
  | "failed";

/** Why a video's copy was dropped after the plan: no room, a wrong copy, no gain, or a stop. */
export type KeptReason = SkipReason | "no-space" | "bad-copy" | "cancelled";

const kept = new Map<string, number>();

/** Notes that a file went up as it was, and why, for the diagnostics report. */
export function noteKept(kind: "photo" | "video", reason: KeptReason): void {
  const key = `${kind} ${reason}`;
  kept.set(key, (kept.get(key) ?? 0) + 1);
  process.stderr.write(`[compress] ${kind} kept as it is: ${reason}\n`);
}

/** How many files went up as they were since the app started, by kind and reason. */
export function keptCounts(): Record<string, number> {
  return Object.fromEntries([...kept].sort(([a], [b]) => a.localeCompare(b)));
}

/** Forgets the counts; for tests. */
export function resetKeptCounts(): void {
  kept.clear();
}

const COMPRESS_DIR = "pfp-compress";

/**
 * Where the lighter copies are written, each deleted once its upload is done with. The tests give each
 * of their processes its own through PFP_COMPRESS_DIR, taken only as a folder of that name, since a
 * sweep empties it.
 */
export function compressionDir(): string {
  const named = process.env.PFP_COMPRESS_DIR;
  return named && isAbsolute(named) && basename(named) === COMPRESS_DIR ? named : join(tmpdir(), COMPRESS_DIR);
}

/** Makes the folder of the lighter copies, readable by this user only where the system has owners. */
export async function makeCompressionDir(): Promise<void> {
  await mkdir(compressionDir(), { recursive: true, mode: 0o700 });
}

/** The temporary files work still running uses: a sweep on a lock leaves them to that work, which deletes them. */
const inUse = new Set<string>();

/** Marks a temporary file as used by work still running. */
export function holdTemp(path: string): void {
  // The uploads delete their copies without saying so: those already gone are let go of here.
  if (inUse.size >= 256) for (const held of inUse) if (!existsSync(held)) inUse.delete(held);
  inUse.add(path);
}

/** The work that used a temporary file is through with it. */
export function releaseTemp(path: string): void {
  inUse.delete(path);
}

/** Whether a file or folder belongs to the user this process runs as; anything goes where the system has no owners. */
function ownedHere(info: { uid: number }): boolean {
  return typeof process.getuid !== "function" || info.uid === process.getuid();
}

/**
 * Deletes what is left in the folder of the lighter copies (decrypted originals and copies a crash, a
 * forced quit or a failed delete left behind): at the sidecar's start, and on a lock or a sign-out.
 * Only plain files of this user, never through a link: a folder that is a link, or another user's,
 * is left alone, and so is a file work still running uses (`holdTemp`). Answers how many went.
 */
export async function sweepCompressionTemp(dir = compressionDir()): Promise<number> {
  const folder = await lstat(dir).catch(() => null);
  if (!folder || !folder.isDirectory() || !ownedHere(folder)) return 0;
  const names = await readdir(dir).catch(() => [] as string[]);
  let removed = 0;
  for (const name of names) {
    const path = join(dir, name);
    const info = await lstat(path).catch(() => null);
    if (!info) {
      inUse.delete(path);
      continue;
    }
    if (inUse.has(path) || !info.isFile() || !ownedHere(info)) continue;
    try {
      await rm(path, { force: true });
      removed++;
    } catch {
      /* in use by another program: the next sweep takes it */
    }
  }
  for (const path of inUse) {
    if (path.startsWith(dir) && !(await lstat(path).catch(() => null))) inUse.delete(path);
  }
  return removed;
}

/** The name a re-encoded photo goes up under: the original's, as a JPEG. */
export function jpegName(name: string): string {
  const ext = extname(name);
  if (/^\.jpe?g$/i.test(ext)) return name;
  return `${ext ? name.slice(0, -ext.length) : name}.jpg`;
}

/** The name a transcoded video goes up under: the original's, as an MP4. */
export function mp4Name(name: string): string {
  const ext = extname(name);
  if (/^\.mp4$/i.test(ext)) return name;
  return `${ext ? name.slice(0, -ext.length) : name}.mp4`;
}

/** A temp name for a copy of `path`, its own for every copy made: the same file in two uploads at
 *  once gets two, so one upload finishing never deletes the copy the other is still sending. */
export function tempFor(path: string, size: number, key: string, ext: string): string {
  const id = createHash("sha1").update(`${path}\u0000${size}\u0000${key}`).digest("hex").slice(0, 20);
  const out = join(compressionDir(), `${id}-${randomUUID().slice(0, 8)}${ext}`);
  holdTemp(out);
  return out;
}

/** The stills sharp can read and a JPEG can stand in for; HEIC, RAW and GIF go up as they are. */
const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/tiff", "image/avif"]);

export type PhotoCompressed = { path: string; name: string; size: number; sourceSize: number };

/**
 * A lighter JPEG of the photo at `path`, at the level `settings` asks: turned upright, its longest
 * edge capped, its EXIF and colour profile kept. Null with the reason when the original should go
 * up instead: a format a JPEG would harm (animated, transparent, a motion photo's clip), an HDR photo unless asked for
 * (then its gain map is kept), or a copy that came out no smaller. The same file at the same
 * settings makes the same bytes, so an upload of it again is found already in the library.
 */
export async function compressPhoto(
  path: string,
  mediaType: string,
  settings: CompressionSettings,
): Promise<{ copy: PhotoCompressed } | { skipped: SkipReason }> {
  if (!PHOTO_TYPES.has(mediaType)) return { skipped: "format" };
  let out: string | null = null;
  try {
    const sourceSize = (await stat(path)).size;
    const meta = await sharp(path, { failOn: "none" }).metadata();
    if ((meta.pages ?? 1) > 1) return { skipped: "animated" };
    // A re-encode keeps only the picture, so a motion photo would lose its clip.
    if (await fileHasMotionClip(path, mediaType)) return { skipped: "motion" };
    const hdr = !!meta.gainMap;
    if (hdr && !settings.hdr) return { skipped: "hdr" };
    if (meta.hasAlpha && !(await sharp(path, { failOn: "none" }).stats()).isOpaque) return { skipped: "transparent" };

    const tier = TIERS[settings.tier];
    let img = sharp(path, { failOn: "none" });
    // The gain map is resized with the picture and written back beside it.
    // (Only in sharp's own code so far, not yet in its typings.)
    if (hdr) img = (img as Sharp & { keepGainMap(): Sharp }).keepGainMap();
    img = img.rotate();
    if (tier.maxLongEdge > 0) {
      img = img.resize({ width: tier.maxLongEdge, height: tier.maxLongEdge, fit: "inside", withoutEnlargement: true });
    }
    img = img.jpeg({ quality: tier.quality, mozjpeg: true }).keepExif().keepIccProfile();
    await makeCompressionDir();
    out = tempFor(path, sourceSize, `photo:${settings.tier}:${hdr}`, ".jpg");
    await img.toFile(out);
    const size = (await stat(out)).size;
    if (size <= 0 || size >= sourceSize) {
      await rm(out, { force: true });
      return { skipped: "not-smaller" };
    }
    return { copy: { path: out, name: jpegName(basename(path)), size, sourceSize } };
  } catch {
    if (out) await rm(out, { force: true }).catch(() => {});
    return { skipped: "failed" };
  }
}

// ---- Videos ----

/** What the app's ffprobe read off a video, as the host answers `videoProbe`. */
export type VideoProbe = {
  width: number;
  height: number;
  /** Frames a second, 0 when unknown. */
  fps: number;
  durationMs: number;
  /** The video stream's bitrate, 0 when the container does not say. */
  videoBitrate: number;
  audioBitrate: number;
  hasAudio: boolean;
  codec: VideoCodec | "other";
  /** An HDR curve: PQ (HDR10 and most Dolby Vision) or HLG. */
  hdr: boolean;
  transfer: "sdr" | "pq" | "hlg";
  /** The colour primaries as ffprobe names them, "bt2020" or "bt709"; empty when unsaid. */
  primaries: string;
  bitDepth: number;
  /** Dolby Vision with no base picture other players show right: no copy here has its colours. */
  dolbyVisionOnly: boolean;
  size: number;
};

/**
 * The encoders this PC has: H.264 in any form, H.265 and AV1 on the graphics card, and whether
 * the H.265 and AV1 ones write the 10 bits an HDR copy needs.
 */
export type VideoEncoders = { avc: boolean; hevc: boolean; av1: boolean; hevcHdr: boolean; av1Hdr: boolean };

/** What a copy does with an HDR source's colour: none for an SDR source. */
export type HdrHandling = "none" | "keep" | "tone-map";

export type VideoPlan = {
  codec: VideoCodec;
  width: number;
  height: number;
  fps: number | null;
  bitrate: number;
  hdr: HdrHandling;
};

/** The phone's bitrate model: bits per pixel per codec and level, at each level's reference size. */
const BITS_PER_PIXEL: Record<CompressionTier, Record<VideoCodec, number>> = {
  high: { avc: 0.13, hevc: 0.088, av1: 0.072 },
  balanced: { avc: 0.08, hevc: 0.056, av1: 0.048 },
  small: { avc: 0.09, hevc: 0.065, av1: 0.054 },
};
const FLOOR_BPS = 400_000;
const SOURCE_CEILING_FRACTION = 0.8;
const ALREADY_EFFICIENT_MARGIN = 1.1;
const MAX_FPS_FOR_BITRATE = 60;
const DEFAULT_FPS = 30;
const DEFAULT_AUDIO_BPS = 128_000;
const PIXEL_EXPONENT = 0.75;
const MIN_DURATION_MS = 1_000;
/** A 30.02 fps camera clip is not above a 30 fps cap. */
const FPS_TOLERANCE = 1.5;
/** A copy that keeps HDR keeps 10-bit colour, so it gets a quarter more bits, as on the phone. */
const HDR_MULTIPLIER = 1.25;

/** The bitrate a compressed video aims for, before the floor and the source's own ceiling. */
export function targetBitrate(
  codec: VideoCodec,
  tier: CompressionTier,
  width: number,
  height: number,
  fps: number,
  keepsHdr = false,
): number {
  const fpsTerm = fps > 0 ? Math.min(fps, MAX_FPS_FOR_BITRATE) : DEFAULT_FPS;
  const reference = tier === "small" ? 1280 * 720 : 1920 * 1080;
  const pixels = reference * Math.pow((width * height) / reference, PIXEL_EXPONENT);
  return Math.floor(BITS_PER_PIXEL[tier][codec] * pixels * fpsTerm * (keepsHdr ? HDR_MULTIPLIER : 1));
}

/** The codecs to try for a choice, best first; H.265 and AV1 need a hardware encoder. */
function candidates(choice: VideoCodecChoice, source: VideoProbe["codec"]): VideoCodec[] {
  switch (choice) {
    case "auto":
    case "hevc":
      return ["hevc", "avc"];
    case "av1":
      return ["av1", "hevc", "avc"];
    case "keep":
      return source === "other" || source === "avc" ? ["avc"] : [source, "avc"];
    default:
      return ["avc"];
  }
}

/** The codec a video is written in on this PC, or null when it has no encoder for any of them. */
export function resolveCodec(choice: VideoCodecChoice, source: VideoProbe["codec"], encoders: VideoEncoders): VideoCodec | null {
  return candidates(choice, source).find((c) => encoders[c]) ?? null;
}

const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

/** Whether this PC writes `codec` in the 10 bits that keep an HDR video HDR. */
function keepsHdr(codec: VideoCodec, encoders: VideoEncoders): boolean {
  return codec === "hevc" ? encoders.hevcHdr : codec === "av1" ? encoders.av1Hdr : false;
}

/**
 * How to transcode a video, or why it goes up as it is: unreadable or under a second, Dolby Vision
 * with no base picture, no encoder, or already at about the bitrate it would get. Nothing is
 * scaled up; a level's short-side and frame-rate caps apply, and the bitrate never goes above 80%
 * of the source's own. An HDR video keeps its HDR in H.265 or AV1 when the encoder writes 10 bits,
 * and is tone-mapped to SDR otherwise, H.264 always, as on the phone.
 */
export function planVideo(probe: VideoProbe, settings: CompressionSettings, encoders: VideoEncoders): VideoPlan | { skipped: SkipReason } {
  if (probe.width <= 0 || probe.height <= 0 || probe.size <= 0 || probe.durationMs <= 0) return { skipped: "unreadable" };
  if (probe.durationMs < MIN_DURATION_MS) return { skipped: "too-short" };
  if (probe.dolbyVisionOnly) return { skipped: "hdr" };
  const codec = resolveCodec(settings.codec, probe.codec, encoders);
  if (!codec) return { skipped: "codec" };
  const hdr: HdrHandling = !probe.hdr ? "none" : keepsHdr(codec, encoders) ? "keep" : "tone-map";
  const tier = TIERS[settings.videoTier];

  const short = Math.min(probe.width, probe.height);
  const scale = tier.videoMaxShortEdge > 0 && short > tier.videoMaxShortEdge ? tier.videoMaxShortEdge / short : 1;
  const width = scale < 1 ? even(probe.width * scale) : probe.width;
  const height = scale < 1 ? even(probe.height * scale) : probe.height;
  const fpsCap = tier.videoMaxFps !== null && probe.fps > tier.videoMaxFps + FPS_TOLERANCE ? tier.videoMaxFps : null;
  const fps = fpsCap ?? (probe.fps > 0 ? probe.fps : DEFAULT_FPS);

  const target = Math.max(FLOOR_BPS, targetBitrate(codec, settings.videoTier, width, height, fps, hdr === "keep"));
  const audio = !probe.hasAudio ? 0 : probe.audioBitrate > 0 ? probe.audioBitrate : DEFAULT_AUDIO_BPS;
  const estimated = Math.floor((probe.size * 8000) / probe.durationMs - audio);
  const source = probe.videoBitrate > 0 ? probe.videoBitrate : estimated > 0 ? estimated : 0;
  if (source > 0 && source <= target * ALREADY_EFFICIENT_MARGIN) return { skipped: "efficient" };
  const bitrate = source > 0 ? Math.min(target, Math.floor(source * SOURCE_CEILING_FRACTION)) : target;
  return { codec, width, height, fps: fpsCap, bitrate, hdr };
}

/**
 * Whether a copy has the colour its plan asked for: an HDR copy 10 bits or more with the source's
 * curve on BT.2020, a tone-mapped one SDR on BT.709. An SDR source's copy is not checked here.
 */
export function colourKept(plan: VideoPlan, source: VideoProbe, copy: VideoProbe): boolean {
  if (plan.hdr === "keep") return copy.transfer === source.transfer && copy.bitDepth >= 10 && copy.primaries === "bt2020";
  if (plan.hdr === "tone-map") return copy.transfer === "sdr" && copy.bitDepth === 8 && copy.primaries === "bt709";
  return true;
}

/** Bytes a minute of video takes at `bitrate`, with the usual audio beside it. */
export function bytesPerMinute(bitrate: number): number {
  return Math.round(((bitrate + DEFAULT_AUDIO_BPS) * 60) / 8);
}

/** The temp file a video is transcoded into. */
export async function videoTempFor(path: string, plan: VideoPlan): Promise<string> {
  await makeCompressionDir();
  const size = (await stat(path)).size;
  return tempFor(path, size, `video:${plan.codec}:${plan.width}x${plan.height}:${plan.fps}:${plan.bitrate}:${plan.hdr}`, ".mp4");
}

// ---- The capture time in a transcoded MP4 ----

/** Seconds from 1904, the MP4 epoch, to 1970. */
const MP4_EPOCH_OFFSET = 2_082_844_800;
const CONTAINERS = new Set(["moov", "trak", "mdia"]);

/**
 * Writes `at` as the creation and modification time of the movie, each track and each track's
 * media in an MP4, in place: a transcode stamps the moment it ran, and a download of the video
 * would otherwise date it then. Only the fixed-size fields are rewritten; answers how many boxes.
 */
export async function setMp4Times(path: string, at: Date): Promise<number> {
  const seconds = BigInt(Math.floor(at.getTime() / 1000) + MP4_EPOCH_OFFSET);
  if (seconds <= 0n) return 0;
  const file = await open(path, "r+");
  try {
    const size = (await file.stat()).size;
    let written = 0;
    const head = Buffer.alloc(16);
    const walk = async (start: number, end: number): Promise<void> => {
      let pos = start;
      while (pos + 8 <= end) {
        await file.read(head, 0, 16, pos);
        let boxSize = head.readUInt32BE(0);
        const type = head.toString("latin1", 4, 8);
        let header = 8;
        if (boxSize === 1) {
          boxSize = Number(head.readBigUInt64BE(8));
          header = 16;
        } else if (boxSize === 0) {
          boxSize = end - pos;
        }
        if (boxSize < header || pos + boxSize > end) return;
        if (CONTAINERS.has(type)) {
          await walk(pos + header, pos + boxSize);
        } else if (type === "mvhd" || type === "tkhd" || type === "mdhd") {
          const body = pos + header;
          const version = Buffer.alloc(1);
          await file.read(version, 0, 1, body);
          const times = Buffer.alloc(version[0] === 1 ? 16 : 8);
          if (version[0] === 1) {
            times.writeBigUInt64BE(seconds, 0);
            times.writeBigUInt64BE(seconds, 8);
          } else {
            const s = Number(seconds & 0xffffffffn);
            times.writeUInt32BE(s, 0);
            times.writeUInt32BE(s, 4);
          }
          await file.write(times, 0, times.length, body + 4);
          written++;
        }
        pos += boxSize;
      }
    };
    await walk(0, size);
    return written;
  } finally {
    await file.close();
  }
}

// ---- Compressing one file for its upload ----

/** A lighter copy made for an upload: what goes up in place of the original. */
export type PreparedCopy = {
  path: string;
  name: string;
  mediaType: string;
  size: number;
  sourceSize: number;
  /** The copy's frame against the original's, for the dimensions sent with it. */
  scale: number;
};

/** One transcode at a time: the encoders are the machine's, and photos keep going meanwhile. */
let lane: Promise<unknown> = Promise.resolve();
let laneUsers = 0;

/** Whether a video is being transcoded or waits to be, so a worker can take a photo first. */
export function videoLaneBusy(): boolean {
  return laneUsers > 0;
}

function inLane<T>(work: () => Promise<T>): Promise<T> {
  laneUsers++;
  const run = lane.then(work, work);
  lane = run.catch(() => undefined);
  return run.finally(() => {
    laneUsers--;
  });
}

let encoderList: Promise<VideoEncoders> | null = null;
/** Codecs whose encoder wrote another frame size than asked: passed over for the rest of the run. */
const wayward = new Set<VideoCodec>();
/** Codecs whose encoder failed to keep an HDR video's HDR: tone-mapped for the rest of the run. */
const hdrRefused = new Set<VideoCodec>();

/** Whether a file of `mediaType` would be compressed with the settings as they are. */
export function wouldCompress(mediaType: string): boolean {
  const s = compression();
  return mediaType.startsWith("video/") ? s.videos : PHOTO_TYPES.has(mediaType) && s.photos;
}

/**
 * The lighter copy of `path` to upload in its place, or null to upload the original: with the
 * kind's compression off, or whenever the copy would not be right or not smaller. `capturedAt`
 * is written into a video copy, which a transcode would otherwise date to now.
 */
export async function compressForUpload(
  path: string,
  mediaType: string,
  capturedAt: Date,
  signal: AbortSignal,
  onProgress?: (value: number) => void,
): Promise<PreparedCopy | null> {
  return compressWith(compression(), path, mediaType, capturedAt, signal, onProgress);
}

/**
 * The lighter copy of `path` at the chosen levels whether or not compression is switched on for
 * uploads: what Compress on Drive makes of a photo already there. Null to keep the original.
 */
export async function compressExisting(
  path: string,
  mediaType: string,
  capturedAt: Date,
  signal: AbortSignal,
  onProgress?: (value: number) => void,
): Promise<PreparedCopy | null> {
  return compressWith({ ...compression(), photos: true, videos: true }, path, mediaType, capturedAt, signal, onProgress);
}

/** Whether Compress on Drive can make a lighter copy of a file of `mediaType`. */
export function canCompressType(mediaType: string): boolean {
  return mediaType.startsWith("video/") || PHOTO_TYPES.has(mediaType);
}

async function compressWith(
  settings: CompressionSettings,
  path: string,
  mediaType: string,
  capturedAt: Date,
  signal: AbortSignal,
  onProgress?: (value: number) => void,
): Promise<PreparedCopy | null> {
  if (mediaType.startsWith("video/")) {
    if (!settings.videos) return null;
    return compressVideo(path, settings, capturedAt, signal, onProgress);
  }
  if (!settings.photos) return null;
  const result = await compressPhoto(path, mediaType, settings);
  if (!("copy" in result)) {
    if (result.skipped !== "format") noteKept("photo", result.skipped);
    return null;
  }
  const scale = await sharp(result.copy.path)
    .metadata()
    .then(async (out) => {
      const src = await sharp(path, { failOn: "none" }).metadata();
      const long = (m: { width?: number; height?: number }) => Math.max(m.width ?? 0, m.height ?? 0);
      return long(src) > 0 ? long(out) / long(src) : 1;
    })
    .catch(() => 1);
  return { ...result.copy, mediaType: "image/jpeg", scale };
}

async function compressVideo(
  path: string,
  settings: CompressionSettings,
  capturedAt: Date,
  signal: AbortSignal,
  onProgress?: (value: number) => void,
): Promise<PreparedCopy | null> {
  try {
    encoderList ??= hostCall<VideoEncoders>("videoEncoders", {});
    const encoders = await encoderList;
    const probe = await hostCall<VideoProbe & { rotation: number }>("videoProbe", { path }, undefined, signal);
    for (;;) {
      const usable: VideoEncoders = {
        avc: encoders.avc && !wayward.has("avc"),
        hevc: encoders.hevc && !wayward.has("hevc"),
        av1: encoders.av1 && !wayward.has("av1"),
        hevcHdr: encoders.hevcHdr === true && !hdrRefused.has("hevc"),
        av1Hdr: encoders.av1Hdr === true && !hdrRefused.has("av1"),
      };
      const plan = planVideo(probe, settings, usable);
      if ("skipped" in plan) {
        noteKept("video", plan.skipped);
        return null;
      }
      const free = await statfs(tmpdir()).then((s) => s.bavail * s.bsize, () => Number.POSITIVE_INFINITY);
      if (free < probe.size + FREE_MARGIN) {
        noteKept("video", "no-space");
        return null;
      }
      const dst = await videoTempFor(path, plan);
      const started = Date.now();
      // A copy that was to keep HDR and did not is made again tone-mapped, never sent as it is.
      const refuseHdr = async (why: string) => {
        await rm(dst, { force: true });
        hdrRefused.add(plan.codec);
        process.stderr.write(`[compress] the ${plan.codec} encoder did not keep HDR (${why}), tone-mapping instead\n`);
      };
      try {
        await inLane(() =>
          hostCall(
            "videoTranscode",
            {
              src: path,
              dst,
              codec: plan.codec,
              width: plan.width,
              height: plan.height,
              bitrate: plan.bitrate,
              fps: plan.fps,
              rotation: probe.rotation,
              hdr: plan.hdr,
              transfer: probe.transfer,
            },
            onProgress,
            signal,
          ),
        );
      } catch (e) {
        if (signal.aborted || plan.hdr !== "keep" || (e as Error)?.message === "cancelled") throw e;
        await refuseHdr("it stopped");
        continue;
      }
      const out = await hostCall<VideoProbe & { rotation: number }>("videoProbe", { path: dst }, undefined, signal);
      if (!colourKept(plan, probe, out)) {
        if (plan.hdr === "keep") {
          await refuseHdr(`${out.transfer}, ${out.bitDepth} bits`);
          continue;
        }
        await rm(dst, { force: true });
        noteKept("video", "bad-copy");
        return null;
      }
      // An encoder may round the frame up to its block size, never more than that.
      const framed = Math.abs(out.width - plan.width) <= 16 && Math.abs(out.height - plan.height) <= 16;
      if (!framed || out.rotation !== probe.rotation) {
        await rm(dst, { force: true });
        if (!framed && plan.codec !== "avc") {
          wayward.add(plan.codec);
          process.stderr.write(`[compress] the ${plan.codec} encoder wrote another frame size, trying the next codec\n`);
          continue;
        }
        noteKept("video", "bad-copy");
        return null;
      }
      if (out.size <= 0 || out.size >= probe.size) {
        await rm(dst, { force: true });
        noteKept("video", "not-smaller");
        return null;
      }
      await setMp4Times(dst, capturedAt).catch(() => 0);
      diag.log("upload", "compress_video", {
        s: Math.round((Date.now() - started) / 1000),
        codec: plan.codec,
        hdr: plan.hdr,
        short: Math.min(plan.width, plan.height),
        mb_in: Math.round(probe.size / 1048576),
        mb_out: Math.round(out.size / 1048576),
      });
      return {
        path: dst,
        name: mp4Name(basename(path)),
        mediaType: "video/mp4",
        size: out.size,
        sourceSize: probe.size,
        scale: plan.width / probe.width,
      };
    }
  } catch (e) {
    if (signal.aborted) throw e;
    noteKept("video", (e as Error)?.message === "cancelled" ? "cancelled" : "failed");
    return null;
  }
}

/** Room left beside a video's copy, so a transcode never fills the disk. */
const FREE_MARGIN = 512 * 1024 * 1024;
