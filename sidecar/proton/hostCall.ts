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

// Work asked of the host, the one way back on the pipe the host otherwise only asks through:
// what only Windows can do here, such as transcoding a video with its own encoders. A call is a
// line on stdout with no `id`, which the host's reader tells apart from the answers it waits for;
// the host does the work on a thread of its own and writes the answer, and any progress before
// it, back as lines the request loop hands to `takeHostLine`.

export type HostWriter = (line: string) => void;

type Pending = { resolve: (value: any) => void; reject: (e: Error) => void; onProgress?: (value: number) => void };

let write: HostWriter | null = null;
let next = 1;
const pending = new Map<number, Pending>();

/** Tells the host something that needs no answer, such as the session having ended. */
export function hostNotice(name: string): void {
  write?.(`${JSON.stringify({ notice: name })}\n`);
}

/** Where calls go: the request loop's stdout, set once it runs. */
export function setHostWriter(writer: HostWriter | null): void {
  write = writer;
  if (!writer) {
    for (const p of pending.values()) p.reject(new Error("the app is not there to ask"));
    pending.clear();
  }
}

/**
 * Asks the host for `method`. Resolves with its answer, rejects with its error, and hears its
 * progress (0 to 1) as it goes. `signal` gives up on the answer; the host's work is told to stop.
 */
export function hostCall<T = unknown>(
  method: string,
  params: Record<string, unknown>,
  onProgress?: (value: number) => void,
  signal?: AbortSignal,
): Promise<T> {
  const out = write;
  if (!out) return Promise.reject(new Error("the app is not there to ask"));
  if (signal?.aborted) return Promise.reject(new Error("cancelled"));
  const callId = next++;
  return new Promise<T>((resolve, reject) => {
    const stop = () => {
      if (!pending.delete(callId)) return;
      out(`${JSON.stringify({ call: "cancel", callId })}\n`);
      reject(new Error("cancelled"));
    };
    pending.set(callId, {
      resolve: (v) => {
        signal?.removeEventListener("abort", stop);
        resolve(v);
      },
      reject: (e) => {
        signal?.removeEventListener("abort", stop);
        reject(e);
      },
      onProgress,
    });
    signal?.addEventListener("abort", stop, { once: true });
    out(`${JSON.stringify({ call: method, callId, params })}\n`);
  });
}

/**
 * A line from the host that answers a call rather than asking anything: its progress, or its end.
 * Answers whether the line was one; the request loop treats every other line as a request.
 */
export function takeHostLine(line: any): boolean {
  if (typeof line?.hostProgress === "number") {
    const p = pending.get(line.hostProgress);
    if (p && typeof line.value === "number") p.onProgress?.(line.value);
    return true;
  }
  if (typeof line?.hostReply === "number") {
    const p = pending.get(line.hostReply);
    if (p) {
      pending.delete(line.hostReply);
      if (line.ok === true) p.resolve(line.result);
      else p.reject(new Error(typeof line.error === "string" ? line.error : "the app could not do it"));
    }
    return true;
  }
  return false;
}
