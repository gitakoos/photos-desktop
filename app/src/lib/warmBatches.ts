/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * This file is part of Photos for Proton, free software under the GNU General Public
 * License version 3. See <https://www.gnu.org/licenses/>.
 */

/**
 * The library's uids in timeline order, `size` at a time, leaving out those already in
 * `warmed`. Read lazily, so a uid warmed while the pass is under way (by an earlier pass
 * whose answer lands late) is not asked for again.
 */
export function* unwarmedBatches(uids: readonly string[], warmed: ReadonlySet<string>, size: number): Generator<string[]> {
  let batch: string[] = [];
  for (const uid of uids) {
    if (warmed.has(uid)) continue;
    batch.push(uid);
    if (batch.length === size) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length > 0) yield batch;
}

/**
 * Warms one batch, asking `warm` again while it reports fewer than the whole batch ready
 * (the sidecar fetches only a couple of missing thumbnails per call), and stopping once a
 * call gets no further. True only when the whole batch is ready, which is when the caller
 * may remember it as warm.
 */
export async function warmWholeBatch(
  batch: readonly string[],
  warm: (uids: readonly string[]) => Promise<{ ready: number }>,
  maxAsks = 4,
): Promise<boolean> {
  let ready = -1;
  for (let ask = 0; ask < maxAsks; ask++) {
    const got = await warm(batch);
    if (got.ready >= batch.length) return true;
    if (got.ready <= ready) return false;
    ready = got.ready;
  }
  return false;
}
