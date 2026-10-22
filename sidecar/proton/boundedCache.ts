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

// The cache the Drive SDK keeps its nodes and decrypted keys in.
//
// The SDK's own MemoryCache scans every tag's list on each write, and every photo
// carries the same two tags (its volume and its parent, the photos root), so a write
// costs as much as the library is large and filling it is quadratic: about 77 s of
// blocked event loop at 100 000 photos. It also never lets anything go. This one keeps
// the same contract with a tag index of sets, so every operation is constant time,
// and empties itself once it holds `limit` entries. Emptying is the one way to let
// go that cannot mislead the SDK: it also records "this folder's children are all
// loaded" here, so dropping single entries could leave a listing that looks complete
// with photos missing, while an empty cache is simply a cold start.

import type { ProtonDriveCache } from "@protontech/drive-sdk";

type EntityResult<T> = { key: string; ok: true; value: T } | { key: string; ok: false; error: string };

export class BoundedCache<T> implements ProtonDriveCache<T> {
  private readonly entities = new Map<string, T>();
  private readonly tagsOf = new Map<string, string[]>();
  private readonly keysByTag = new Map<string, Set<string>>();

  constructor(private readonly limit: number) {}

  get size(): number {
    return this.entities.size;
  }

  async clear(): Promise<void> {
    this.entities.clear();
    this.tagsOf.clear();
    this.keysByTag.clear();
  }

  async setEntity(key: string, value: T, tags?: string[]): Promise<void> {
    if (!this.entities.has(key) && this.entities.size >= this.limit) await this.clear();
    this.untag(key);
    this.entities.set(key, value);
    if (tags && tags.length > 0) {
      this.tagsOf.set(key, [...tags]);
      for (const tag of tags) {
        let keys = this.keysByTag.get(tag);
        if (!keys) this.keysByTag.set(tag, (keys = new Set()));
        keys.add(key);
      }
    }
  }

  async getEntity(key: string): Promise<T> {
    const value = this.entities.get(key);
    if (!value) throw Error("Entity not found");
    return value;
  }

  async *iterateEntities(keys: string[]): AsyncGenerator<EntityResult<T>> {
    for (const key of keys) {
      try {
        yield { key, ok: true, value: await this.getEntity(key) };
      } catch (error) {
        yield { key, ok: false, error: `${error}` };
      }
    }
  }

  async *iterateEntitiesByTag(tag: string): AsyncGenerator<EntityResult<T>> {
    const keys = this.keysByTag.get(tag);
    if (!keys) return;
    // A copy, so a change made while the caller iterates does not shift the results.
    yield* this.iterateEntities([...keys]);
  }

  async removeEntities(keys: string[]): Promise<void> {
    for (const key of keys) {
      this.entities.delete(key);
      this.untag(key);
    }
  }

  private untag(key: string): void {
    const tags = this.tagsOf.get(key);
    if (!tags) return;
    for (const tag of tags) {
      const keys = this.keysByTag.get(tag);
      if (!keys) continue;
      keys.delete(key);
      if (keys.size === 0) this.keysByTag.delete(tag);
    }
    this.tagsOf.delete(key);
  }
}
