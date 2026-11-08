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

import { useCallback, useEffect, useMemo, useState } from "react";
import { FaceCover } from "./Library";
import { CheckIcon, CloseIcon, SearchIcon } from "./icons";
import { useThumbnails } from "../hooks/useThumbnails";
import { rpc } from "../lib/rpc";
import { useLang, useT } from "../lib/i18n";
import "../styles/Library.css";

/** A face that might be the person, on a photo not yet theirs. */
type Candidate = { faceId: string; uid: string; box: [number, number, number, number]; similarity: number };

/** How far "Find more photos" has got. */
type SweepStatus = { personId: string | null; running: boolean; done: number; total: number; found: number };

/**
 * The side panel beside a named person's photos: the photos that might also be them, to add or
 * turn down a few at a time, and "Find more photos", which reads the photos where no face was
 * found again, more closely, and offers what it finds here as it goes.
 */
export function PersonFindPanel({
  personId,
  name,
  version,
  act,
  onClose,
  top,
}: {
  /** Where the panel starts, under the page's top bar. */
  top: number;
  personId: string;
  name: string;
  /** Goes up whenever the people change, so the list is read again. */
  version: number;
  act: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  onClose: () => void;
}) {
  const t = useT();
  const { lang } = useLang();
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [sweep, setSweep] = useState<SweepStatus | null>(null);

  const read = useCallback(async () => {
    try {
      setCandidates(await rpc<Candidate[]>("facePersonCandidates", { id: personId }));
    } catch {
      setCandidates((c) => c ?? []);
    }
  }, [personId]);

  useEffect(() => {
    void read();
  }, [read, version]);

  useEffect(() => {
    setPicked(new Set());
  }, [personId]);

  // Followed while it runs; what it finds arrives with the people's next change.
  useEffect(() => {
    let live = true;
    let timer = 0;
    const poll = async () => {
      try {
        const next = await rpc<SweepStatus>("faceSweepStatus");
        if (!live) return;
        setSweep(next.personId === personId ? next : null);
        if (next.running) timer = window.setTimeout(poll, 1000);
      } catch {
        /* shown as not running */
      }
    };
    void poll();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [personId, sweep?.running]);

  const covers = useThumbnails(useMemo(() => (candidates ?? []).map((c) => c.uid), [candidates]));
  const running = !!sweep?.running;

  const run = async (method: string) => {
    if (busy || picked.size === 0) return;
    setBusy(true);
    try {
      await act(method, { id: personId, faceIds: [...picked] });
      setPicked(new Set());
      await read();
    } catch {
      /* stays picked for another try */
    } finally {
      setBusy(false);
    }
  };

  const toggle = (faceId: string) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(faceId)) next.delete(faceId);
      else next.add(faceId);
      return next;
    });

  return (
    <aside className="lib-findpanel" style={{ top }} aria-label={t("faces.findTitle", { name })}>
      <div className="lib-findhead">
        <h2 className="lib-findtitle">{t("faces.findTitle", { name })}</h2>
        <button className="lib-findclose" onClick={onClose} title={t("common.cancel")} aria-label={t("common.cancel")}>
          <CloseIcon size={18} />
        </button>
      </div>

      <div className="lib-findsweep">
        {running && sweep ? (
          <>
            <p className="lib-findnote">
              {t("faces.findRunning", {
                done: sweep.done.toLocaleString(lang),
                total: sweep.total.toLocaleString(lang),
                found: sweep.found.toLocaleString(lang),
              })}
            </p>
            <div className="lib-findbar">
              <div style={{ width: `${Math.round((sweep.done / Math.max(1, sweep.total)) * 100)}%` }} />
            </div>
            <button
              className="lib-suggestbtn"
              onClick={() => void rpc<SweepStatus>("faceSweepStop").then(setSweep, () => {})}
            >
              {t("faces.findStop")}
            </button>
          </>
        ) : (
          <>
            <p className="lib-findnote">
              {sweep && sweep.total > 0
                ? t("faces.findDone", { done: sweep.done.toLocaleString(lang), found: sweep.found.toLocaleString(lang) })
                : t("faces.findHint")}
            </p>
            <button
              className="lib-suggestbtn primary"
              onClick={() =>
                void act("faceSweepStart", { id: personId }).then(
                  (s) => setSweep(s as SweepStatus),
                  () => {},
                )
              }
            >
              <SearchIcon size={14} />
              <span>{t("faces.findMore")}</span>
            </button>
          </>
        )}
      </div>

      <div className="lib-findlist">
        {candidates === null ? (
          <div className="lib-findgrid">
            {Array.from({ length: 6 }, (_, i) => (
              <span className="lib-findcell lib-skeleton" key={i} />
            ))}
          </div>
        ) : candidates.length === 0 ? (
          <p className="lib-findnote">{t("faces.findNone")}</p>
        ) : (
          <div className="lib-findgrid">
            {candidates.map((c) => (
              <button
                key={c.faceId}
                className={`lib-findcell${picked.has(c.faceId) ? " selected" : ""}`}
                aria-pressed={picked.has(c.faceId)}
                onClick={() => toggle(c.faceId)}
              >
                {covers[c.uid] ? (
                  <span className="lib-facebox">
                    <FaceCover uid={c.uid} thumb={covers[c.uid]!} box={c.box} />
                  </span>
                ) : null}
                <span className="lib-check" aria-hidden>
                  <CheckIcon size={14} />
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {picked.size > 0 && (
        <div className="lib-findactions">
          <button className="lib-suggestbtn primary" disabled={busy} onClick={() => void run("facePersonAddFaces")}>
            {t("faces.findAdd", { count: picked.size })}
          </button>
          <button className="lib-suggestbtn" disabled={busy} onClick={() => void run("facePersonDecline")}>
            {t("faces.findDecline", { name })}
          </button>
        </div>
      )}
    </aside>
  );
}
