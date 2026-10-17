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

type Props = { label: string; done: number; failed: number; total: number };

/**
 * The save-to-folder readout shown inside the download toast: a count and the same
 * determinate bar the Settings free-up pass uses, so the user sees the originals
 * land one by one instead of a single summary at the end. Pure props, so it renders
 * the same wherever it is dropped in. A settled file counts toward the bar whether it
 * saved or failed, so the fill tracks true progress rather than only the successes.
 */
export function DownloadProgress({ label, done, failed, total }: Props) {
  const pct = total > 0 ? Math.round(((done + failed) / total) * 100) : 0;
  return (
    <div className="g-toast-save">
      <span>{label}</span>
      <div
        className="st-progress"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="st-progress-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
