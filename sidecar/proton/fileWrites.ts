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

import type { WriteStream } from "node:fs";

/**
 * A file write stream whose failure cannot take the process down.
 *
 * Node turns an 'error' event nobody listens to into an uncaught exception, so one failed
 * write (a full disk, a folder deleted under it, a file an antivirus holds) would end
 * the sidecar and the signed-in session with it. With this the error stays on the stream
 * (`errored`) and reaches the writer at its next `writeChunk`, and `end(cb)` hands it on.
 */
export function guarded<T extends WriteStream>(file: T): T {
  file.on("error", () => {
    /* kept on the stream as `errored`; `writeChunk` and `end(cb)` report it */
  });
  return file;
}

/**
 * Writes one chunk and, when the stream asks for a pause, waits for room. Rejects when
 * the stream has failed, rather than waiting for a 'drain' that a failed stream never
 * sends: that wait was a hang with no way out.
 */
export function writeChunk(file: WriteStream, chunk: Uint8Array): Promise<void> | void {
  if (file.errored) return Promise.reject(file.errored);
  if (!file.write(chunk)) return drained(file);
}

function drained(file: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    if (file.errored) {
      reject(file.errored);
      return;
    }
    const settle = (err?: Error | null) => {
      file.off("drain", onDrain);
      file.off("error", onError);
      file.off("close", onClose);
      if (err) reject(err);
      else resolve();
    };
    const onDrain = () => settle();
    const onError = (e: Error) => settle(e);
    const onClose = () => settle(file.errored ?? new Error("the file closed before it was written"));
    file.once("drain", onDrain);
    file.once("error", onError);
    file.once("close", onClose);
  });
}
