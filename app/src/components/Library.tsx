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

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useThumbnails } from "../hooks/useThumbnails";
import { CheckIcon, ChevronRightIcon } from "./icons";
import { FaceNamer } from "./FaceNamer";
import type { LooseFace } from "../lib/localFaces";
import { useThumbServerBase } from "../lib/thumbStore";
import { faceCoverUrl } from "../lib/faceCoverUrl";
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

/** A person or label with its photos found in this library, newest first. A person found on
 *  this computer carries its id, which the name and merge actions go by. */
export type LibraryEntry = {
  name: string;
  uids: string[];
  cover: string | null;
  box: FaceBox | null;
  personId?: string;
  /** How many photos to show on the card, where `uids` is not read for it (an album). */
  count?: number;
  /** What tells this card from the others, where the name may not (two albums of one name). */
  key?: string;
};

export type LibraryKind = "people" | "labels";

/** A page under the Albums tab: the people, the labels, or the map. */
export type LibraryPageKind = LibraryKind | "map" | "collection" | "duplicates" | "fixdates" | "hidden";

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
/** The least, near an edge: as the thumbnail server's FACE_ZOOM_OUT_MIN. */
const FACE_ZOOM_OUT_MIN = 1.2;

/**
 * Calls `onNear` once `el` comes within a screen of the view, through one observer for each
 * scrolling area (shared by every face in it); returns the way to stop watching. Watched
 * against the area that scrolls, not the window: a margin around the window does not reach
 * past a scrolling area's edge, which clips what is in it.
 */
const nearWatch = new Map<Element, () => void>();
const nearObservers = new Map<Element | null, { observer: IntersectionObserver; watched: number }>();
function scrollingAreaOf(el: Element): Element | null {
  for (let at = el.parentElement; at; at = at.parentElement) {
    const { overflowY } = getComputedStyle(at);
    if (overflowY === "auto" || overflowY === "scroll") return at;
  }
  return null;
}
function whenNear(el: Element, onNear: () => void): () => void {
  if (typeof IntersectionObserver === "undefined") {
    onNear();
    return () => {};
  }
  const root = scrollingAreaOf(el);
  let area = nearObservers.get(root);
  if (!area) {
    const made: { observer: IntersectionObserver; watched: number } = {
      observer: new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const call = nearWatch.get(entry.target);
            if (call) stop(entry.target);
            call?.();
          }
        },
        { root, rootMargin: "100% 0px" },
      ),
      watched: 0,
    };
    nearObservers.set(root, made);
    area = made;
  }
  const watching = area;
  // Stops watching `target`; an area with nothing left to watch lets its observer go.
  function stop(target: Element) {
    if (!nearWatch.delete(target)) return;
    watching.observer.unobserve(target);
    if (--watching.watched === 0 && nearObservers.get(root) === watching) {
      watching.observer.disconnect();
      nearObservers.delete(root);
    }
  }
  nearWatch.set(el, onNear);
  watching.watched++;
  watching.observer.observe(el);
  return () => stop(el);
}

/** How long a face's cut may take before the grid thumbnail stands in for it. */
const STAND_IN_AFTER_MS = 350;

/** A person's cover cut to their face: a square FACE_ZOOM_OUT times the face. */
export function FaceCover({ uid, thumb, box }: { uid: string; thumb: string; box: FaceBox | null }) {
  // A face is a small part of its photo, so the grid thumbnail blurs when cut down to it.
  // The thumbnail server cuts the face out of the HD preview and serves it card-sized, so
  // the window decodes a small square rather than a 1920 px preview per person, and a
  // cover off screen is never asked for (the image loads lazily).
  const base = useThumbServerBase();
  // The circle's size on screen, so a small one is cut small (from the grid thumbnail), and
  // whether it is near the screen at all: a circle far off asks for nothing, so a page of
  // hundreds of faces costs what is in view.
  const [px, setPx] = useState<number | null>(null);
  const [near, setNear] = useState(false);
  const probe = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const el = probe.current;
    const frame = el?.parentElement;
    if (!el || !frame) return;
    const side = Math.max(frame.clientWidth, frame.clientHeight);
    // Not laid out (hidden as it mounted): the largest cut, as before sizes were asked.
    setPx(side > 0 ? Math.ceil(side * (window.devicePixelRatio || 1)) : 1e6);
    return whenNear(el, () => setNear(true));
  }, []);
  const cut = base && box && px ? faceCoverUrl(base, uid, box, px) : null;
  const [cutFailed, setCutFailed] = useState<string | null>(null);
  const [cutShown, setCutShown] = useState<string | null>(null);
  const usable = near && cut && cutFailed !== cut ? cut : null;
  const ready = !!usable && cutShown === usable;
  // The stand-in (the grid thumbnail cut to the face in the window) only for a cut that is
  // slow to come, or that cannot be had: one kept from before arrives at once.
  const [late, setLate] = useState<string | null>(null);
  useEffect(() => {
    if (!usable || ready) return;
    const timer = setTimeout(() => setLate(usable), STAND_IN_AFTER_MS);
    return () => clearTimeout(timer);
  }, [usable, ready]);
  const noCut = !box || (!!base && !!cut && cutFailed === cut) || base === null;
  const standIn = near && (noCut || (!ready && late === usable));
  // The same three places every time, so nothing under the cut is remounted as it arrives.
  return (
    <>
      {standIn && <ThumbFaceCover key="thumb" thumb={thumb} box={box} />}
      {usable && (
        <img
          key="cut"
          src={usable}
          alt=""
          draggable={false}
          style={ready ? undefined : { opacity: 0 }}
          onLoad={() => setCutShown(usable)}
          onError={() => setCutFailed(usable)}
        />
      )}
      <span key="probe" ref={probe} aria-hidden style={{ position: "absolute", inset: 0, pointerEvents: "none" }} />
    </>
  );
}

/**
 * The grid thumbnail cut to the face in the window: the picture is scaled and moved so the
 * square the thumbnail server would cut (faceSquare) fills its square frame. For when the
 * thumbnail server cannot cut it, and until its cut is in. Until the picture's own shape is
 * known it is hidden, as the whole picture would show some other part of it.
 */
function ThumbFaceCover({ thumb, box }: { thumb: string; box: FaceBox | null }) {
  // The shape of the picture it was measured on: a reused card given another picture waits
  // for that one's.
  const [measured, setMeasured] = useState<{ thumb: string; aspect: number } | null>(null);
  const aspect = measured?.thumb === thumb ? measured.aspect : null;
  const src = thumb;
  let style: CSSProperties | undefined;
  if (box && aspect) {
    const [l, top, r, b] = box;
    const cx = (l + r) / 2;
    const cy = (top + b) / 2;
    // The square's side, as a share of the picture's width: as the thumbnail server cuts it
    // (faceSquare), zoomed in near an edge to keep the face centred, down to the face itself.
    const face = Math.max(r - l, (b - top) / aspect);
    const room = 2 * Math.min(cx, 1 - cx, cy / aspect, (1 - cy) / aspect);
    const side = Math.min(Math.max(face * FACE_ZOOM_OUT_MIN, Math.min(face * FACE_ZOOM_OUT, room)), Math.min(1, 1 / aspect));
    const width = 100 / Math.max(side, 1e-3);
    const height = width / aspect;
    // Kept inside the picture, so no edge of the circle shows past it.
    const left = Math.min(0, Math.max(100 - width, 50 - cx * width));
    const topPct = Math.min(0, Math.max(100 - height, 50 - cy * height));
    style = { position: "absolute", width: `${width}%`, height: `${height}%`, left: `${left}%`, top: `${topPct}%`, objectFit: "fill" };
  } else if (box) {
    // Its shape not known yet, the whole picture would show some other part of it: kept
    // hidden that moment, so the circle shows nothing rather than the wrong spot.
    style = { opacity: 0 };
  }
  return (
    // Lazy, as the cut over it is: a page of people mounts every card, and an eager picture
    // here fetched and decoded every person's grid thumbnail, on screen or not (8000 in one
    // visit to People in the profile).
    <img
      src={src}
      alt=""
      draggable={false}
      loading="lazy"
      style={style}
      onLoad={(e) => {
        const img = e.currentTarget;
        if (img.naturalWidth && img.naturalHeight) setMeasured({ thumb, aspect: img.naturalWidth / img.naturalHeight });
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
  selected,
  selecting,
  onToggle,
  onContext,
}: {
  entry: LibraryEntry;
  cover: string | null | undefined;
  onOpen: (entry: LibraryEntry) => void;
  selected?: boolean;
  /** Something is selected, so a plain click adds to the selection rather than opening. */
  selecting?: boolean;
  onToggle?: (entry: LibraryEntry, range: boolean) => void;
  onContext?: (entry: LibraryEntry, e: React.MouseEvent) => void;
}) {
  const t = useT();
  return (
    <button
      className={`lib-card${selected ? " selected" : ""}`}
      aria-pressed={onToggle ? !!selected : undefined}
      onClick={(e) => {
        if (onToggle && (selecting || e.ctrlKey || e.metaKey || e.shiftKey)) onToggle(entry, e.shiftKey);
        else onOpen(entry);
      }}
      onContextMenu={
        onContext
          ? (e) => {
              e.preventDefault();
              // This person's menu answers the click; the shell's document listener must
              // not open its own on top of it.
              e.stopPropagation();
              onContext(entry, e);
            }
          : undefined
      }
    >
      {onToggle && (
        <span className="lib-check" aria-hidden>
          <CheckIcon size={14} />
        </span>
      )}
      {entry.cover && cover ? (
        entry.box ? (
          <span className="lib-facebox">
            <FaceCover uid={entry.cover} thumb={cover} box={entry.box} />
          </span>
        ) : (
          <img className="lib-cardimg" src={cover} alt="" draggable={false} loading="lazy" />
        )
      ) : null}
      <span className="lib-cardtext">
        <span className="lib-cardname">{entry.name}</span>
        <span className="lib-cardcount">
          {t((entry.count ?? entry.uids.length) === 1 ? "common.photoCount.one" : "common.photoCount.other", {
            count: entry.count ?? entry.uids.length,
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
  selected,
  onToggle,
  onContext,
}: {
  entries: LibraryEntry[];
  face?: boolean;
  cardSize: number;
  onOpen: (entry: LibraryEntry) => void;
  /** The people picked, by id, where cards can be picked. */
  selected?: Set<string>;
  onToggle?: (entry: LibraryEntry, range: boolean) => void;
  onContext?: (entry: LibraryEntry, e: React.MouseEvent) => void;
}) {
  const covers = useCovers(entries);
  return (
    <div className="lib-grid" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${cardSize}px, 1fr))` }}>
      {entries.map((entry) => (
        <EntryCard
          key={entry.key ?? entry.personId ?? entry.name}
          entry={entry}
          cover={entry.cover ? covers[entry.cover] : null}
          onOpen={onOpen}
          selected={!!entry.personId && !!selected?.has(entry.personId)}
          selecting={!!selected && selected.size > 0}
          onToggle={onToggle}
          onContext={onContext}
        />
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
  /** The labels kept on this computer, which need no copy on Drive to show. */
  local?: boolean;
  onOpen: (entry: LibraryEntry) => void;
  onRetry: () => void;
};

/** The people or the labels the phone saved, as cards that open their photos. */
export function LibraryPage({ kind, cardSize, state, data, entries, local, onOpen, onRetry }: PageProps) {
  const grid = { gridTemplateColumns: `repeat(auto-fill, minmax(${cardSize}px, 1fr))` };
  const t = useT();

  const sources = (data?.sources ?? []).filter((s) => s.kind === (kind === "people" ? "faces" : "labels"));

  if (local && state === "ready") {
    return entries.length === 0 ? (
      <div className="g-empty">
        <p className="g-empty-title">{t("library.noLabels")}</p>
      </div>
    ) : (
      <EntryGrid entries={entries} face={false} cardSize={cardSize} onOpen={onOpen} />
    );
  }
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

/**
 * The people found on this computer: everyone named, then the groups still to be named, with a
 * line saying how far the look through the library has got while it runs.
 */
export function LocalPeoplePage({
  named,
  unnamed,
  suggestions,
  loaded,
  scanning,
  cardSize,
  onOpen,
  onMerge,
  onDismiss,
  selected,
  onToggle,
  onContext,
  loose,
  names,
  onNameFaces,
  onRejectFaces,
}: {
  /** The faces in no group worth naming, and how many there are in all. */
  loose: { faces: LooseFace[]; total: number };
  /** Everyone already named, offered while a name is typed. */
  names: string[];
  onNameFaces: (faceIds: string[], name: string) => Promise<void>;
  onRejectFaces: (faceIds: string[]) => Promise<void>;
  selected: Set<string>;
  onToggle: (entry: LibraryEntry, range: boolean) => void;
  onContext: (entry: LibraryEntry, e: React.MouseEvent) => void;
  named: LibraryEntry[];
  unnamed: LibraryEntry[];
  /** Unnamed groups that might be a named person, each with that person. */
  suggestions: { unnamed: LibraryEntry; named: LibraryEntry }[];
  loaded: boolean;
  /** The line saying how far the scan is, while it runs. */
  scanning: string | null;
  cardSize: number;
  onOpen: (entry: LibraryEntry) => void;
  onMerge: (unnamed: LibraryEntry, named: LibraryEntry) => Promise<void>;
  onDismiss: (unnamed: LibraryEntry, named: LibraryEntry) => Promise<void>;
}) {
  const t = useT();
  const grid = { gridTemplateColumns: `repeat(auto-fill, minmax(${cardSize}px, 1fr))` };
  if (!loaded) {
    return (
      <div className="lib-grid" style={grid}>
        {Array.from({ length: 8 }, (_, i) => (
          <div className="lib-card lib-skeleton" key={i} />
        ))}
      </div>
    );
  }
  if (named.length === 0 && unnamed.length === 0 && loose.total === 0) {
    return (
      <div className="g-empty">
        <p className="g-empty-title">{t("faces.noPeople")}</p>
        {scanning && <p className="lib-note">{scanning}</p>}
      </div>
    );
  }
  return (
    <>
      {scanning && <p className="lib-note scan">{scanning}</p>}
      {suggestions.length > 0 && (
        <SuggestionCards suggestions={suggestions} onOpen={onOpen} onMerge={onMerge} onDismiss={onDismiss} />
      )}
      {named.length > 0 && (
        <EntryGrid
          entries={named}
          face
          cardSize={cardSize}
          onOpen={onOpen}
          selected={selected}
          onToggle={onToggle}
          onContext={onContext}
        />
      )}
      {unnamed.length > 0 && (
        <section className="lib-section">
          <h2 className="lib-subhead">{t("faces.notNamedYet")}</h2>
          <EntryGrid
            entries={unnamed}
            face
            cardSize={cardSize}
            onOpen={onOpen}
            selected={selected}
            onToggle={onToggle}
            onContext={onContext}
          />
        </section>
      )}
      {loose.total > 0 && (
        <LooseFaces loose={loose} names={names} onName={onNameFaces} onReject={onRejectFaces} />
      )}
    </>
  );
}

/**
 * The faces in no group worth naming, each on its own: picked a few at a time and named, put
 * with someone already named, or left out as not a person.
 */
/** Faces in no group shown at once, and added each time more are asked for. */
const LOOSE_PAGE = 120;

function LooseFaces({
  loose,
  names,
  onName,
  onReject,
}: {
  loose: { faces: LooseFace[]; total: number };
  names: string[];
  onName: (faceIds: string[], name: string) => Promise<void>;
  onReject: (faceIds: string[]) => Promise<void>;
}) {
  const t = useT();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // A page at a time: the whole list drawn at once (600 faces) made scrolling People cost
  // the window most of a core, for faces seldom looked at down there.
  const [shown, setShown] = useState(LOOSE_PAGE);
  const faces = useMemo(() => loose.faces.slice(0, shown), [loose, shown]);
  const thumbs = useThumbnails(useMemo(() => faces.map((f) => f.uid), [faces]));
  // Only faces still shown stay picked: one pushed below the page by new faces is not named
  // unseen with the rest.
  useEffect(() => {
    setPicked((p) => {
      const ids = new Set(faces.map((f) => f.faceId));
      const kept = [...p].filter((id) => ids.has(id));
      return kept.length === p.size ? p : new Set(kept);
    });
  }, [faces]);
  const toggle = (id: string) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <section className="lib-section">
      <h2 className="lib-subhead">{t("faces.looseTitle")}</h2>
      <p className="lib-note scan">
        {loose.total > faces.length
          ? t("faces.looseMore", { shown: faces.length, total: loose.total })
          : t("faces.looseHint")}
      </p>
      {picked.size > 0 && (
        <div className="lib-looseactions">
          <span className="lib-loosecount">{t("faces.picked", { count: picked.size })}</span>
          <FaceNamer
            names={names}
            onName={async (name) => {
              await onName([...picked], name);
              setPicked(new Set());
            }}
            onReject={async () => {
              await onReject([...picked]);
              setPicked(new Set());
            }}
            onCancel={() => setPicked(new Set())}
          />
        </div>
      )}
      <div className="lib-loosegrid">
        {faces.map((f) => (
          <button
            key={f.faceId}
            className={`lib-findcell${picked.has(f.faceId) ? " selected" : ""}`}
            aria-pressed={picked.has(f.faceId)}
            onClick={() => toggle(f.faceId)}
          >
            {thumbs[f.uid] ? (
              <span className="lib-facebox">
                <FaceCover uid={f.uid} thumb={thumbs[f.uid]!} box={f.box} />
              </span>
            ) : null}
            <span className="lib-check" aria-hidden>
              <CheckIcon size={14} />
            </span>
          </button>
        ))}
      </div>
      {loose.faces.length > shown && (
        <button className="lib-seemore" onClick={() => setShown((n) => n + LOOSE_PAGE)}>
          {t("faces.looseShowMore", { count: Math.min(LOOSE_PAGE, loose.faces.length - shown) })}
        </button>
      )}
    </section>
  );
}

/** A face, cut round from the person's cover, at a small fixed size. */
function FaceDot({ entry, thumb }: { entry: LibraryEntry; thumb: string | null | undefined }) {
  return (
    <span className="lib-suggestface">
      {entry.cover && thumb ? (
        <span className="lib-facebox">
          <FaceCover uid={entry.cover} thumb={thumb} box={entry.box} />
        </span>
      ) : null}
    </span>
  );
}

/**
 * "Might be the same person", as the phone asks it: the unnamed group's face beside the named
 * person's, with Merge and Different person. Clicking the faces opens the group to look first.
 */
function SuggestionCards({
  suggestions,
  onOpen,
  onMerge,
  onDismiss,
}: {
  suggestions: { unnamed: LibraryEntry; named: LibraryEntry }[];
  onOpen: (entry: LibraryEntry) => void;
  onMerge: (unnamed: LibraryEntry, named: LibraryEntry) => Promise<void>;
  onDismiss: (unnamed: LibraryEntry, named: LibraryEntry) => Promise<void>;
}) {
  const t = useT();
  const [busy, setBusy] = useState<string | null>(null);
  const covers = useCovers(useMemo(() => suggestions.flatMap((s) => [s.unnamed, s.named]), [suggestions]));
  const run = async (key: string, action: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    try {
      await action();
    } catch {
      /* the card stays for another try */
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="lib-section">
      <h2 className="lib-subhead">{t("faces.suggestTitle")}</h2>
      <div className="lib-suggest">
        {suggestions.map(({ unnamed, named }) => {
          const key = `${unnamed.personId}>${named.personId}`;
          return (
            <div className="lib-suggestcard" key={key}>
              <button className="lib-suggestfaces" onClick={() => onOpen(unnamed)} title={unnamed.name}>
                <FaceDot entry={unnamed} thumb={unnamed.cover ? covers[unnamed.cover] : null} />
                <FaceDot entry={named} thumb={named.cover ? covers[named.cover] : null} />
              </button>
              <div className="lib-suggesttext">
                <span className="lib-suggestname">{t("faces.suggestQuestion", { name: named.name })}</span>
                <span className="lib-suggestcount">
                  {t(unnamed.uids.length === 1 ? "common.photoCount.one" : "common.photoCount.other", {
                    count: unnamed.uids.length,
                  })}
                </span>
              </div>
              <div className="lib-suggestactions">
                <button
                  className="lib-suggestbtn primary"
                  disabled={busy !== null}
                  onClick={() => void run(key, () => onMerge(unnamed, named))}
                >
                  {t("faces.merge")}
                </button>
                <button
                  className="lib-suggestbtn"
                  disabled={busy !== null}
                  onClick={() => void run(key, () => onDismiss(unnamed, named))}
                >
                  {t("faces.differentPerson")}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
