/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * This file is part of Photos for Proton, free software under the GNU General Public
 * License version 3. See <https://www.gnu.org/licenses/>.
 */

/**
 * The canvas grid's thumbnail fetcher: it fetches a thumbnail's bytes from the loopback
 * server and hands them to the page, which decodes them.
 *
 * Why a worker for a fetch: a fetch the page calls off (its tile scrolled far away) is
 * aborted here, which closes the connection, which tells the server to stop fetching it.
 * WebKit never does that for an <img> whose tile went, so every tile scrolled past used to
 * hold one of the six connections.
 *
 * Why only the fetch: image work in a worker crashed WebKitGTK 2.52's web process on the
 * reporter's machine, a release assertion (SIGILL) on this thread with the same frames each
 * time, after some thousands of thumbnails: first with an OffscreenCanvas, then with only
 * createImageBitmap decoding and cutting (5,500 thumbnails in, then 13,800). The page
 * decodes instead, with `img.decode()`, which WebKit runs off its main thread.
 *
 * No imports: it is bundled on its own.
 */

type In = { kind: "load"; key: string; url: string } | { kind: "cancel"; key: string };

/** The worker's own scope, typed by hand: the app's TypeScript is set up for the page. */
const scope = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<In>) => void) | null;
};
const running = new Map<string, AbortController>();

scope.onmessage = async (e: MessageEvent<In>) => {
  const m = e.data;
  if (m.kind === "cancel") {
    running.get(m.key)?.abort();
    running.delete(m.key);
    return;
  }
  const stop = new AbortController();
  running.get(m.key)?.abort();
  running.set(m.key, stop);
  try {
    let res: Response;
    try {
      res = await fetch(m.url, { signal: stop.signal });
    } catch {
      // No answer at all: the server refused this worker (no CORS for its origin) or is
      // gone. The page decides whether to carry on without the worker.
      if (!stop.signal.aborted) scope.postMessage({ kind: "failed", key: m.key, unreachable: true });
      return;
    }
    if (!res.ok) throw new Error(String(res.status));
    const bytes = await res.arrayBuffer();
    if (stop.signal.aborted) return;
    scope.postMessage({ kind: "done", key: m.key, bytes, type: res.headers.get("Content-Type") ?? "image/jpeg" }, [bytes]);
  } catch {
    if (!stop.signal.aborted) scope.postMessage({ kind: "failed", key: m.key });
  } finally {
    if (running.get(m.key) === stop) running.delete(m.key);
  }
};
