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

// Readers for the SDK's node shape, shared by the session and the download
// engine. They live here so neither has to import the other.
/* eslint-disable @typescript-eslint/no-explicit-any */

export const toMillis = (value: unknown): number => (value ? new Date(value as string).getTime() : 0);

import { SDK_STALL_MS, withStallGuard } from "./stallGuard.ts";

/** How the SDK reports one node's fate in a multi-node operation. */
export type NodeOpResult = { uid: string; ok: boolean; error?: string };

/**
 * Drains one of the SDK's per-node result generators into a plain array, so one
 * node's failure never sinks the batch.
 */
export async function collectResults(results: AsyncGenerator<any>): Promise<NodeOpResult[]> {
  const out: NodeOpResult[] = [];
  // Guarded here rather than at each caller: this is the one drain every per-node
  // batch operation goes through, so one bound covers all of them.
  for await (const r of withStallGuard(results, SDK_STALL_MS, "nodeResults")) {
    const result = r as any;
    out.push(
      result.ok
        ? { uid: result.uid, ok: true }
        : { uid: result.uid, ok: false, error: String(result.error?.message ?? result.error) },
    );
  }
  return out;
}

/**
 * `NodeEntity.name` is a `Result<string, Error | InvalidNameError>`. An invalid
 * name still carries a placeholder the client is meant to display.
 */
export function nodeName(node: any): string {
  const result = node?.name;
  if (!result) return "";
  if (result.ok) return String(result.value);
  const placeholder = result.error?.name;
  return typeof placeholder === "string" ? placeholder : "";
}

/**
 * A video's length in MILLISECONDS, read from the active revision's decrypted
 * extended attributes.
 *
 * Drive stores `Media.Duration` in SECONDS, and possibly fractional ones (a 7.5
 * means seven and a half seconds), so the value is scaled by 1000. Taking it for
 * milliseconds is the mistake this exists to prevent: it renders every video a
 * thousandth of its length, and making it the other way round renders a seven
 * second clip as two hours.
 *
 * The SDK hands back the whole attribute blob minus its `Common` block, so `Media`
 * sits at the top level. Casing varies between the clients that write it, and some
 * write the media fields flat, so both spellings and both shapes are read.
 *
 * Null for an image, for a video uploaded before the block existed, and for any
 * value that is not a positive number.
 */
/**
 * Where a photo was taken, as its uploader recorded it beside the file: Drive's `Location`
 * attribute, latitude then longitude. Null when there is none, or it is not a place on Earth
 * (a 0,0 that a camera without a fix wrote is no place either).
 */
export function nodeLocation(node: any): [number, number] | null {
  const revision = node?.activeRevision?.ok ? node.activeRevision.value : null;
  const extra = revision?.claimedAdditionalMetadata as Record<string, any> | undefined | null;
  const location = extra?.Location ?? extra?.location;
  if (!location) return null;
  const lat = Number(location.Latitude ?? location.latitude);
  const lon = Number(location.Longitude ?? location.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return null;
  return [lat, lon];
}

export function nodeDurationMs(node: any): number | null {
  const revision = node?.activeRevision?.ok ? node.activeRevision.value : null;
  const extra = revision?.claimedAdditionalMetadata as Record<string, any> | undefined | null;
  if (!extra) return null;
  const media = (extra.Media ?? extra.media ?? extra) as Record<string, any>;
  const raw = media?.Duration ?? media?.duration;
  const seconds = typeof raw === "string" ? Number(raw) : raw;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.round(seconds * 1000);
}
