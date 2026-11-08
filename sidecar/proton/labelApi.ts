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

// What the window asks of the labels kept on this computer. Photos are named by their Drive
// link id, as the phone names them.

import {
  addLabels,
  createLabel,
  deleteLabel,
  labelList,
  labelStore,
  removeLabels,
  renameLabel,
  setLabels,
} from "./labelStore.ts";
import { isReady } from "./store.ts";

const text = (v: unknown) => String(v ?? "").slice(0, 200);
const list = (v: unknown, max: number) =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, max) : [];

function ready(): void {
  if (!isReady()) throw new Error("Locked");
}

/** The handlers; `changed` hears every edit, for the shared backup to save. */
export function labelHandlers(changed: () => void): Record<string, (p: any) => unknown> {
  const edit = <T>(run: (at: number) => T, didChange: (result: T) => boolean): T => {
    ready();
    const at = Date.now();
    const result = labelStore.change(() => run(at), didChange);
    if (didChange(result)) changed();
    return result;
  };
  const state = () => labelStore.get();
  return {
    /** Goes up with every change, also one taken in from another device, for the window to look again. */
    labelsVersion: () => (isReady() ? labelStore.version : 0),
    labelsList: () => {
      ready();
      return { version: labelStore.version, labels: labelList(state()) };
    },
    labelsOf: (p) => {
      ready();
      const photos = state().photos;
      return Object.fromEntries(list(p?.keys, 10_000).map((k) => [k, photos[k]?.l ?? []]));
    },
    labelsAdd: (p) => edit((at) => addLabels(state(), list(p?.keys, 10_000), list(p?.labels, 5), at), (r) => r.changed > 0),
    labelsRemove: (p) =>
      edit((at) => ({ changed: removeLabels(state(), list(p?.keys, 10_000), list(p?.labels, 5), at) }), (r) => r.changed > 0),
    labelsSet: (p) => edit((at) => ({ changed: setLabels(state(), text(p?.key), list(p?.labels, 5), at) }), (r) => r.changed),
    labelCreate: (p) => edit((at) => ({ name: createLabel(state(), text(p?.name), at) }), (r) => r.name !== null),
    labelRename: (p) =>
      edit((at) => ({ name: renameLabel(state(), text(p?.from), text(p?.to), at) }), (r) => r.name !== null),
    labelDelete: (p) => edit((at) => ({ deleted: deleteLabel(state(), text(p?.name), at) }), (r) => r.deleted),
  };
}
