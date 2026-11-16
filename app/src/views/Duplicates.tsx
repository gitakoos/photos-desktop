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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Confirm } from "../components/Confirm";
import { PlayArrowIcon } from "../components/icons";
import { useThumbnails } from "../hooks/useThumbnails";
import { SelectionBar } from "../hooks/useSelection";
import { formatBytes, locale } from "../lib/format";
import { useT } from "../lib/i18n";
import { rpc } from "../lib/rpc";
import { canMark, picksFrom, toggleMark, type Marks } from "../lib/duplicateMarks";
import "../styles/Duplicates.css";

type Kind = "identical" | "same" | "burst" | "similar";
/** `keep`: the copy to keep when one is preferred, the largest file of one photo in several. */
type Group = { key: string; kind: Kind; uids: string[]; times: number[]; keep?: number };
/** `ready` is false until the finder has worked the groups out once. */
type Groups = { identical: Group[]; same: Group[]; burst: Group[]; similar: Group[]; ignored: Group[]; ready: boolean };
type Status = { state: "idle" | "scanning" | "done" | "failed"; done: number; total: number; version: number };
type Meta = { name: string; size: number | null; mediaType: string | null };
type Tab = "identical" | "same" | "burst" | "similar" | "ignored";
const TABS: Tab[] = ["identical", "same", "burst", "similar", "ignored"];
/**
 * About how many photos one call sends to the trash, so a large clean-up never runs into a
 * call's time limit (the SDK trashes ten per request).
 */
const TRASH_CHUNK = 200;
/** The copy a group keeps when its extras are marked: the preferred one, else the oldest. */
const keeperOf = (g: Group): number => g.keep ?? 0;
const allBut = (g: Group): Set<string> => new Set(g.uids.filter((_, i) => i !== keeperOf(g)));

/** Groups drawn at first, and added with each "show more". */
const PAGE = 40;
const META_BATCH = 120;

/** How far a move to the trash has got. Kept outside the page, which may be left while it runs. */
type Moving = { done: number; total: number } | null;
let keptMoving: Moving = null;
const movingListeners = new Set<(m: Moving) => void>();
function publishMoving(m: Moving) {
  keptMoving = m;
  movingListeners.forEach((l) => l(m));
}

// The choices outlive the page, so a look at a group in the viewer and back keeps them.
let keptMarks: Marks = new Map();
let keptTab: Tab = "identical";

/**
 * The duplicate finder, as the phone has it: identical copies and similar photos in groups,
 * each copy marked to go with a click. One copy of every group always stays, unless the user
 * deletes the whole group on purpose. What goes is moved to the trash, where it can be restored.
 */
export function Duplicates({
  onView,
  onTrashed,
}: {
  /** Shows a group's photos in the viewer, starting at one of them. */
  onView: (uids: string[], at: string) => void;
  /** The photos moved to the trash, so the timeline drops them too. */
  onTrashed: (uids: string[]) => void;
}) {
  const t = useT();
  const [status, setStatus] = useState<Status | null>(null);
  const [groups, setGroups] = useState<Groups | null>(null);
  const [tab, setTabState] = useState<Tab>(keptTab);
  const [marks, setMarksState] = useState<Marks>(keptMarks);
  const [shownCount, setShownCount] = useState(PAGE);
  const [meta, setMeta] = useState<Record<string, Meta>>({});
  const [confirm, setConfirm] = useState<{ whole: Group | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [moving, setMoving] = useState<Moving>(keptMoving);
  useEffect(() => {
    movingListeners.add(setMoving);
    setMoving(keptMoving);
    return () => {
      movingListeners.delete(setMoving);
    };
  }, []);
  // A move started before the page was left and opened again still holds the buttons.
  const working = busy || moving !== null;
  const [toast, setToast] = useState("");

  const setTab = (next: Tab) => {
    keptTab = next;
    setTabState(next);
    setShownCount(PAGE);
  };
  const setMarks = (next: Marks) => {
    keptMarks = next;
    setMarksState(next);
  };

  // The scan starts with the page and runs on by itself; the page follows it while open.
  const groupsAt = useRef(-1);
  const lastFetch = useRef(0);
  const loadGroups = useCallback(async (version: number) => {
    groupsAt.current = version;
    lastFetch.current = Date.now();
    const next = await rpc<Groups>("duplicatesGroups").catch(() => null);
    if (next) setGroups(next);
  }, []);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const follow = async (method: "duplicatesStart" | "duplicatesStatus") => {
      const s = await rpc<Status>(method).catch(() => null);
      if (!live) return;
      if (s) {
        setStatus(s);
        // While the scan runs the groups are read again every few seconds, not on every step.
        const due = s.state !== "scanning" || Date.now() - lastFetch.current > 3000;
        if (s.version !== groupsAt.current && due) await loadGroups(s.version);
      }
      if (live) timer = setTimeout(() => void follow("duplicatesStatus"), s?.state === "scanning" ? 1000 : 4000);
    };
    void follow("duplicatesStart");
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [loadGroups]);

  // Marks of photos no longer in any group fall away.
  useEffect(() => {
    if (!groups?.ready) return;
    const present = new Map(
      [...groups.identical, ...groups.same, ...groups.burst, ...groups.similar].map((g) => [g.key, new Set(g.uids)]),
    );
    let changed = false;
    const next: Marks = new Map();
    for (const [key, set] of marks) {
      const uids = present.get(key);
      const kept = new Set([...set].filter((u) => uids?.has(u)));
      if (kept.size !== set.size) changed = true;
      if (kept.size && uids && kept.size < uids.size) next.set(key, kept);
      else if (kept.size) changed = true;
    }
    if (changed) setMarks(next);
    // Only a new set of groups prunes; `marks` is read as it stands then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups]);

  const list = groups ? groups[tab] : [];
  const visible = list.slice(0, shownCount);
  const visibleUids = useMemo(() => visible.flatMap((g) => g.uids), [visible]);
  const thumbs = useThumbnails(visibleUids);

  // Names and sizes for the copies on screen, read a batch at a time.
  useEffect(() => {
    const missing = visibleUids.filter((u) => !meta[u]);
    if (missing.length === 0) return;
    let live = true;
    void (async () => {
      for (let at = 0; at < missing.length && live; at += META_BATCH) {
        const rows = await rpc<{ uid: string; name: string; size: number | null; mediaType: string | null }[]>(
          "getMetadata",
          { uids: missing.slice(at, at + META_BATCH) },
        ).catch(() => []);
        if (!live) return;
        setMeta((prev) => {
          const next = { ...prev };
          for (const r of rows) next[r.uid] = { name: r.name, size: r.size, mediaType: r.mediaType };
          return next;
        });
      }
    })();
    return () => {
      live = false;
    };
    // `visibleUids` is recomputed with the groups; `meta` is read as it stands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleUids]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(""), 4000);
    return () => clearTimeout(id);
  }, [toast]);

  const allGroups = useMemo(
    () => (groups ? [...groups.identical, ...groups.same, ...groups.burst, ...groups.similar] : []),
    [groups],
  );
  // Marked across every group, most were never on screen and their sizes are not known.
  const { markedCount, markedBytes, sizesKnown } = useMemo(() => {
    let count = 0;
    let bytes = 0;
    let known = true;
    for (const set of marks.values()) {
      for (const u of set) {
        count++;
        const size = meta[u]?.size;
        if (size == null) known = false;
        else bytes += size;
      }
    }
    return { markedCount: count, markedBytes: bytes, sizesKnown: known };
  }, [marks, meta]);

  function onTile(group: Group, uid: string) {
    if (tab === "ignored") return;
    if (!canMark(marks, group, uid)) {
      setToast(t("duplicates.lastCopy"));
      return;
    }
    setMarks(toggleMark(marks, group, uid));
  }

  function allButKeeper(group: Group) {
    const next: Marks = new Map(marks);
    next.set(group.key, allBut(group));
    setMarks(next);
  }

  /** Marks the extras of every group in the tab, each keeping its largest file, else its oldest. */
  function markEvery() {
    const next: Marks = new Map(marks);
    for (const group of list) next.set(group.key, allBut(group));
    setMarks(next);
  }

  async function ignore(group: Group, on: boolean) {
    const next: Marks = new Map(marks);
    next.delete(group.key);
    setMarks(next);
    await rpc("duplicatesIgnore", { uids: group.uids, on }).catch((e) => setToast(String(e)));
    const s = await rpc<Status>("duplicatesStatus").catch(() => null);
    if (s) {
      setStatus(s);
      await loadGroups(s.version);
    }
  }

  async function trash(whole: Group | null) {
    setConfirm(null);
    setBusy(true);
    try {
      // Whole groups per call, about TRASH_CHUNK photos each, every call's photos leaving the
      // timeline as it is done.
      const calls: { groups: { uids: string[]; keep: string[] }[]; whole: string[][] }[] = [];
      if (whole) calls.push({ groups: [], whole: [whole.uids] });
      else {
        let call: { uids: string[]; keep: string[] }[] = [];
        let size = 0;
        for (const pick of picksFrom(marks, allGroups)) {
          call.push(pick);
          size += pick.uids.length - pick.keep.length;
          if (size >= TRASH_CHUNK) {
            calls.push({ groups: call, whole: [] });
            call = [];
            size = 0;
          }
        }
        if (call.length) calls.push({ groups: call, whole: [] });
      }
      const r = { trashed: [] as string[], failed: 0, skipped: 0 };
      const planned = (c: (typeof calls)[number]) =>
        c.groups.reduce((m, g) => m + g.uids.length - g.keep.length, 0) + c.whole.reduce((m, w) => m + w.length, 0);
      const total = calls.reduce((n, c) => n + planned(c), 0);
      let done = 0;
      publishMoving({ done, total });
      for (const params of calls) {
        const part = await rpc<{ trashed: string[]; failed: number; skipped: number }>("duplicatesTrash", params);
        onTrashed(part.trashed);
        r.trashed.push(...part.trashed);
        r.failed += part.failed;
        r.skipped += part.skipped;
        // By what each call was planned to take: one it skipped (changed meanwhile) is done with too.
        done += planned(params);
        publishMoving({ done, total });
      }
      const next: Marks = new Map(marks);
      if (whole) next.delete(whole.key);
      else next.clear();
      setMarks(next);
      setToast(
        r.failed > 0
          ? t("trash.movedPartial", { ok: r.trashed.length, failed: r.failed })
          : r.skipped > 0 && r.trashed.length === 0
            ? t("duplicates.changed")
            : t("trash.moved", { count: r.trashed.length }),
      );
    } catch (e) {
      setToast(String(e));
    } finally {
      publishMoving(null);
      // Also after a call that failed part way: the calls before it did trash their photos.
      const s = await rpc<Status>("duplicatesStatus").catch(() => null);
      if (s) {
        setStatus(s);
        await loadGroups(s.version);
      }
      setBusy(false);
    }
  }

  const scanning = status?.state === "scanning";
  const counts: Record<Tab, number> = {
    identical: groups?.identical.length ?? 0,
    same: groups?.same.length ?? 0,
    burst: groups?.burst.length ?? 0,
    similar: groups?.similar.length ?? 0,
    ignored: groups?.ignored.length ?? 0,
  };
  const hint = `duplicates.${tab}Hint` as const;
  // Similar photos may differ on purpose, so they are not marked all at once.
  const canMarkEvery = tab === "identical" || tab === "same" || tab === "burst";

  return (
    <div className="dp-page">
      <div className="dp-head">
        <div className="dp-tabs" role="tablist">
          {TABS.map((key) => (
            <button
              key={key}
              role="tab"
              aria-selected={tab === key}
              className={`g-chip${tab === key ? " sel" : ""}`}
              onClick={() => setTab(key)}
            >
              {t(`duplicates.${key}`)}
              <span className="dp-tabcount">{groups?.ready ? counts[key] : " "}</span>
            </button>
          ))}
        </div>
        <div className="dp-status" aria-live="polite">
          {moving ? (
            <>
              <span>
                {t("duplicates.moving", {
                  done: moving.done.toLocaleString(locale),
                  total: moving.total.toLocaleString(locale),
                })}
              </span>
              <span className="dp-bar">
                <span style={{ width: `${moving.total ? Math.round((moving.done / moving.total) * 100) : 0}%` }} />
              </span>
            </>
          ) : scanning && status ? (
            <>
              <span>
                {status.total > 0
                  ? t("duplicates.scanning", { done: status.done.toLocaleString(locale), total: status.total.toLocaleString(locale) })
                  : t("duplicates.reading")}
              </span>
              <span className="dp-bar">
                <span style={{ width: `${status.total ? Math.round((status.done / status.total) * 100) : 0}%` }} />
              </span>
            </>
          ) : status?.state === "failed" ? (
            <>
              <span>{t("duplicates.failed")}</span>
              <button className="g-chip" onClick={() => void rpc<Status>("duplicatesStart").then(setStatus).catch(() => {})}>
                {t("duplicates.retry")}
              </button>
            </>
          ) : (
            <span>{t(hint)}</span>
          )}
        </div>
        {tab !== "ignored" && list.length > 0 && (
          <p className="dp-hint">
            {t("duplicates.pickHint")}
            {canMarkEvery && list.length > 1 && (
              <button className="g-chip dp-markall" disabled={working} onClick={markEvery}>
                {t("duplicates.markEvery", { count: list.length.toLocaleString(locale) })}
              </button>
            )}
          </p>
        )}
      </div>

      {!groups?.ready ? (
        <div className="dp-skeleton" aria-hidden>
          {[0, 1, 2].map((i) => (
            <div key={i} className="dp-card dp-card-ghost g-skel" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <div className="g-empty">
          <p className="g-empty-title">
            {t(tab === "ignored" ? "duplicates.emptyIgnored" : scanning ? "duplicates.emptyYet" : "duplicates.empty")}
          </p>
        </div>
      ) : (
        <div className="dp-list">
          {visible.map((group) => {
            const marked = marks.get(group.key);
            return (
              <section key={group.key} className="dp-card">
                <header className="dp-cardhead">
                  <span className="dp-cardtitle">
                    {t(`duplicates.${group.kind}Group` as const)}
                  </span>
                  <span className="dp-cardcount">{group.uids.length}</span>
                  <div className="g-spacer" />
                  {tab !== "ignored" ? (
                    <>
                      <button className="g-chip" onClick={() => allButKeeper(group)}>
                        {t(group.keep !== undefined ? "duplicates.allButLargest" : "duplicates.allButFirst")}
                      </button>
                      <button className="g-chip" onClick={() => void ignore(group, true)}>
                        {t("duplicates.ignore")}
                      </button>
                      <button className="g-chip danger" disabled={working} onClick={() => setConfirm({ whole: group })}>
                        {t("duplicates.deleteGroup")}
                      </button>
                    </>
                  ) : (
                    <button className="g-chip" onClick={() => void ignore(group, false)}>
                      {t("duplicates.unignore")}
                    </button>
                  )}
                </header>
                <div className="dp-tiles">
                  {group.uids.map((uid, i) => {
                    const m = meta[uid];
                    const going = !!marked?.has(uid);
                    const src = thumbs[uid];
                    return (
                      <div key={uid} className={`dp-tile${going ? " going" : ""}`}>
                        <button
                          className="dp-thumb"
                          onClick={() => onTile(group, uid)}
                          onDoubleClick={() => onView(group.uids, uid)}
                          title={t("duplicates.tileHint")}
                          aria-pressed={tab !== "ignored" ? going : undefined}
                        >
                          {src ? <img src={src} alt="" draggable={false} loading="lazy" /> : <span className="dp-thumbph" />}
                          {group.keep === i && <span className="dp-largest">{t("duplicates.largest")}</span>}
                          {m?.mediaType?.startsWith("video/") && (
                            <span className="dp-video">
                              <PlayArrowIcon size={16} />
                            </span>
                          )}
                          {tab !== "ignored" && (
                            <span className={`dp-mark${going ? " going" : ""}`}>
                              {t(going ? "duplicates.remove" : "duplicates.keep")}
                            </span>
                          )}
                        </button>
                        <div className="dp-name" title={m?.name}>
                          {m?.name ?? " "}
                        </div>
                        <div className="dp-sub">
                          {[m?.size ? formatBytes(m.size) : null, group.times[i] ? new Date(group.times[i]).toLocaleDateString(locale) : null]
                            .filter(Boolean)
                            .join(" · ") || " "}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
          {list.length > shownCount && (
            <button className="g-chip dp-more" onClick={() => setShownCount((n) => n + PAGE)}>
              {t("duplicates.showMore", { count: (list.length - shownCount).toLocaleString(locale) })}
            </button>
          )}
        </div>
      )}

      {tab !== "ignored" && (
        <SelectionBar
          count={markedCount}
          busy={working}
          onCancel={() => setMarks(new Map())}
          onTrash={() => setConfirm({ whole: null })}
        />
      )}

      {confirm && (
        <Confirm
          title={t(confirm.whole ? "duplicates.confirmWholeTitle" : "duplicates.confirmTitle")}
          message={
            confirm.whole
              ? t("duplicates.confirmWholeMessage")
              : sizesKnown
                ? t("duplicates.confirmMessage", { count: markedCount, size: formatBytes(markedBytes) })
                : t("duplicates.confirmMessageCount", {
                    count: markedCount.toLocaleString(locale),
                    groups: marks.size.toLocaleString(locale),
                  })
          }
          confirmLabel={t("selection.trash")}
          danger
          onConfirm={() => void trash(confirm.whole)}
          onCancel={() => setConfirm(null)}
        />
      )}

      {toast && <div className="g-toast">{toast}</div>}
    </div>
  );
}
