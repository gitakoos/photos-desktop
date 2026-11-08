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
import { Confirm } from "./Confirm";
import { FaceNamer } from "./FaceNamer";
import { FaceCover } from "./Library";
import { useThumbnails } from "../hooks/useThumbnails";
import { rpc } from "../lib/rpc";
import { useT } from "../lib/i18n";
import type { PhotoFace } from "../lib/localFaces";

/**
 * The people on the photo in the viewer, in the details panel: each face found on it with who
 * it is, and a way to name it, change who it is, say it is not the person it is with, or leave it
 * out as not a person.
 */
export function PhotoFaces({
  uid,
  names,
  version,
  act,
}: {
  uid: string;
  /** Everyone already named. */
  names: string[];
  /** Goes up whenever the people change, so the faces are read again. */
  version: number;
  act: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
}) {
  const t = useT();
  const [faces, setFaces] = useState<{ uid: string; list: PhotoFace[] } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [notThis, setNotThis] = useState<PhotoFace | null>(null);
  const thumbs = useThumbnails(useMemo(() => [uid], [uid]));

  useEffect(() => {
    let live = true;
    rpc<PhotoFace[]>("facesOnPhoto", { uid }).then(
      (list) => live && setFaces({ uid, list }),
      () => live && setFaces({ uid, list: [] }),
    );
    return () => {
      live = false;
    };
  }, [uid, version]);

  useEffect(() => {
    setEditing(null);
    setNotThis(null);
  }, [uid]);

  const list = faces?.uid === uid ? faces.list : null;
  const thumb = thumbs[uid];

  return (
    <section className="lib-photofaces">
      <h4 className="lib-photofaces-title">{t("faces.inPhoto")}</h4>
      {list === null ? null : list.length === 0 ? (
        <p className="lib-findnote">{t("faces.inPhotoNone")}</p>
      ) : (
        <ul className="lib-photofaces-list">
          {list.map((face) => (
            <li key={face.faceId} className="lib-photoface">
              <div className="lib-photoface-row">
                <span className="lib-suggestface">
                  {thumb ? (
                    <span className="lib-facebox">
                      <FaceCover uid={uid} thumb={thumb} box={face.box} />
                    </span>
                  ) : null}
                </span>
                <span className={`lib-photoface-name${face.name ? "" : " dim"}`}>{face.name ?? t("faces.unnamed")}</span>
                {editing !== face.faceId && (
                  <button className="lib-suggestbtn" onClick={() => setEditing(face.faceId)}>
                    {t(face.name ? "faces.change" : "faces.name")}
                  </button>
                )}
              </div>
              {editing === face.faceId && (
                <FaceNamer
                  names={names}
                  initial={face.name ?? ""}
                  onName={async (name) => {
                    await act("faceNameFaces", { faceIds: [face.faceId], name });
                    setEditing(null);
                  }}
                  onReject={async () => {
                    await act("faceRejectFaces", { faceIds: [face.faceId] });
                    setEditing(null);
                  }}
                  onCancel={() => setEditing(null)}
                />
              )}
              {editing === face.faceId && face.name && face.personId && (
                <button className="lib-suggestbtn lib-photoface-notthis" onClick={() => setNotThis(face)}>
                  {t("faces.notThis", { name: face.name })}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {notThis?.name && (
        <Confirm
          title={t("faces.notThisTitle", { name: notThis.name })}
          message={t("faces.notThisMessage", { name: notThis.name })}
          confirmLabel={t("faces.notThisAction", { name: notThis.name })}
          danger
          onCancel={() => setNotThis(null)}
          onConfirm={() => {
            const faceId = notThis.faceId;
            setNotThis(null);
            setEditing(null);
            void act("faceNotThisPerson", { faceId }).catch(() => {});
          }}
        />
      )}
    </section>
  );
}
