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

import { invoke } from "@tauri-apps/api/core";

type RpcEnvelope = { ok: boolean; result?: unknown; error?: string };

// Transport-level errors from the Rust host (not sidecar business errors).
// When they happen (e.g. the sidecar was restarted after a code change), retry once.
const CONNECTION_ERROR = /sidecar closed|write to sidecar|flush to sidecar|sidecar task/i;

const MINUTE = 60_000;

/**
 * How long a call may go unanswered before this side gives up on it.
 *
 * These are ceilings on a call that will never settle, not latency budgets. The host
 * admits exactly one request to the sidecar at a time, so a call's wall clock is its
 * own work plus however long it waited for the channel, and a whole-library sweep sits
 * at the bottom of that queue: a value tight enough to be a useful deadline would fire
 * on healthy calls all day. Every caller already handles a rejection, so giving up
 * costs one abandoned answer, and buys that no loader holds its in-flight state for
 * the rest of the session.
 *
 * This is only this side's own guard. The host abandons a wedged sidecar itself, and
 * neither is written as if it were the only one.
 */
const DEFAULT_TIMEOUT_MS = MINUTE;

/** The calls a single flat number would break, and what each of them is waiting on. */
const TIMEOUT_MS: Record<string, number> = {
  // Whole-library and whole-collection walks. The timeline is the longest call in the
  // app: on a cold run it decrypts a node per photo before the grid can paint at all.
  getTimeline: 15 * MINUTE,
  getMetadata: 5 * MINUTE,
  getDurations: 5 * MINUTE,
  getMediaTypes: 5 * MINUTE,
  getAlbums: 5 * MINUTE,
  getAlbumPhotos: 5 * MINUTE,
  getAlbumPhotoUids: 5 * MINUTE,
  listTrashed: 5 * MINUTE,
  getShared: 5 * MINUTE,
  // A batch of decrypts admitted below everything else, so the wait for the channel
  // can dwarf the work itself.
  getThumbnails: 3 * MINUTE,
  warmThumbnails: 3 * MINUTE,

  // Whole files: a video crosses as one payload, and an update is an installer.
  getVideo: 15 * MINUTE,
  downloadUpdate: 15 * MINUTE,

  // Mutations the SDK batches ten links at a time, over a selection with no ceiling on
  // it, plus the empty that walks the whole trash.
  trashPhotos: 15 * MINUTE,
  restorePhotos: 15 * MINUTE,
  deletePhotosForever: 15 * MINUTE,
  emptyTrash: 15 * MINUTE,
  setFavorite: 15 * MINUTE,
  addPhotosToAlbum: 15 * MINUTE,
  removePhotosFromAlbum: 15 * MINUTE,
  deleteAlbum: 15 * MINUTE,

  // Signing in: an SRP handshake, then the account keys. Giving up early here costs
  // the user their password a second time, so it is the most generous of the lot.
  login: 5 * MINUTE,
  unlock: 5 * MINUTE,
  submitCaptcha: 5 * MINUTE,
  submit2fa: 5 * MINUTE,
};

/** Rejects if `work` has not settled within `ms`, and never leaves a timer behind. */
function withTimeout<T>(work: Promise<T>, ms: number, method: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${method} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer));
}

/**
 * Names the calls this side can give up on, so the host can be told which one.
 *
 * Ordinary within one run of the app; nothing persists it and nothing outside the host's
 * own pending table ever sees it.
 */
let nextCallId = 1;

export type RpcOptions = {
  /**
   * Lets a caller stop wanting the answer, and get the cost back for it.
   *
   * The host admits one call at a time, so a request nobody is waiting for any more is
   * not free just because its result is ignored: it still holds its place in the queue
   * and still spends the channel when it gets there, in front of whatever the user is
   * actually looking at. Aborting is what makes it stop costing anything: the call is
   * never sent at all when the signal is already down, and is dropped from the host's
   * queue when it is already on its way.
   *
   * An aborted call rejects. Every caller that passes a signal already treats a missing
   * answer the same as a failed one, which is what makes that safe.
   */
  signal?: AbortSignal;
  /** Overrides the method's own ceiling, for a caller that knows better about one call. */
  timeoutMs?: number;
};

/**
 * Call a sidecar method through the Rust host and unwrap the {ok,result,error} envelope.
 */
export async function rpc<T = unknown>(
  method: string,
  params: Record<string, unknown> = {},
  options: RpcOptions = {},
): Promise<T> {
  const { signal } = options;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS[method] ?? DEFAULT_TIMEOUT_MS;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    // The cheapest outcome there is: a call let go of before it was sent costs the host
    // nothing, not even a place in the queue.
    if (signal?.aborted) throw new Error(`${method} abandoned`);

    // Only a call that can be abandoned gets an id, so nothing else is followed by the
    // host and nothing else can be cancelled by anyone.
    const callId = signal ? nextCallId++ : undefined;
    const letGo = () => void invoke("cancel_rpc", { callId }).catch(() => {});
    signal?.addEventListener("abort", letGo, { once: true });
    try {
      // Each attempt gets the full budget: the retry below only follows a connection
      // error, which fails at once rather than eating into the next one's time.
      const resp = (await withTimeout(
        // Explicitly null rather than absent for an uncancellable call, so the host
        // reads "no id" the same way however the arguments cross.
        invoke("rpc", { method, params, callId: callId ?? null }),
        timeoutMs,
        method,
      )) as RpcEnvelope;
      if (!resp || typeof resp !== "object") throw new Error("Empty sidecar response");
      if (!resp.ok) throw new Error(resp.error || "Sidecar error");
      return resp.result as T;
    } catch (e) {
      lastErr = e;
      if (attempt === 0 && CONNECTION_ERROR.test(String(e))) continue;
      throw e;
    } finally {
      signal?.removeEventListener("abort", letGo);
    }
  }
  throw lastErr;
}
