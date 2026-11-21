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

import { useEffect, useMemo, useState } from "react";
import { CloseIcon } from "./icons";
import { rpc } from "../lib/rpc";
import { useT } from "../lib/i18n";
import { errorText, type DateEditStatus } from "../lib/dateEdit";
import { describable, emptyFields, fieldsOf, stripChange, textChange, type MetaInfo, type StripChoice, type TextFields } from "../lib/metaEdit";
import "../styles/Library.css";
import "../styles/Settings.css";
import "../styles/DateEdit.css";

export type MetaKind = "text" | "strip";

const STRIP_GROUPS: { key: keyof StripChoice; label: string; hint: string }[] = [
  { key: "location", label: "metaEdit.stripLocation", hint: "metaEdit.stripLocationHint" },
  { key: "camera", label: "metaEdit.stripCamera", hint: "metaEdit.stripCameraHint" },
  { key: "text", label: "metaEdit.stripText", hint: "metaEdit.stripTextHint" },
];

/**
 * Sets or clears the description, author and copyright of the chosen photos, or removes private
 * metadata from them, by a copy each, as the date and place editors do. A side panel beside the
 * grid, or docked in the viewer, with the progress of the run after.
 */
export function MetaEditPanel({
  kind,
  uids,
  status,
  onStarted,
  onClose,
  top = 0,
  embedded = false,
}: {
  kind: MetaKind;
  uids: string[];
  status: DateEditStatus | null;
  onStarted: () => void;
  onClose: () => void;
  top?: number;
  /** Inside the viewer's docked side, which places it, rather than beside the grid. */
  embedded?: boolean;
}) {
  const t = useT();
  const single = uids.length === 1;
  const [info, setInfo] = useState<MetaInfo[] | null>(null);
  const [error, setError] = useState("");
  const [held, setHeld] = useState<TextFields>(emptyFields);
  const [typed, setTyped] = useState<TextFields>(emptyFields);
  const [strip, setStrip] = useState<StripChoice>({ location: true, camera: true, text: false });
  const [started, setStarted] = useState(false);

  useEffect(() => {
    let live = true;
    setInfo(null);
    void rpc<MetaInfo[]>("metaInfo", { uids, read: kind === "text" && single })
      .then((list) => {
        if (!live) return;
        setInfo(list);
        const fields = fieldsOf(list[0]);
        setHeld(fields);
        setTyped(fields);
      })
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uids.join(","), kind]);

  const change = useMemo(() => (kind === "text" ? textChange(single, held, typed) : stripChange(strip)), [kind, single, held, typed, strip]);
  const eligible = (info ?? []).filter((i) => !i.blocked);
  const ready = !!info && !!change && eligible.length > 0;

  async function start() {
    if (!ready || !change) return;
    setError("");
    try {
      await rpc("startDateEdit", { items: eligible.map((i) => ({ uid: i.uid, captureMs: 0, meta: change })) });
      setStarted(true);
      onStarted();
    } catch (e) {
      setError(String(e));
    }
  }

  const running = !!status?.running;
  const showRun = started || running;
  const title = t(kind === "text" ? "metaEdit.menuText" : "metaEdit.menuStrip");

  const field = (key: keyof TextFields, label: string, multiline = false) => (
    <label className="de-shift">
      <span>{label}</span>
      {multiline ? (
        <textarea
          className="de-input ta"
          value={typed[key]}
          placeholder={t("metaEdit.descriptionHint")}
          maxLength={8000}
          onChange={(e) => {
            const value = e.currentTarget.value;
            setTyped((f) => ({ ...f, [key]: value }));
          }}
        />
      ) : (
        <input
          className="de-input"
          type="text"
          value={typed[key]}
          placeholder={single ? undefined : t("metaEdit.keepOwn")}
          maxLength={500}
          onChange={(e) => {
            const value = e.currentTarget.value;
            setTyped((f) => ({ ...f, [key]: value }));
          }}
        />
      )}
    </label>
  );

  const startLabel =
    kind === "text"
      ? single
        ? t("metaEdit.save")
        : t("metaEdit.saveCount", { count: eligible.length })
      : single
        ? t("metaEdit.stripOne")
        : t("metaEdit.stripCount", { count: eligible.length });

  return (
    <aside className={embedded ? "de-panel de-embedded" : "lib-findpanel de-panel"} style={embedded ? undefined : { top }} aria-label={title}>
      <div className="lib-findhead">
        <h2 className="lib-findtitle">{title}</h2>
        <button className="lib-findclose" onClick={onClose} title={t("common.close")} aria-label={t("common.close")}>
          <CloseIcon size={18} />
        </button>
      </div>

      {showRun && status ? (
        <div className="lib-findsweep">
          <p className="lib-findnote">
            {running
              ? t("metaEdit.running", { done: status.done, total: status.total })
              : t("dateEdit.done", { changed: status.changed, failed: status.failed })}
          </p>
          <div className="lib-findbar">
            <div className="de-barfill" style={{ width: `${status.total > 0 ? (100 * status.done) / status.total : 0}%` }} />
          </div>
          {running && (
            <button className="lib-suggestbtn" onClick={() => void rpc("stopDateEdit").catch(() => {})}>
              {t("dateEdit.stop")}
            </button>
          )}
          {status.errors.length > 0 && (
            <ul className="de-errors">
              {status.errors.slice(-20).map((e, i) => (
                <li key={`${e.uid}-${i}`}>{errorText(e, t)}</li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="lib-findsweep">
          {kind === "text" ? (
            <>
              {!single && <p className="lib-findnote">{t("metaEdit.applies", { count: uids.length })}</p>}
              {single && field("description", t("metaEdit.description"), true)}
              {field("author", t("metaEdit.author"))}
              {field("copyright", t("metaEdit.copyright"))}
              <p className="lib-findnote">{t("metaEdit.textNote")}</p>
            </>
          ) : (
            <>
              <div className="me-checks">
                {STRIP_GROUPS.map((g) => (
                  <label key={g.key} className="me-check">
                    <input type="checkbox" checked={strip[g.key]} onChange={(e) => {
                      const on = e.currentTarget.checked;
                      setStrip((s) => ({ ...s, [g.key]: on }));
                    }} />
                    <span>
                      <b>{t(g.label)}</b>
                      <small>{t(g.hint)}</small>
                    </span>
                  </label>
                ))}
              </div>
              <p className="lib-findnote de-error">{t("metaEdit.irreversible")}</p>
              <p className="lib-findnote">{t("metaEdit.stripNote")}</p>
            </>
          )}
          <button className="de-start" disabled={!ready} onClick={() => void start()}>
            {startLabel}
          </button>
        </div>
      )}

      <div className="lib-findlist">
        {error && <p className="lib-findnote de-error">{error}</p>}
        {!info && !error && <p className="lib-findnote">{t("dateEdit.reading")}</p>}
        {info && (!single || info.some((i) => i.blocked)) && (
          <ul className="de-rows">
            {info.map((item) => (
              <li key={item.uid} className="de-row">
                <span className="de-name" title={item.name}>
                  {item.name || "?"}
                </span>
                {item.blocked && (
                  <span className="de-dates">
                    <span className="de-skip">{t(`metaEdit.${item.blocked}`)}</span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

/**
 * The description a photo's file holds, as a row of the viewer's details. Read from the file
 * only while the details are open, and only for a JPEG or PNG small enough to read whole;
 * nothing is shown for a photo without one, and a video is never downloaded for it.
 */
export function PhotoDescription({ uid, mediaType, size }: { uid: string; mediaType: string | null; size: number | null }) {
  const t = useT();
  const [text, setText] = useState<string | null>(null);
  const readable = describable(mediaType, size);
  useEffect(() => {
    let live = true;
    setText(null);
    if (!readable) return;
    void rpc<MetaInfo[]>("metaInfo", { uids: [uid], read: true })
      .then((list) => live && setText(list[0]?.text?.description ?? null))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [uid, readable]);
  if (!text) return null;
  return (
    <>
      <dt>{t("metaEdit.detailDescription")}</dt>
      <dd style={{ whiteSpace: "pre-wrap" }}>{text}</dd>
    </>
  );
}
