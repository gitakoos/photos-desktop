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

/**
 * Grid thumbnails (and, at `<uid>/v`, videos to play, a byte range at a time) served to
 * the window over loopback HTTP, the way a web page gets its
 * images: the webview fetches several at once, decodes them off its main thread, and
 * never waits on the one request channel to the host. Before, each thumbnail crossed
 * that channel as base64 inside JSON, a batch at a time behind whatever else was queued,
 * and was parsed on the main thread, which is what made a large library load late.
 *
 * Reachable by nothing but the app's own window:
 *   - it listens on 127.0.0.1 only, so nothing on the network can connect;
 *   - every request names a 256-bit token minted at unlock and dropped at lock, which
 *     lives only in this process and the window, so another program or a web page in a
 *     browser cannot guess a URL;
 *   - the Host header must be this address exactly, so a hostname rebound to 127.0.0.1
 *     by a web page is refused;
 *   - a CORS header is sent to the app's own window and nothing else (see APP_ORIGINS), so
 *     no other origin can read a response;
 *   - responses carry `no-store`: the webview must not keep a decrypted thumbnail in its
 *     own disk cache, where the only copy on disk until now has been the sealed one.
 */

import { createServer, type Server } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { parseFaceBox, type FaceBox } from "./faceCover.ts";
import { parseRange, type VideoSource } from "./videoStream.ts";
import { diag } from "./diag.ts";
import { thumbWidthFor } from "./thumbSizes.ts";

/**
 * The origins the app's own window runs at: Tauri's on Linux and macOS, and on Windows. Not
 * the dev server's: any other local server on that port could then read thumbnails, and in
 * development the grid makes do with its page fallback. The canvas timeline fetches thumbnails from a worker (see the window's
 * tileWorker) rather than through <img>, and a fetch across origins may read the answer only
 * if the server says its origin may. Only these are told so; every other origin reads
 * nothing, as before, and still needs the token to ask at all.
 */
export const APP_ORIGINS: ReadonlySet<string> = new Set([
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
]);

/** The CORS headers for a request from `origin`: none unless it is the app's window. */
function corsFor(origin: string | undefined): Record<string, string> {
  return origin && APP_ORIGINS.has(origin) ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : { Vary: "Origin" };
}

/**
 * The bytes of one grid thumbnail, or null when there is none to give. `gone` fires when
 * the webview stops waiting, as it does for a tile scrolled away, so the thumbnail is not
 * fetched ahead of the ones still on screen.
 */
export type ThumbnailSource = (uid: string, gone: AbortSignal, width?: number) => Promise<Buffer | null>;

/** A person's cover cut to the face in `box`, for `/t/<token>/<uid>/f/<l,t,r,b>`. */
export type FaceSource = (uid: string, box: FaceBox, gone: AbortSignal, width?: number) => Promise<Buffer | null>;

/** A video to play, for `/t/<token>/<uid>/v`, read a byte range at a time. */
export type VideoLookup = (uid: string) => Promise<VideoSource | null>;

/** A node uid: base64url halves joined by a tilde. Anything else is refused unread. */
const UID_SHAPE = /^[A-Za-z0-9_=~-]{1,256}$/;

let server: Server | null = null;
let port = 0;
let token: Buffer | null = null;
let source: ThumbnailSource | null = null;
let faces: FaceSource | null = null;
let videos: VideoLookup | null = null;

/**
 * Starts serving (or keeps serving) and mints a fresh token, so a URL from before the
 * last lock is dead. Returns the base the window appends a uid to.
 */
export async function startThumbServer(
  from: ThumbnailSource,
  faceFrom?: FaceSource,
  videoFrom?: VideoLookup,
): Promise<string> {
  source = from;
  faces = faceFrom ?? null;
  videos = videoFrom ?? null;
  token = randomBytes(32);
  if (!server) {
    const created = createServer((req, res) => void handle(req, res));
    await new Promise<void>((resolve, reject) => {
      created.once("error", reject);
      created.listen(0, "127.0.0.1", () => resolve());
    });
    const address = created.address();
    port = typeof address === "object" && address ? address.port : 0;
    server = created;
  }
  return `http://127.0.0.1:${port}/t/${token.toString("base64url")}/`;
}

/** Stops answering: the token is forgotten at once, and the port is let go. */
export async function stopThumbServer(): Promise<void> {
  token = null;
  source = null;
  faces = null;
  videos = null;
  const running = server;
  server = null;
  port = 0;
  if (running) {
    running.closeAllConnections?.();
    await new Promise<void>((resolve) => running.close(() => resolve()));
  }
}

async function handle(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) {
  const cors = corsFor(req.headers.origin);
  const refuse = (code: number) => {
    res.writeHead(code, { "Cache-Control": "no-store", ...cors });
    res.end();
  };
  const head = req.method === "HEAD";
  if (req.method !== "GET" && !head) return refuse(405);
  if (req.headers.host !== `127.0.0.1:${port}`) return refuse(403);

  // `/t/<token>/<uid>`, `/t/<token>/<uid>/f/<l,t,r,b>` for a cover cut to a face, or
  // `/t/<token>/<uid>/v` for a video to play. On a picture, `?w=<px>` asks for it cut down to
  // a tile that size (see thumbSizes); anything else in the query only makes the webview
  // load it anew.
  const [path, query = ""] = (req.url ?? "").split("?", 2);
  const parts = path.split("/");
  const width = thumbWidthFor(Number(new URLSearchParams(query).get("w") ?? NaN)) ?? undefined;
  const face = parts.length === 6 && parts[4] === "f";
  const video = parts.length === 5 && parts[4] === "v";
  if ((parts.length !== 4 && !face && !video) || parts[0] !== "" || parts[1] !== "t") return refuse(404);
  // A player may ask what a video is before it asks for it; a thumbnail is only fetched.
  if (head && !video) return refuse(405);
  const given = Buffer.from(parts[2], "base64url");
  const current = token;
  if (!current || given.length !== current.length || !timingSafeEqual(given, current)) {
    return refuse(403);
  }
  let uid: string;
  try {
    uid = decodeURIComponent(parts[3]);
  } catch {
    return refuse(400);
  }
  if (!UID_SHAPE.test(uid) || !source) return refuse(404);
  const box = face ? parseFaceBox(parts[5]) : null;
  if (face && (!box || !faces)) return refuse(404);

  const gone = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) gone.abort();
  });
  if (video) return serveVideo(uid, req, res, head, gone.signal, refuse);
  try {
    const bytes = box && faces ? await faces(uid, box, gone.signal, width) : await source(uid, gone.signal, width);
    if (gone.signal.aborted) return;
    if (!bytes) return refuse(404);
    res.writeHead(200, {
      "Content-Type": "image/jpeg",
      "Content-Length": String(bytes.length),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...cors,
    });
    res.end(bytes);
  } catch {
    refuse(500);
  }
}

/**
 * One range of a video, or all of it, as a player asks: `206 Partial Content` for a
 * `Range`, written as it is decrypted and no faster than the player takes it, and stopped
 * as soon as the player hangs up (it does, every time it seeks).
 */
async function serveVideo(
  uid: string,
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  head: boolean,
  gone: AbortSignal,
  refuse: (code: number) => void,
): Promise<void> {
  const lookup = videos;
  if (!lookup) return refuse(404);
  let video: VideoSource | null;
  try {
    video = await lookup(uid);
  } catch {
    return refuse(500);
  }
  if (gone.aborted) return;
  if (!video || video.size <= 0) return refuse(404);
  const range = parseRange(req.headers.range, video.size);
  if (range === "unsatisfiable") {
    const asked = /^bytes=(\d+)/.exec(String(req.headers.range ?? ""));
    diag.log("drive", "video_range_refused", { size: video.size, from: asked ? Number(asked[1]) : -1 });
    res.writeHead(416, { "Content-Range": `bytes */${video.size}`, "Cache-Control": "no-store" });
    res.end();
    return;
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? video.size - 1;
  res.writeHead(range ? 206 : 200, {
    "Content-Type": video.mime,
    "Content-Length": String(end - start + 1),
    "Accept-Ranges": "bytes",
    ...(range ? { "Content-Range": `bytes ${start}-${end}/${video.size}` } : {}),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  if (head) {
    res.end();
    return;
  }
  const length = end - start + 1;
  let sent = 0;
  try {
    for await (const piece of video.read(start, end, gone)) {
      if (gone.aborted) break;
      sent += piece.length;
      if (!res.write(piece)) {
        await new Promise<void>((resolve) => {
          const done = () => {
            res.off("drain", done);
            res.off("close", done);
            resolve();
          };
          res.on("drain", done);
          res.on("close", done);
        });
      }
    }
    if (gone.aborted) return;
    // Fewer bytes than were promised: ending the answer normally would leave the player
    // waiting for the rest for ever. Cutting the connection makes it give up, and the
    // viewer falls back.
    if (sent < length) {
      diag.log("drive", "video_cut", { start, sent, length });
      res.destroy();
    } else res.end();
  } catch {
    // The headers are out: all that can be said now is that the answer stops short.
    diag.log("drive", "video_cut", { start, sent, length, failed: 1 });
    res.destroy();
  }
}
