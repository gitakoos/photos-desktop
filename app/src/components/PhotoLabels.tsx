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
import { useT } from "../lib/i18n";
import type { LocalLabel } from "../hooks/useLocalLabels";
import { DetailsSection } from "./DetailsSections";
import { CloseIcon, PlusIcon } from "./icons";

/**
 * The labels on the photo in the viewer's details: each as a chip that takes it off, and a chip
 * that opens the label picker for this photo.
 */
export function PhotoLabels({
  photoKey,
  labels,
  act,
  onAdd,
}: {
  /** The photo's Drive link id, which is what labels are kept against. */
  photoKey: string;
  labels: LocalLabel[];
  act: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  onAdd: () => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const mine = useMemo(() => labels.filter((l) => l.keys.includes(photoKey)), [labels, photoKey]);

  async function remove(name: string) {
    if (busy) return;
    setBusy(true);
    try {
      await act("labelsRemove", { keys: [photoKey], labels: [name] });
    } catch {
      /* the label stays on the photo */
    } finally {
      setBusy(false);
    }
  }

  return (
    <DetailsSection id="labels" title={t("selection.labels")}>
      <div className="chips">
        {mine.map((l) => (
          <button
            key={l.name}
            className="chip"
            disabled={busy}
            onClick={() => void remove(l.name)}
            title={t("details.removeLabel", { name: l.name })}
            aria-label={t("details.removeLabel", { name: l.name })}
          >
            <span>{l.name}</span>
            <CloseIcon size={13} />
          </button>
        ))}
        <button className="chip add" onClick={onAdd}>
          <PlusIcon size={14} />
          {t("details.addLabel")}
        </button>
      </div>
      {mine.length === 0 && <div className="lbx-dim">{t("details.noLabels")}</div>}
    </DetailsSection>
  );
}
