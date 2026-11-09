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

import type { ImportState } from "../hooks/useUploads";

/**
 * How far an export being made ready has got, from 0 to 1, or null when there is no
 * number to give. Downloading and unpacking a zip are measured. The steps after it report no count,
 * and a bar left at nothing while they run reads as a program that has stopped.
 */
export function importFraction(state: Pick<ImportState, "phase" | "done" | "total">): number | null {
  if ((state.phase !== "downloading" && state.phase !== "unpacking") || state.total <= 0) return null;
  return Math.min(state.done / state.total, 1);
}
