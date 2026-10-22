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

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { TFunc } from "./i18n";

/** What the File Explorer folder is busy with, as the host reports it. */
export type MountActivity = {
  what: "fill" | "open" | "offline";
  name: string | null;
  by: string | null;
  done: number;
  total: number;
};

/** What a "syncing" is doing and why, in words a reader can act on. */
export type SyncInfo = { title: string; why: string; done: number; total: number };

/** The folder's current work: seeded on open, since it may already be busy, then followed. */
export function useMountActivity(): MountActivity | null {
  const [now, setNow] = useState<MountActivity | null>(null);
  useEffect(() => {
    let cancelled = false;
    void invoke<MountActivity | null>("mount_activity")
      .then((a) => {
        if (!cancelled) setNow(a);
      })
      .catch(() => {});
    const un = listen<MountActivity | null>("mount-activity", (e) => setNow(e.payload ?? null));
    return () => {
      cancelled = true;
      void un.then((f) => f());
    };
  }, []);
  return now;
}

export function describeMount(a: MountActivity, t: TFunc): SyncInfo {
  const count = { done: a.done, total: a.total };
  switch (a.what) {
    case "fill":
      return {
        title: a.total > 0 ? t("sync.fillCount", count) : t("sync.fill"),
        why: t("sync.fillWhy"),
        ...count,
      };
    case "open":
      return {
        title: a.name ? t("sync.open", { name: a.name }) : t("sync.openAny"),
        why: a.by && a.by !== "unknown" ? t("sync.openWhy", { by: a.by }) : t("sync.openWhyAnon"),
        ...count,
      };
    case "offline":
      return { title: t("sync.offline"), why: t("sync.offlineWhy"), ...count };
  }
}
