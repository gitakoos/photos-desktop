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

/**
 * Shared icons, matching the Android app one for one.
 *
 * Every glyph below is the filled Material icon that the Android app draws for the
 * same job, on the same 24x24 viewport, so the two clients read as one product.
 * Filled means weight comes from the shape itself: no stroke to drift out of step
 * between sizes, and `currentColor` fills it.
 *
 * Path geometry: Material Icons by Google, Apache License 2.0. The name above each
 * icon is the Compose symbol the Android side uses.
 *
 * The three photo-type marks are the exception, and say so individually: Android draws
 * Proton Core's own glyphs for those, on a 16x16 viewport, so they are copied across as
 * they are rather than swapped for the nearest Material shape.
 */

type Props = { size?: number };

/** A circled i, outlined. */
export function InfoIcon({ size = 17 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h0.01" />
    </svg>
  );
}

/** The lidded bin, the outline the sidebar's trash draws, for every destructive action. */
export function TrashIcon({ size = 17 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1 -2 2H7a2 2 0 0 1 -2 -2V6m3 0V4a2 2 0 0 1 2 -2h4a2 2 0 0 1 2 2v2" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

/** A pencil outline — the thing it sits next to is editable. */
export function PencilIcon({ size = 15 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5 -5.5L17 3z" />
      <path d="M15 5l4 4" />
    </svg>
  );
}

/** Favorite mark: a stroked heart when off, a solid one once the tag is set. The solid
    is what the grid cell badges too, so that stays filled while the toggle outlines. */
export function HeartIcon({ size = 17, filled = false }: Props & { filled?: boolean }) {
  if (filled) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M12 21.35l-1.45 -1.32C5.4 15.36 2 12.28 2 8.5C2 5.42 4.42 3 7.5 3c1.74 0 3.41 0.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3C19.58 3 22 5.42 22 8.5c0 3.78 -3.4 6.86 -8.55 11.54L12 21.35Z" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M19 14c1.49 -1.46 3 -3.21 3 -5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0 -3 0.5 -4.5 2 -1.5 -1.5 -2.74 -2 -4.5 -2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
    </svg>
  );
}

/** Icons.AutoMirrored.Filled.OpenInNew — the row it sits on opens in the browser. */
export function OpenInNewIcon({ size = 15 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M19 19H5V5h7V3H5c-1.11 0 -2 0.9 -2 2v14c0 1.1 0.89 2 2 2h14c1.1 0 2 -0.9 2 -2v-7h-2v7ZM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7Z" />
    </svg>
  );
}

/** Icons.Filled.Close */
export function CloseIcon({ size = 16 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M19 6.41L17.59 5L12 10.59L6.41 5L5 6.41L10.59 12L5 17.59L6.41 19L12 13.41L17.59 19L19 17.59L13.41 12Z" />
    </svg>
  );
}

/** A list, outlined: everything the viewer can open, as a list. */
export function ListIcon({ size = 17 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M8 6h13M8 12h13M8 18h13" />
      <path d="M3 6h0.01M3 12h0.01M3 18h0.01" />
    </svg>
  );
}

/** Icons.Filled.PhotoLibrary — the Albums destination. */
export function CollectionsIcon({ size = 17 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M22 16V4c0 -1.1 -0.9 -2 -2 -2H8c-1.1 0 -2 0.9 -2 2v12c0 1.1 0.9 2 2 2h12c1.1 0 2 -0.9 2 -2ZM11 12l2.03 2.71L16 11l4 5H8l3 -4ZM2 6v14c0 1.1 0.9 2 2 2h14v-2H4V6H2Z" />
    </svg>
  );
}

/** Icons.Filled.Menu — collapses and expands the sidebar. */
export function MenuIcon({ size = 18 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M3 18h18v-2H3v2ZM3 13h18v-2H3v2ZM3 6v2h18V6H3Z" />
    </svg>
  );
}

/** Icons.Filled.ChevronLeft */
export function ChevronLeftIcon({ size = 16 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M15.41 7.41L14 6l-6 6l6 6l1.41 -1.41L10.83 12Z" />
    </svg>
  );
}

/** A double chevron, the collapse control on the sidebar head. Points left to fold the
    rail away; the sidebar rotates it 180° when collapsed so it points back out. */
export function ChevronsLeftIcon({ size = 16 }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M11 7l-5 5l5 5" />
      <path d="M18 7l-5 5l5 5" />
    </svg>
  );
}

/** A three-quarter ring, spun by CSS to mark background work (indexing, syncing). */
export function SpinnerIcon({ size = 16 }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M12 3a9 9 0 1 0 9 9" />
    </svg>
  );
}

/** A pushpin, filled once an album is pinned to the top of the sidebar list. */
export function PinIcon({ size = 14, filled = false }: { size?: number; filled?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1 -1.11 1.79l-1.78 0.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1 -1v-0.76a2 2 0 0 0 -1.11 -1.79l-1.78 -0.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1 -1a2 2 0 0 0 0 -4H8a2 2 0 0 0 0 4a1 1 0 0 1 1 1z" />
    </svg>
  );
}

/** A gear, outlined. */
export function GearIcon({ size = 14 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12.22 2h-0.44a2 2 0 0 0 -2 2v0.18a2 2 0 0 1 -1 1.73l-0.43 0.25a2 2 0 0 1 -2 0l-0.15 -0.08a2 2 0 0 0 -2.73 0.73l-0.22 0.38a2 2 0 0 0 0.73 2.73l0.15 0.1a2 2 0 0 1 1 1.72v0.51a2 2 0 0 1 -1 1.74l-0.15 0.09a2 2 0 0 0 -0.73 2.73l0.22 0.38a2 2 0 0 0 2.73 0.73l0.15 -0.08a2 2 0 0 1 2 0l0.43 0.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h0.44a2 2 0 0 0 2 -2v-0.18a2 2 0 0 1 1 -1.73l0.43 -0.25a2 2 0 0 1 2 0l0.15 0.08a2 2 0 0 0 2.73 -0.73l0.22 -0.39a2 2 0 0 0 -0.73 -2.73l-0.15 -0.08a2 2 0 0 1 -1 -1.74v-0.5a2 2 0 0 1 1 -1.74l0.15 -0.09a2 2 0 0 0 0.73 -2.73l-0.22 -0.38a2 2 0 0 0 -2.73 -0.73l-0.15 0.08a2 2 0 0 1 -2 0l-0.43 -0.25a2 2 0 0 1 -1 -1.73V4a2 2 0 0 0 -2 -2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

/** Leaving: a door with an arrow out, outlined. */
export function SignOutIcon({ size = 15 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 21H5a2 2 0 0 1 -2 -2V5a2 2 0 0 1 2 -2h4" />
      <path d="M16 17l5 -5 -5 -5" />
      <path d="M21 12H9" />
    </svg>
  );
}

/** External-link, outlined: "open the main window". */
export function OpenWindowIcon({ size = 16 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M15 3h6v6" />
      <path d="M10 14L21 3" />
      <path d="M18 13v6a2 2 0 0 1 -2 2H5a2 2 0 0 1 -2 -2V8a2 2 0 0 1 2 -2h6" />
    </svg>
  );
}

/** A padlock, outlined: the account is locked until the password is re-entered. */
export function LockIcon({ size = 16 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

/**
 * Icons.Filled.PowerSettingsNew — quit the app. Android has no quit, so there is no
 * counterpart to match; taking it from the same Material set keeps it in step anyway.
 */
export function PowerIcon({ size = 16 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 2v10" />
      <path d="M18.4 6.6a9 9 0 1 1 -12.77 0.04" />
    </svg>
  );
}

/** An open folder, outlined: where a photo's copy on this computer is shown. */
export function FolderOpenIcon({ size = 15 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 19l2.757 -7.351a1 1 0 0 1 .936 -.649h12.307a1 1 0 0 1 .986 1.164l-.996 5.211a2 2 0 0 1 -1.964 1.625h-14.026a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2h4l3 3h7a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

/** The one upload mark, outlined: an arrow rising out of a tray, the download's mirror. */
export function UploadArrowIcon({ size = 15 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 15v4a2 2 0 0 1 -2 2H5a2 2 0 0 1 -2 -2v-4" />
      <path d="M17 8l-5 -5 -5 5" />
      <path d="M12 3v12" />
    </svg>
  );
}

/** The download mark, outlined: an arrow dropping into a tray. */
export function DownloadIcon({ size = 17 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 15v4a2 2 0 0 1 -2 2H5a2 2 0 0 1 -2 -2v-4" />
      <path d="M7 10l5 5 5 -5" />
      <path d="M12 15V3" />
    </svg>
  );
}

/** A cloud — the photo lives in Drive. Solid as a grid-cell badge, outlined as a
    menu or toolbar action, so it sits with whichever set surrounds it. */
export function CloudIcon({ size = 17, filled = false }: Props & { filled?: boolean }) {
  if (filled) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4C9.11 4 6.6 5.64 5.35 8.04C2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5 -2.24 5 -5c0 -2.64 -2.05 -4.78 -4.65 -4.96Z" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M17.5 19H9a7 7 0 1 1 6.71 -9h1.79a4.5 4.5 0 1 1 0 9Z" />
    </svg>
  );
}

/**
 * Icons.Filled.OfflinePin — the app's own copy of the photo, kept for offline use.
 * Deliberately not the cloud: that one marks the File Explorer copy, and the two are
 * different places a photo can be kept.
 */
export function OfflinePinIcon({ size = 17, filled = false }: Props & { filled?: boolean }) {
  if (filled) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M12 2C6.48 2 2 6.48 2 12S6.48 22 12 22S22 17.52 22 12S17.52 2 12 2ZM17 18H7v-2h10v2ZM10.3 14L7 10.7L8.41 9.29L10.3 11.18L15.6 5.88L17 7.3L10.3 14Z" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <path d="M9 12l2 2 4 -4" />
    </svg>
  );
}

/**
 * Icons.Filled.Image — set the selected photo as the album's cover.
 *
 * The four below exist because the selection bar names its actions with a glyph
 * once the labels drop away, and these four had none to drop to. Deleting for good
 * needed its own shape most of all: it shared the plain bin with trashing, and two
 * different endings behind one mark is the one place that must not happen.
 */
export function ImageIcon({ size = 17 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="M21 15l-3.09 -3.09a2 2 0 0 0 -2.82 0L6 21" />
    </svg>
  );
}

/** An eraser: give the device copy back, keeping the photo in Drive. */
export function SweepIcon({ size = 17 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M7 21l-4.3 -4.3c-1 -1 -1 -2.5 0 -3.4l9.6 -9.6c1 -1 2.5 -1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" />
      <path d="M22 21H7" />
      <path d="M5 11l9 9" />
    </svg>
  );
}

/** The bin with an X: deleting for good, told apart from the plain trash. */
export function DeleteForeverIcon({ size = 17 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1 -2 2H7a2 2 0 0 1 -2 -2V6m3 0V4a2 2 0 0 1 2 -2h4a2 2 0 0 1 2 2v2" />
      <path d="M10 11l4 6M14 11l-4 6" />
    </svg>
  );
}

/** Icons.Filled.MoreHoriz — what did not fit on the row is behind this. */
export function MoreHorizIcon({ size = 17 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M6 10c-1.1 0 -2 0.9 -2 2s0.9 2 2 2s2 -0.9 2 -2s-0.9 -2 -2 -2Zm12 0c-1.1 0 -2 0.9 -2 2s0.9 2 2 2s2 -0.9 2 -2s-0.9 -2 -2 -2Zm-6 0c-1.1 0 -2 0.9 -2 2s0.9 2 2 2s2 -0.9 2 -2s-0.9 -2 -2 -2Z" />
    </svg>
  );
}

/** Icons.Filled.Check */
export function CheckIcon({ size = 12 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M9 16.17L4.83 12l-1.42 1.41L9 19L21 7l-1.41 -1.41Z" />
    </svg>
  );
}

/** A magnifier, outlined. */
export function SearchIcon({ size = 16 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="11" cy="11" r="8" />
      <path d="M21 21l-4.3 -4.3" />
    </svg>
  );
}

/** Icons.Filled.PlayArrow — the video badge on a cell. */
export function PlayArrowIcon({ size = 16 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M8 5v14l11 -7Z" />
    </svg>
  );
}

/**
 * The motion-photo mark. Not Material: Android draws Proton Core's own glyph here, so
 * this is that same artwork rather than a lookalike. Its outer ring is a run of dots,
 * which is what gives it the "there is movement in this one" read at badge size.
 *
 * Path geometry: Proton Core icons, Copyright (c) Proton AG, licensed under GPL-3.0.
 */
export function MotionPhotoIcon({ size = 11 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8,0.703C8.197,0.703 8.349,0.551 8.349,0.349C8.349,0.152 8.197,0 8,0C7.803,0 7.646,0.152 7.646,0.349C7.646,0.551 7.803,0.703 8,0.703ZM9.332,0.821C9.529,0.821 9.681,0.669 9.681,0.472C9.681,0.276 9.529,0.118 9.332,0.118C9.136,0.118 8.978,0.276 8.978,0.472C8.978,0.669 9.136,0.821 9.332,0.821ZM10.614,1.164C10.811,1.164 10.968,1.012 10.968,0.815C10.968,0.619 10.811,0.461 10.614,0.461C10.417,0.461 10.266,0.619 10.266,0.815C10.266,1.012 10.417,1.164 10.614,1.164ZM11.828,1.738C12.025,1.738 12.177,1.586 12.177,1.389C12.177,1.192 12.025,1.035 11.828,1.035C11.632,1.035 11.474,1.192 11.474,1.389C11.474,1.586 11.632,1.738 11.828,1.738ZM12.919,2.503C13.116,2.503 13.273,2.345 13.273,2.148C13.273,1.951 13.116,1.8 12.919,1.8C12.722,1.8 12.565,1.951 12.565,2.148C12.565,2.345 12.722,2.503 12.919,2.503ZM13.864,3.442C14.06,3.442 14.218,3.29 14.218,3.093C14.218,2.896 14.06,2.739 13.864,2.739C13.667,2.739 13.515,2.896 13.515,3.093C13.515,3.29 13.667,3.442 13.864,3.442ZM14.628,4.538C14.825,4.538 14.982,4.387 14.982,4.19C14.982,3.993 14.825,3.836 14.628,3.836C14.432,3.836 14.28,3.993 14.28,4.19C14.28,4.387 14.432,4.538 14.628,4.538ZM15.19,5.748C15.387,5.748 15.545,5.59 15.545,5.393C15.545,5.196 15.387,5.045 15.19,5.045C14.994,5.045 14.836,5.196 14.836,5.393C14.836,5.59 14.994,5.748 15.19,5.748ZM15.533,7.03C15.73,7.03 15.887,6.878 15.887,6.676C15.887,6.479 15.73,6.327 15.533,6.327C15.337,6.327 15.179,6.479 15.179,6.676C15.179,6.878 15.337,7.03 15.533,7.03ZM15.646,8.346C15.843,8.346 16,8.194 16,7.997C16,7.8 15.843,7.643 15.646,7.643C15.449,7.643 15.297,7.8 15.297,7.997C15.297,8.194 15.449,8.346 15.646,8.346ZM15.533,9.662C15.73,9.662 15.887,9.51 15.887,9.313C15.887,9.116 15.73,8.959 15.533,8.959C15.337,8.959 15.179,9.116 15.179,9.313C15.179,9.51 15.337,9.662 15.533,9.662ZM15.19,10.95C15.387,10.95 15.545,10.792 15.545,10.595C15.545,10.399 15.387,10.241 15.19,10.241C14.994,10.241 14.836,10.399 14.836,10.595C14.836,10.792 14.994,10.95 15.19,10.95ZM14.628,12.153C14.825,12.153 14.982,12.001 14.982,11.799C14.982,11.602 14.825,11.45 14.628,11.45C14.432,11.45 14.28,11.602 14.28,11.799C14.28,12.001 14.432,12.153 14.628,12.153ZM13.864,13.25C14.06,13.25 14.218,13.098 14.218,12.901C14.218,12.699 14.06,12.547 13.864,12.547C13.667,12.547 13.515,12.699 13.515,12.901C13.515,13.098 13.667,13.25 13.864,13.25ZM12.919,14.195C13.116,14.195 13.273,14.037 13.273,13.84C13.273,13.644 13.116,13.492 12.919,13.492C12.722,13.492 12.565,13.644 12.565,13.84C12.565,14.037 12.722,14.195 12.919,14.195ZM11.828,14.954C12.025,14.954 12.177,14.802 12.177,14.605C12.177,14.408 12.025,14.251 11.828,14.251C11.632,14.251 11.474,14.408 11.474,14.605C11.474,14.802 11.632,14.954 11.828,14.954ZM10.614,15.528C10.811,15.528 10.968,15.376 10.968,15.179C10.968,14.976 10.811,14.825 10.614,14.825C10.417,14.825 10.266,14.976 10.266,15.179C10.266,15.376 10.417,15.528 10.614,15.528ZM9.332,15.871C9.529,15.871 9.681,15.719 9.681,15.522C9.681,15.319 9.529,15.168 9.332,15.168C9.136,15.168 8.978,15.319 8.978,15.522C8.978,15.719 9.136,15.871 9.332,15.871ZM8,15.989C8.197,15.989 8.349,15.837 8.349,15.64C8.349,15.443 8.197,15.286 8,15.286C7.803,15.286 7.646,15.443 7.646,15.64C7.646,15.837 7.803,15.989 8,15.989ZM6.668,15.871C6.864,15.871 7.016,15.719 7.016,15.522C7.016,15.319 6.864,15.168 6.668,15.168C6.471,15.168 6.313,15.319 6.313,15.522C6.313,15.719 6.471,15.871 6.668,15.871ZM5.38,15.528C5.577,15.528 5.734,15.376 5.734,15.179C5.734,14.976 5.577,14.825 5.38,14.825C5.183,14.825 5.032,14.976 5.032,15.179C5.032,15.376 5.183,15.528 5.38,15.528ZM4.171,14.954C4.368,14.954 4.52,14.802 4.52,14.605C4.52,14.408 4.368,14.251 4.171,14.251C3.975,14.251 3.817,14.408 3.817,14.605C3.817,14.802 3.975,14.954 4.171,14.954ZM3.081,14.195C3.278,14.195 3.429,14.037 3.429,13.84C3.429,13.644 3.278,13.492 3.081,13.492C2.884,13.492 2.727,13.644 2.727,13.84C2.727,14.037 2.884,14.195 3.081,14.195ZM2.131,13.25C2.327,13.25 2.485,13.098 2.485,12.901C2.485,12.699 2.327,12.547 2.131,12.547C1.934,12.547 1.782,12.699 1.782,12.901C1.782,13.098 1.934,13.25 2.131,13.25ZM1.366,12.153C1.569,12.153 1.72,12.001 1.72,11.799C1.72,11.602 1.569,11.45 1.366,11.45C1.169,11.45 1.018,11.602 1.018,11.799C1.018,12.001 1.169,12.153 1.366,12.153ZM0.81,10.95C1.006,10.95 1.158,10.792 1.158,10.595C1.158,10.399 1.006,10.241 0.81,10.241C0.613,10.241 0.455,10.399 0.455,10.595C0.455,10.792 0.613,10.95 0.81,10.95ZM0.467,9.662C0.663,9.662 0.815,9.51 0.815,9.313C0.815,9.116 0.663,8.959 0.467,8.959C0.27,8.959 0.112,9.116 0.112,9.313C0.112,9.51 0.27,9.662 0.467,9.662ZM0.354,8.346C0.551,8.346 0.703,8.194 0.703,7.997C0.703,7.8 0.551,7.643 0.354,7.643C0.152,7.643 0,7.8 0,7.997C0,8.194 0.152,8.346 0.354,8.346ZM0.467,7.03C0.663,7.03 0.815,6.878 0.815,6.676C0.815,6.479 0.663,6.327 0.467,6.327C0.27,6.327 0.112,6.479 0.112,6.676C0.112,6.878 0.27,7.03 0.467,7.03ZM0.81,5.748C1.006,5.748 1.158,5.59 1.158,5.393C1.158,5.196 1.006,5.045 0.81,5.045C0.613,5.045 0.455,5.196 0.455,5.393C0.455,5.59 0.613,5.748 0.81,5.748ZM1.366,4.538C1.569,4.538 1.72,4.387 1.72,4.19C1.72,3.993 1.569,3.836 1.366,3.836C1.169,3.836 1.018,3.993 1.018,4.19C1.018,4.387 1.169,4.538 1.366,4.538ZM2.131,3.442C2.327,3.442 2.485,3.29 2.485,3.093C2.485,2.896 2.327,2.739 2.131,2.739C1.934,2.739 1.782,2.896 1.782,3.093C1.782,3.29 1.934,3.442 2.131,3.442ZM3.081,2.503C3.278,2.503 3.429,2.345 3.429,2.148C3.429,1.951 3.278,1.8 3.081,1.8C2.884,1.8 2.727,1.951 2.727,2.148C2.727,2.345 2.884,2.503 3.081,2.503ZM4.171,1.738C4.368,1.738 4.52,1.586 4.52,1.389C4.52,1.192 4.368,1.035 4.171,1.035C3.975,1.035 3.817,1.192 3.817,1.389C3.817,1.586 3.975,1.738 4.171,1.738ZM5.38,1.164C5.577,1.164 5.734,1.012 5.734,0.815C5.734,0.619 5.577,0.461 5.38,0.461C5.183,0.461 5.032,0.619 5.032,0.815C5.032,1.012 5.183,1.164 5.38,1.164ZM6.668,0.821C6.864,0.821 7.016,0.669 7.016,0.472C7.016,0.276 6.864,0.118 6.668,0.118C6.471,0.118 6.313,0.276 6.313,0.472C6.313,0.669 6.471,0.821 6.668,0.821Z" />
      <path d="M8,13.79C11.199,13.79 13.791,11.208 13.791,7.997C13.791,4.808 11.188,2.205 8,2.205C4.779,2.205 2.209,4.792 2.209,7.997C2.209,11.22 4.773,13.79 8,13.79ZM8,13.143C5.127,13.143 2.85,10.865 2.85,7.997C2.85,5.14 5.15,2.846 8,2.846C10.839,2.846 13.15,5.157 13.15,7.997C13.15,10.849 10.85,13.143 8,13.143Z" />
      <path d="M8,10.899C9.602,10.899 10.89,9.611 10.89,8.008C10.89,6.406 9.597,5.112 8,5.112C6.398,5.112 5.105,6.406 5.105,8.008C5.105,9.617 6.392,10.899 8,10.899ZM8,9.701C7.056,9.701 6.308,8.948 6.308,8.008C6.308,7.069 7.061,6.316 8,6.316C8.928,6.316 9.692,7.075 9.692,8.008C9.692,8.942 8.933,9.701 8,9.701Z" />
    </svg>
  );
}

/**
 * The panorama mark — a wide frame curved the way a swept shot is.
 *
 * Path geometry: Proton Core icons, Copyright (c) Proton AG, licensed under GPL-3.0.
 */
export function PanoramaIcon({ size = 11 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path fillRule="evenodd" d="M1.717,4.223C1.717,4.223 1.717,4.223 1.718,4.223C1.718,4.223 1.717,4.223 1.717,4.223ZM2,4.337C3.854,5.087 5.88,5.5 8,5.5C10.12,5.5 12.146,5.087 14,4.337V11.663C12.146,10.913 10.12,10.5 8,10.5C5.88,10.5 3.854,10.913 2,11.663V4.337ZM14.283,11.777C14.283,11.777 14.282,11.777 14.282,11.777C14.282,11.777 14.283,11.777 14.283,11.777ZM1.013,3.773C1.004,3.848 1,3.923 1,3.999V11.999C1,12.076 1.004,12.152 1.013,12.227C1.071,12.736 1.658,12.893 2.129,12.692C3.932,11.924 5.917,11.5 8,11.5C10.083,11.5 12.068,11.924 13.871,12.692C14.342,12.893 14.929,12.736 14.987,12.227C14.996,12.152 15,12.076 15,11.999V3.999C15,3.923 14.996,3.848 14.987,3.773C14.93,3.264 14.343,3.107 13.871,3.308C12.068,4.075 10.083,4.5 8,4.5C5.917,4.5 3.932,4.075 2.129,3.308C1.657,3.107 1.07,3.264 1.013,3.773Z" />
    </svg>
  );
}

/**
 * The RAW mark — a page with an R on it, for a photo still carrying sensor data.
 *
 * Path geometry: Proton Core icons, Copyright (c) Proton AG, licensed under GPL-3.0.
 */
export function RawIcon({ size = 11 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path fillRule="evenodd" d="M6.887,11.549V9.335H7.463L9.612,11.872C9.79,12.083 10.106,12.109 10.316,11.93C10.527,11.752 10.553,11.436 10.375,11.226L8.671,9.213C8.813,9.172 8.955,9.119 9.092,9.052C9.606,8.799 10.076,8.314 10.076,7.518C10.076,6.726 9.61,6.234 9.102,5.968C8.618,5.715 8.061,5.642 7.693,5.645H6.387C6.111,5.645 5.887,5.869 5.887,6.145V11.549C5.887,11.825 6.111,12.049 6.387,12.049C6.663,12.049 6.887,11.825 6.887,11.549ZM7.7,6.645C7.959,6.642 8.341,6.699 8.639,6.855C8.915,6.999 9.076,7.197 9.076,7.518C9.076,7.836 8.92,8.022 8.65,8.155C8.355,8.3 7.974,8.346 7.715,8.335L7.705,8.335H6.887V6.645L7.695,6.645L7.7,6.645Z" />
      <path fillRule="evenodd" d="M4,1C2.895,1 2,1.895 2,3V13C2,14.105 2.895,15 4,15H12C13.105,15 14,14.105 14,13V5.828C14,5.298 13.789,4.789 13.414,4.414L10.586,1.586C10.211,1.211 9.702,1 9.172,1H4ZM13,13V6H10.5C9.672,6 9,5.328 9,4.5V2H4C3.448,2 3,2.448 3,3V13C3,13.552 3.448,14 4,14H12C12.552,14 13,13.552 13,13ZM10,2.414L12.586,5H10.5C10.224,5 10,4.776 10,4.5V2.414Z" />
    </svg>
  );
}

/** A funnel, outlined. */
export function FilterIcon({ size = 14 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" />
    </svg>
  );
}

/** A clockwise arrow loop, outlined: refresh, and the restore-from-trash action. */
export function RefreshIcon({ size = 16 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 12a9 9 0 1 1 -3 -6.7L21 8" />
      <path d="M21 3v5h-5" />
    </svg>
  );
}

/** The three-node share mark, outlined. */
export function ShareIcon({ size = 17 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <path d="M8.59 13.51l6.83 3.98M15.41 6.51l-6.82 3.98" />
    </svg>
  );
}

/**
 * Icons.Filled.LibraryAdd. No Android counterpart: that client puts a photo in an
 * album from a picker screen rather than a menu, so there is no glyph to mirror.
 * The Material symbol for the job keeps it in step with the rest of the set.
 */
export function LibraryAddIcon({ size = 17 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0 -2 -0.9 -2 -2V4c0 -1.1 0.9 -2 2 -2h10c1.1 0 2 0.9 2 2" />
      <path d="M15 12v6M12 15h6" />
    </svg>
  );
}

/** The same stacked-frames mark as LibraryAdd, taking away. */
export function LibraryRemoveIcon({ size = 17 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0 -2 -0.9 -2 -2V4c0 -1.1 0.9 -2 2 -2h10c1.1 0 2 0.9 2 2" />
      <path d="M12 15h6" />
    </svg>
  );
}

/** An arrow pointing down at you, outlined: sharing that points at you. */
export function CallReceivedIcon({ size = 14 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M17 7L7 17" />
      <path d="M17 17H7V7" />
    </svg>
  );
}

/** An arrow pointing up and away, outlined: sharing that points away from you. */
export function CallMadeIcon({ size = 14 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M7 17L17 7" />
      <path d="M7 7h10v10" />
    </svg>
  );
}

/** Two arrows swapping, outlined: the mark on a pill that turns round when clicked. */
export function SwapHorizIcon({ size = 14 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M8 3L4 7l4 4" />
      <path d="M4 7h16" />
      <path d="M16 21l4 -4 -4 -4" />
      <path d="M20 17H4" />
    </svg>
  );
}

/** A person with a plus, outlined. */
export function PersonAddIcon({ size = 16 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M16 21v-2a4 4 0 0 0 -4 -4H6a4 4 0 0 0 -4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M19 8v6M22 11h-6" />
    </svg>
  );
}

/*
 * The left navigation's own marks. Unlike the filled Material set above, these are drawn
 * as light, even outlines on the same 24x24 grid, so the sidebar rail reads the way the
 * Proton Drive desktop one does rather than as a row of solid glyphs. They live only in
 * the navigation; every badge and menu keeps the filled shape it shares with Android.
 */

/** The timeline. */
export function NavPhotosIcon({ size = 20 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="3.2" />
      <circle cx="8.5" cy="8.5" r="1.6" />
      <path d="M21 15l-5 -5L5 21" />
    </svg>
  );
}

/** Albums: a photo card with another behind it. */
export function NavAlbumsIcon({ size = 20 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="8" width="13" height="13" rx="2.6" />
      <path d="M7 8V6a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-2" />
      <path d="M3.6 17.4l3 -2.5 2.5 2 3.4 -3" />
    </svg>
  );
}

/** Shared: the link mark Proton Drive uses for shared links. */
export function NavSharedIcon({ size = 20 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10 13a5 5 0 0 0 7.54 0.54l3 -3a5 5 0 0 0 -7.07 -7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0 -7.54 -0.54l-3 3a5 5 0 0 0 7.07 7.07l1.71 -1.71" />
    </svg>
  );
}

/** Trash: the lidded bin Proton Drive uses, two marks on the body. */
export function NavTrashIcon({ size = 20 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1 -2 2H7a2 2 0 0 1 -2 -2V6m3 0V4a2 2 0 0 1 2 -2h4a2 2 0 0 1 2 2v2" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

/** A plain plus, for the "new" affordances in the sidebar. */
export function PlusIcon({ size = 16 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

/*
 * The video controls, which draw the same marks the Android viewer's control pill
 * does. PlayArrow is above already, shared with the badge a video cell carries.
 */

/** Icons.Filled.Pause */
export function PauseIcon({ size = 18 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M6 19h4V5H6v14ZM14 5v14h4V5h-4Z" />
    </svg>
  );
}

/**
 * Icons.Filled.ChevronRight, the mirror of the left one above. Android steps a paused
 * clip a frame at a time with KeyboardArrowLeft and KeyboardArrowRight, which are this
 * same chevron in the filled set, so the pair here draws both jobs.
 */
export function ChevronRightIcon({ size = 16 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M10 6L8.59 7.41L13.17 12l-4.58 4.59L10 18l6 -6Z" />
    </svg>
  );
}

/** Icons.AutoMirrored.Filled.VolumeUp */
export function VolumeUpIcon({ size = 17 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M3 9v6h4l5 5V4L7 9H3ZM16.5 12c0 -1.77 -1.02 -3.29 -2.5 -4.03v8.05c1.48 -0.73 2.5 -2.25 2.5 -4.02ZM14 3.23v2.06c2.89 0.86 5 3.54 5 6.71s-2.11 5.85 -5 6.71v2.06c4.01 -0.91 7 -4.49 7 -8.77s-2.99 -7.86 -7 -8.77Z" />
    </svg>
  );
}

/** Icons.AutoMirrored.Filled.VolumeOff */
export function VolumeOffIcon({ size = 17 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M16.5 12c0 -1.77 -1.02 -3.29 -2.5 -4.03v2.21l2.45 2.45c0.03 -0.2 0.05 -0.41 0.05 -0.63ZM19 12c0 0.94 -0.2 1.82 -0.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0 -4.28 -2.99 -7.86 -7 -8.77v2.06c2.89 0.86 5 3.54 5 6.71ZM4.27 3L3 4.27L7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-0.67 0.52 -1.42 0.93 -2.25 1.18v2.06c1.38 -0.31 2.63 -0.95 3.69 -1.81L19.73 21L21 19.73L12 10.73L4.27 3ZM12 4L9.91 6.09L12 8.18V4Z" />
    </svg>
  );
}

/*
 * The photo editor's tool marks, each the Material symbol the Android editor draws for
 * the same tool, on the same 24x24 viewport as the rest of the set.
 */

/** Icons.Filled.Tune: the adjustment sliders. */
export function TuneIcon({ size = 17 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M3 17v2h6v-2H3ZM3 5v2h10V5H3Zm10 16v-2h8v-2h-8v-2h-2v6h2ZM7 9v2H3v2h4v2h2V9H7Zm14 4v-2H11v2h10Zm-6 -4h2V7h4V5h-4V3h-2v6Z" />
    </svg>
  );
}

/** Icons.Filled.Palette: the filter presets. */
export function PaletteIcon({ size = 17 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2C6.49 2 2 6.49 2 12s4.49 10 10 10c1.38 0 2.5 -1.12 2.5 -2.5c0 -0.61 -0.23 -1.2 -0.64 -1.67c-0.08 -0.1 -0.13 -0.21 -0.13 -0.33c0 -0.28 0.22 -0.5 0.5 -0.5H16c3.31 0 6 -2.69 6 -6c0 -4.96 -4.49 -9 -10 -9Zm5.5 11c-0.83 0 -1.5 -0.67 -1.5 -1.5s0.67 -1.5 1.5 -1.5s1.5 0.67 1.5 1.5s-0.67 1.5 -1.5 1.5Zm-3 -4c-0.83 0 -1.5 -0.67 -1.5 -1.5S13.67 6 14.5 6s1.5 0.67 1.5 1.5S15.33 9 14.5 9ZM5 11.5C5 10.67 5.67 10 6.5 10s1.5 0.67 1.5 1.5S7.33 13 6.5 13S5 12.33 5 11.5Zm6 -4C11 8.33 10.33 9 9.5 9S8 8.33 8 7.5S8.67 6 9.5 6s1.5 0.67 1.5 1.5Z" />
    </svg>
  );
}

/** Icons.Filled.Crop: the crop tool. */
export function CropIcon({ size = 17 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M7 17V1H5v4H1v2h4v10c0 1.1 0.9 2 2 2h10v4h2v-4h4v-2H7V17ZM17 15h2V7c0 -1.1 -0.9 -2 -2 -2H9v2h8v8Z" />
    </svg>
  );
}

/** Icons.Filled.Brush: the redaction strokes. */
export function BrushIcon({ size = 17 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M7 14c-1.66 0 -3 1.34 -3 3c0 1.31 -1.16 2 -2 2c0.92 1.22 2.49 2 4 2c2.21 0 4 -1.79 4 -4c0 -1.66 -1.34 -3 -3 -3Zm13.71 -9.37l-1.34 -1.34c-0.39 -0.39 -1.02 -0.39 -1.41 0L9 12.25L11.75 15l8.96 -8.96c0.39 -0.39 0.39 -1.02 0 -1.41Z" />
    </svg>
  );
}

/** Icons.Filled.RotateRight: turn the image a quarter clockwise. */
export function RotateRightIcon({ size = 17 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M15.55 5.55L11 1v3.07C7.06 4.56 4 7.92 4 12s3.05 7.44 7 7.93v-2.02c-2.84 -0.48 -5 -2.94 -5 -5.91s2.16 -5.43 5 -5.91V10l4.55 -4.45ZM19.93 11c-0.17 -1.39 -0.72 -2.73 -1.62 -3.89l-1.42 1.42c0.54 0.75 0.88 1.6 1.02 2.47h2.02ZM13 17.9v2.02c1.39 -0.17 2.74 -0.71 3.9 -1.61l-1.44 -1.44c-0.75 0.54 -1.59 0.89 -2.46 1.03Zm3.89 -2.42l1.42 1.41c0.9 -1.16 1.45 -2.5 1.62 -3.89h-2.02c-0.14 0.87 -0.48 1.72 -1.02 2.48Z" />
    </svg>
  );
}

/** Icons.Filled.Flip: mirror the image across a vertical axis. */
export function FlipHorizontalIcon({ size = 17 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M15 21h2v-2h-2v2Zm4 -12h2V7h-2v2ZM3 5v14c0 1.1 0.9 2 2 2h4v-2H5V5h4V3H5c-1.1 0 -2 0.9 -2 2Zm16 -2v2h2c0 -1.1 -0.9 -2 -2 -2Zm-8 20h2V1h-2v22Zm8 -6h2v-2h-2v2ZM15 5h2V3h-2v2Zm4 8h2v-2h-2v2Zm0 8c1.1 0 2 -0.9 2 -2h-2v2Z" />
    </svg>
  );
}

/** The vertical-axis flip, drawn as the same mark turned a quarter so its mirror line lies flat. */
export function FlipVerticalIcon({ size = 17 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <g transform="rotate(90 12 12)">
        <path d="M15 21h2v-2h-2v2Zm4 -12h2V7h-2v2ZM3 5v14c0 1.1 0.9 2 2 2h4v-2H5V5h4V3H5c-1.1 0 -2 0.9 -2 2Zm16 -2v2h2c0 -1.1 -0.9 -2 -2 -2Zm-8 20h2V1h-2v22Zm8 -6h2v-2h-2v2ZM15 5h2V3h-2v2Zm4 8h2v-2h-2v2Zm0 8c1.1 0 2 -0.9 2 -2h-2v2Z" />
      </g>
    </svg>
  );
}

/** Icons.AutoMirrored.Filled.Undo */
export function UndoIcon({ size = 17 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12.5 8c-2.65 0 -5.05 0.99 -6.9 2.6L2 7v9h9l-3.62 -3.62c1.39 -1.16 3.16 -1.88 5.12 -1.88c3.54 0 6.55 2.31 7.6 5.5l2.37 -0.78C21.08 11.03 17.15 8 12.5 8Z" />
    </svg>
  );
}

/** Icons.AutoMirrored.Filled.Redo */
export function RedoIcon({ size = 17 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M18.4 10.6C16.55 8.99 14.15 8 11.5 8c-4.65 0 -8.58 3.03 -9.96 7.22L3.9 16c1.05 -3.19 4.05 -5.5 7.6 -5.5c1.95 0 3.73 0.72 5.12 1.88L13 16h9V7l-3.6 3.6Z" />
    </svg>
  );
}
