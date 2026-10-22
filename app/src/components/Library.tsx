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

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useThumbnails } from "../hooks/useThumbnails";
import { ChevronRightIcon } from "./icons";
import { cachedPreview, loadPreview } from "../lib/previewStore";
import { useT } from "../lib/i18n";
import "../styles/Library.css";

/** A face's box within its photo, each edge from 0 to 1: left, top, right, bottom. */
export type FaceBox = [number, number, number, number];

/** One person or label as the Android app saved it to Drive, photos by link id. */
export type DriveCollection = { name: string; keys: string[]; cover: string | null; box: FaceBox | null };

/** What `getDriveCollections` answers. */
export type DriveCollections = {
  found: boolean;
  people: DriveCollection[];
  labels: DriveCollection[];
  sources: { kind: "faces" | "labels" | "search"; device: string; savedAt: number }[];
  unreadable: number;
  /** How many photos the search by what they show can reach. */
  searchPhotos?: number;
  /** Search copies of another app version's model, left out. */
  searchOtherModel?: number;
};

/** A person or label with its photos found in this library, newest first. */
export type LibraryEntry = { name: string; uids: string[]; cover: string | null; box: FaceBox | null };

export type LibraryKind = "people" | "labels";

/** A page under the Albums tab: the people, the labels, or the map. */
export type LibraryPageKind = LibraryKind | "map" | "collection";

/** `badge` puts a dot on the tile: something there waits for an answer. */
export type Tile = { key: string; label: string; icon: ReactNode; onClick: () => void; badge?: boolean };

/** The shortcut row at the top of the Albums tab, drawn as the Android app draws it. */
export function LibraryTiles({ tiles }: { tiles: Tile[] }) {
  return (
    <div className="lib-tiles">
      {tiles.map((tile) => (
        <button key={tile.key} className="lib-tile" onClick={tile.onClick}>
          <span className="lib-tilebox">
            {tile.icon}
            {tile.badge && <span className="lib-tiledot" />}
          </span>
          <span className="lib-tilelabel">{tile.label}</span>
        </button>
      ))}
    </div>
  );
}

/** The square around a face, as a multiple of the face's longer side (the Android app's). */
const FACE_ZOOM_OUT = 1.4;

/**
 * The cover cut to the face: the picture is scaled and moved so a square FACE_ZOOM_OUT times
 * the face fills its square frame, kept inside the picture. Until the picture's own shape is
 * known it is shown whole.
 */
function FaceCover({ uid, thumb, box }: { uid: string; thumb: string; box: FaceBox | null }) {
  const [aspect, setAspect] = useState<number | null>(null);
  // A face is a small part of its photo, so the grid thumbnail blurs when cut down to it:
  // the larger preview takes its place once it is in.
  const [preview, setPreview] = useState<string | null>(() => cachedPreview(uid) ?? null);
  useEffect(() => {
    let live = true;
    void loadPreview(uid).then((url) => {
      if (live && url) setPreview(url);
    });
    return () => {
      live = false;
    };
  }, [uid]);
  const src = preview ?? thumb;
  let style: CSSProperties | undefined;
  if (box && aspect) {
    const [l, top, r, b] = box;
    // The square's side, as a share of the picture's width.
    const side = Math.min(Math.max(r - l, (b - top) / aspect) * FACE_ZOOM_OUT, Math.min(1, 1 / aspect));
    const width = 100 / side;
    const height = width / aspect;
    const cx = (l + r) / 2;
    const cy = (top + b) / 2;
    // Kept inside the picture, so no edge of the circle shows past it.
    const left = Math.min(0, Math.max(100 - width, 50 - cx * width));
    const topPct = Math.min(0, Math.max(100 - height, 50 - cy * height));
    style = { position: "absolute", width: `${width}%`, height: `${height}%`, left: `${left}%`, top: `${topPct}%`, objectFit: "fill" };
  }
  return (
    <img
      src={src}
      alt=""
      draggable={false}
      style={style}
      onLoad={(e) => {
        const img = e.currentTarget;
        if (img.naturalWidth && img.naturalHeight) setAspect(img.naturalWidth / img.naturalHeight);
      }}
    />
  );
}

/** One person, label or memory: its picture fills a portrait card, the name and the count
 *  on a dark fade at its foot. A person's picture is cut to their face. */
function EntryCard({
  entry,
  cover,
  onOpen,
}: {
  entry: LibraryEntry;
  cover: string | null | undefined;
  onOpen: (entry: LibraryEntry) => void;
}) {
  const t = useT();
  return (
    <button className="lib-card" onClick={() => onOpen(entry)}>
      {entry.cover && cover ? (
        entry.box ? (
          <span className="lib-facebox">
            <FaceCover uid={entry.cover} thumb={cover} box={entry.box} />
          </span>
        ) : (
          <img className="lib-cardimg" src={cover} alt="" draggable={false} />
        )
      ) : null}
      <span className="lib-cardtext">
        <span className="lib-cardname">{entry.name}</span>
        <span className="lib-cardcount">
          {t(entry.uids.length === 1 ? "common.photoCount.one" : "common.photoCount.other", {
            count: entry.uids.length,
          })}
        </span>
      </span>
    </button>
  );
}

function useCovers(entries: LibraryEntry[]) {
  return useThumbnails(useMemo(() => entries.map((e) => e.cover).filter((u): u is string => !!u), [entries]));
}

/** Every entry of a page as a grid of cards, as wide as Ctrl + wheel sets them. */
export function EntryGrid({
  entries,
  cardSize,
  onOpen,
}: {
  entries: LibraryEntry[];
  face?: boolean;
  cardSize: number;
  onOpen: (entry: LibraryEntry) => void;
}) {
  const covers = useCovers(entries);
  return (
    <div className="lib-grid" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${cardSize}px, 1fr))` }}>
      {entries.map((entry) => (
        <EntryCard key={entry.name} entry={entry} cover={entry.cover ? covers[entry.cover] : null} onOpen={onOpen} />
      ))}
    </div>
  );
}

export type CollectionSection = {
  key: string;
  title: string;
  entries: LibraryEntry[];
  onSeeAll: () => void;
};

/**
 * The Collection, as the Android app lays it out: a section per kind of memory, its title
 * opening all of it, and a row of cards under it that scrolls sideways.
 */
export function CollectionPage({
  sections,
  cardSize,
  onOpen,
}: {
  sections: CollectionSection[];
  cardSize: number;
  onOpen: (entry: LibraryEntry, section: string) => void;
}) {
  const t = useT();
  const shown = sections.filter((s) => s.entries.length > 0);
  if (shown.length === 0) {
    return (
      <div className="g-empty">
        <p className="lib-note">{t("library.collectionEmpty")}</p>
      </div>
    );
  }
  return (
    <div className="lib-collection">
      {shown.map((section) => (
        <CollectionRow key={section.key} section={section} cardSize={cardSize} onOpen={onOpen} />
      ))}
    </div>
  );
}

function CollectionRow({
  section,
  cardSize,
  onOpen,
}: {
  section: CollectionSection;
  cardSize: number;
  onOpen: (entry: LibraryEntry, section: string) => void;
}) {
  const covers = useCovers(section.entries);
  return (
    <section className="lib-section">
      <button className="lib-sectionhead" onClick={section.onSeeAll}>
        <span>{section.title}</span>
        <ChevronRightIcon size={22} />
      </button>
      <div className="lib-row">
        {section.entries.map((entry) => (
          <div className="lib-rowcell" key={entry.name} style={{ width: cardSize }}>
            <EntryCard
              entry={entry}
              cover={entry.cover ? covers[entry.cover] : null}
              onOpen={(e) => onOpen(e, section.key)}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

type PageProps = {
  kind: LibraryKind;
  /** The narrowest a card may be, set by Ctrl + wheel like the album list's. */
  cardSize: number;
  state: "loading" | "failed" | "ready";
  data: DriveCollections | null;
  entries: LibraryEntry[];
  onOpen: (entry: LibraryEntry) => void;
  onRetry: () => void;
};

/** The people or the labels the phone saved, as cards that open their photos. */
export function LibraryPage({ kind, cardSize, state, data, entries, onOpen, onRetry }: PageProps) {
  const grid = { gridTemplateColumns: `repeat(auto-fill, minmax(${cardSize}px, 1fr))` };
  const t = useT();

  const sources = (data?.sources ?? []).filter((s) => s.kind === (kind === "people" ? "faces" : "labels"));

  if (state === "loading" && !data) {
    return (
      <div className="lib-grid" style={grid}>
        {Array.from({ length: 8 }, (_, i) => (
          <div className="lib-card lib-skeleton" key={i} />
        ))}
      </div>
    );
  }
  if (state === "failed") {
    return (
      <div className="g-empty">
        <p className="g-empty-title">{t("library.loadFailed")}</p>
        <button className="lib-retry" onClick={onRetry}>
          {t("library.retry")}
        </button>
      </div>
    );
  }
  if (!data?.found || sources.length === 0) {
    return (
      <div className="g-empty">
        <p className="lib-note">{t("library.nothingSaved")}</p>
        {(data?.unreadable ?? 0) > 0 && <p className="lib-note warn">{t("library.unreadable")}</p>}
      </div>
    );
  }
  return (
    <>
      {data.unreadable > 0 && <p className="lib-note warn">{t("library.unreadable")}</p>}
      {entries.length === 0 ? (
        <div className="g-empty">
          <p className="g-empty-title">{t(kind === "people" ? "library.emptyPeople" : "library.emptyLabels")}</p>
        </div>
      ) : (
        <EntryGrid entries={entries} face={kind === "people"} cardSize={cardSize} onOpen={onOpen} />
      )}
    </>
  );
}
