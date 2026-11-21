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

/** What the sidecar tells the description and strip panels about a photo. */
export type MetaInfo = {
  uid: string;
  name: string;
  /** What its file holds, read for one photo only. */
  text: { description: string | null; copyright: string | null; author: string | null } | null;
  blocked: "live" | "type" | "read" | null;
};

/** The largest photo whose file the viewer reads for its description (the sidecar holds to the same). */
export const DESCRIPTION_READ_MAX_BYTES = 200 * 1024 * 1024;

/**
 * Whether the viewer reads a photo's file for its description: a JPEG or PNG, not larger than
 * the cap. A video, another type or an unknown size is never downloaded for it.
 */
export function describable(mediaType: string | null | undefined, size: number | null | undefined): boolean {
  const type = String(mediaType ?? "").toLowerCase().split(";")[0]!.trim();
  if (type !== "image/jpeg" && type !== "image/jpg" && type !== "image/png") return false;
  return typeof size === "number" && size > 0 && size <= DESCRIPTION_READ_MAX_BYTES;
}

/** The fields of the text panel. */
export type TextFields = { description: string; author: string; copyright: string };

export type TextChange = { kind: "text"; description?: string; author?: string; copyright?: string };

export type StripChoice = { location: boolean; camera: boolean; text: boolean };

export type StripChange = { kind: "strip" } & StripChoice;

export const emptyFields: TextFields = { description: "", author: "", copyright: "" };

/** The fields a single photo opens with: what its file holds. */
export function fieldsOf(info: MetaInfo | undefined): TextFields {
  return {
    description: info?.text?.description ?? "",
    author: info?.text?.author ?? "",
    copyright: info?.text?.copyright ?? "",
  };
}

/**
 * What to write for the fields as typed. One photo: each field that differs from what the file
 * held, an emptied one taking the field out. Several photos: each field with text, which is set
 * on all of them, and an empty one keeps each photo's own. Null when nothing is asked.
 */
export function textChange(single: boolean, held: TextFields, typed: TextFields): TextChange | null {
  const out: TextChange = { kind: "text" };
  for (const key of ["description", "author", "copyright"] as const) {
    const value = typed[key].trim();
    if (single ? value !== held[key].trim() : value !== "") out[key] = value;
  }
  // Several photos have no description field: one text for all of them is never what is wanted.
  if (!single) delete out.description;
  return out.description !== undefined || out.author !== undefined || out.copyright !== undefined ? out : null;
}

/** The strip request, or null when no group is ticked. */
export function stripChange(choice: StripChoice): StripChange | null {
  return choice.location || choice.camera || choice.text ? { kind: "strip", ...choice } : null;
}
