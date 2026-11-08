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

import { useMemo, useState } from "react";
import { FaceIcon, PencilIcon } from "./icons";
import { useT } from "../lib/i18n";
import { personNameKey } from "../lib/personName";

/** Name compare for the suggestions, case and accents aside. */
const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase().trim();

/**
 * "Who is this?" for one face or a few: a name typed, or one of the people already named picked
 * from the list under the field, and Save. Picking a name puts the faces with that person; a new
 * name makes a new one.
 */
export function FaceNamer({
  names,
  initial = "",
  onName,
  onReject,
  onCancel,
}: {
  /** Everyone already named. */
  names: string[];
  initial?: string;
  onName: (name: string) => Promise<void>;
  onReject?: () => Promise<void>;
  onCancel?: () => void;
}) {
  const t = useT();
  const [text, setText] = useState(initial);
  const [picked, setPicked] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [focused, setFocused] = useState(false);

  const suggestions = useMemo(() => {
    const q = fold(text);
    if (!q) return [];
    // The name typed is not offered back; one that differs only by its accents is someone else, so it is.
    return names.filter((n) => fold(n).includes(q) && personNameKey(n) !== personNameKey(text)).slice(0, 6);
  }, [text, names]);

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
      setText("");
    } catch {
      /* stays for another try */
    } finally {
      setBusy(false);
    }
  };
  const save = (value: string) => {
    if (value.trim()) void run(() => onName(value.trim()));
  };

  return (
    <div className="lib-namer">
      <div className="g-strip-search lib-namerfield">
        <PencilIcon size={15} />
        <input
          className="g-searchfield"
          autoFocus
          value={text}
          maxLength={100}
          placeholder={t("faces.namePlaceholder")}
          disabled={busy}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => {
            setText(e.currentTarget.value);
            setPicked(-1);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              onCancel?.();
            } else if (e.key === "Enter") {
              e.preventDefault();
              save(picked >= 0 ? suggestions[picked] : text);
            } else if (e.key === "ArrowDown" && suggestions.length) {
              e.preventDefault();
              setPicked((i) => (i + 1) % suggestions.length);
            } else if (e.key === "ArrowUp" && suggestions.length) {
              e.preventDefault();
              setPicked((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
            }
          }}
        />
        {focused && suggestions.length > 0 && (
          <div className="g-strip-suggest" role="listbox">
            {suggestions.map((s, i) => (
              <button
                key={s}
                className={`g-strip-option${i === picked ? " on" : ""}`}
                role="option"
                aria-selected={i === picked}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => save(s)}
              >
                <span className="g-strip-optico">
                  <FaceIcon size={16} />
                </span>
                <span className="g-strip-optlabel">{s}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <button className="lib-suggestbtn primary" disabled={busy || !text.trim()} onClick={() => save(text)}>
        {t("faces.save")}
      </button>
      {onReject && (
        <button className="lib-suggestbtn" disabled={busy} onClick={() => void run(onReject)}>
          {t("faces.notPerson")}
        </button>
      )}
      {onCancel && (
        <button className="lib-suggestbtn" disabled={busy} onClick={onCancel}>
          {t("common.cancel")}
        </button>
      )}
    </div>
  );
}
