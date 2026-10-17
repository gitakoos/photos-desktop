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
import { rpc } from "../lib/rpc";
import { useThumbnails } from "../hooks/useThumbnails";
import { PhotoGrid, PhotoGridSkeleton } from "../components/PhotoGrid";
import { VirtualSections } from "../components/VirtualSections";
import { Marquee, SelectionBar, useSelection } from "../hooks/useSelection";
import { Confirm } from "../components/Confirm";
import { ContextMenu, type MenuAction, type MenuAt } from "../components/ContextMenu";
import { RefreshIcon, TrashIcon } from "../components/icons";
import { useT } from "../lib/i18n";
import { dropPreview } from "../lib/previewStore";

export type TrashItem = {
  uid: string;
  name: string;
  type: string;
  mediaType: string | null;
  captureTime: number;
  tags: number[];
};

/**
 * The trash, served by the SDK (`iterateTrashedNodeUids` + `iterateNodes`).
 *
 * Restore is the ordinary action here, so a click selects rather than opens: what
 * is highlighted is exactly what the buttons act on. Deleting for good is the one
 * thing neither the app nor Proton can undo, so it is the only action in the app
 * behind a confirmation that names the finality outright.
 *
 * Names are always shown. Thumbnails are fetched the same way every other grid
 * fetches them, and a node that will not yield one still reads as itself rather
 * than as a blank tile.
 */
export function Trash({
  cellSize,
  reloadKey,
  initial,
  onCount,
  onRestored,
  onData,
}: {
  cellSize: number;
  /** Bumped from above after an empty, so the view refetches. */
  reloadKey: number;
  /** What the shell warmed, for the first paint only; the read below still runs. */
  initial?: TrashItem[] | null;
  onCount?: (n: number | null) => void;
  /** A restored photo is back in the timeline, so the shell reloads its data. */
  onRestored?: () => void;
  /** The fresh read, so the shell's snapshot keeps up with this view. */
  onData?: (rows: TrashItem[]) => void;
}) {
  const t = useT();
  const [items, setItems] = useState<TrashItem[]>(initial ?? []);
  // Warmed means there is something to show, so the shimmer is not the first thing
  // the user sees. The read still goes out and still replaces this.
  const [loading, setLoading] = useState(!initial);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuAt<string> | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const sel = useSelection(gridRef);
  // Whether restore or delete is still working, so the bar can stand down instead of
  // taking a second click on work already in flight. The ref is what actually bars it:
  // the right-click menu offers the same two and does not wait for a render to know.
  const [selectionBusy, setSelectionBusy] = useState(false);
  const selectionRunning = useRef(false);

  /** Runs one selection action, holding the bar down for as long as it takes. */
  const runSelection = useCallback(async (action: () => Promise<void>) => {
    if (selectionRunning.current) return;
    selectionRunning.current = true;
    setSelectionBusy(true);
    try {
      await action();
    } finally {
      selectionRunning.current = false;
      setSelectionBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(id);
  }, [toast]);

  // Always re-reads on arrival, warmed or not: what the shell handed over is a
  // first paint, never the answer.
  useEffect(() => {
    let cancelled = false;
    setError("");
    (async () => {
      try {
        const list = await rpc<TrashItem[]>("listTrashed");
        if (cancelled) return;
        setItems(list);
        onData?.(list);
        sel.clear();
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  // Report the count up to the top bar (null while loading), which owns the
  // count badge and the empty-trash button.
  useEffect(() => {
    onCount?.(loading ? null : items.length);
  }, [loading, items.length, onCount]);

  const uids = useMemo(() => items.map((i) => i.uid), [items]);
  const thumbs = useThumbnails(uids);

  // A trashed album is restorable like anything else here, so it is listed and
  // badged rather than hidden. Resolved once: the overlay runs per tile.
  const albumUids = useMemo(
    () => new Set(items.filter((i) => i.type === "album").map((i) => i.uid)),
    [items],
  );

  /** Drop the nodes an action succeeded on, and say how it went. */
  function applyResults(results: { uid: string; ok: boolean }[], doneKey: string) {
    const gone = new Set(results.filter((r) => r.ok).map((r) => r.uid));
    gone.forEach(dropPreview);
    setItems((prev) => prev.filter((i) => !gone.has(i.uid)));
    sel.clear();
    const failed = results.length - gone.size;
    setToast(
      failed > 0
        ? t("trash.partial", { ok: gone.size, failed })
        : t(doneKey, { count: gone.size }),
    );
    return gone.size;
  }

  async function restoreSelected() {
    const picked = [...sel.selected];
    if (picked.length === 0) return;
    try {
      const results = await rpc<{ uid: string; ok: boolean }[]>("restorePhotos", { uids: picked });
      if (applyResults(results, "trash.restored") > 0) onRestored?.();
    } catch (e) {
      setError(String(e));
    }
  }

  async function deleteSelectedForever() {
    const picked = [...sel.selected];
    if (picked.length === 0) return;
    try {
      const results = await rpc<{ uid: string; ok: boolean }[]>("deletePhotosForever", {
        uids: picked,
      });
      applyResults(results, "trash.deleted");
    } catch (e) {
      setError(String(e));
    }
  }

  sel.order.current = items.map((i) => i.uid);

  /** Nothing opens from the trash: a click selects, so the actions stay honest. */
  function onCellClick(uid: string, e?: { shiftKey: boolean }) {
    if (sel.wasDragging()) return;
    sel.toggle(uid, e);
  }

  /** Right-clicking outside the selection makes that node the selection first. */
  function onCellContext(uid: string, e: { clientX: number; clientY: number }) {
    if (!sel.selected.has(uid)) sel.setSelected(new Set([uid]));
    setMenu({ x: e.clientX, y: e.clientY, target: uid });
  }

  // The two things the trash is for. Deleting for good keeps the confirmation
  // that names the finality, because the menu is a shorter way to reach it, not
  // a way around it.
  const actions: MenuAction[] = menu
    ? [
        {
          key: "restore",
          label: t("selection.restore"),
          icon: <RefreshIcon size={14} />,
          onSelect: () => void runSelection(restoreSelected),
        },
        {
          key: "delete",
          label: t("selection.deleteForever"),
          icon: <TrashIcon size={14} />,
          separator: true,
          danger: true,
          onSelect: () => setConfirmDelete(true),
        },
      ]
    : [];

  return (
    <div ref={gridRef} {...sel.containerProps}>
      {error && <div className="g-error">{error}</div>}

      {loading && items.length === 0 && <PhotoGridSkeleton count={18} cellSize={cellSize} />}

      {!loading && items.length === 0 && !error && (
        <div className="g-empty">
          <p className="g-empty-title">{t("trash.emptyTitle")}</p>
          <p className="g-empty-sub">{t("trash.emptySub")}</p>
        </div>
      )}

      {items.length > 0 && (
        <VirtualSections
          sections={[{ key: "trash", items: items }]}
          cellSize={cellSize}
          grid={(_, items) => (
            <PhotoGrid
              items={items}
              thumbs={thumbs}
              cellSize={cellSize}
              selected={sel.selected}
              onToggle={sel.toggle}
              onOpen={onCellClick}
              onContext={onCellContext}
              showName
              renderOverlay={(item) =>
                albumUids.has(item.uid) ? (
                  <div className="g-shared-badges">
                    <span className="g-badge" title={t("shared.album")}>
                      ▤
                    </span>
                  </div>
                ) : null
              }
            />
          )}
        />
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} actions={actions} onClose={() => setMenu(null)} />
      )}

      <Marquee rect={sel.marquee} />
      <SelectionBar
        count={sel.selected.size}
        busy={selectionBusy}
        onCancel={sel.clear}
        onRestore={() => void runSelection(restoreSelected)}
        onDeleteForever={() => setConfirmDelete(true)}
      />

      {confirmDelete && (
        <Confirm
          title={t("confirm.deleteTitle")}
          message={t(
            sel.selected.size === 1 ? "confirm.deleteCount.one" : "confirm.deleteCount.other",
            { count: sel.selected.size },
          )}
          confirmLabel={t("confirm.deleteConfirm")}
          danger
          irreversible
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false);
            void runSelection(deleteSelectedForever);
          }}
        />
      )}

      {toast && <div className="g-toast">{toast}</div>}
    </div>
  );
}
