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
 * Asks for face previews a few at a time. Each one is a few hundred milliseconds in the
 * sidecar, and a page of people asking for all of theirs together queued every other call
 * behind them. `ask` returns a function that takes the request back out if it has not been
 * started; one already started is let run and its answer is dropped.
 */
export function createFaceQueue(
  load: (uid: string) => Promise<string | null>,
  limit: number,
): (uid: string, done: (url: string | null) => void) => () => void {
  type Entry = { uid: string; done: (url: string | null) => void; cancelled: boolean };
  const waiting: Entry[] = [];
  let running = 0;

  const pump = (): void => {
    while (running < limit && waiting.length > 0) {
      const next = waiting.shift()!;
      running++;
      void load(next.uid)
        .catch(() => null)
        .then((url) => {
          running--;
          if (!next.cancelled) next.done(url);
          pump();
        });
    }
  };

  return (uid, done) => {
    const entry: Entry = { uid, done, cancelled: false };
    waiting.push(entry);
    pump();
    return () => {
      entry.cancelled = true;
      const at = waiting.indexOf(entry);
      if (at >= 0) waiting.splice(at, 1);
    };
  };
}
