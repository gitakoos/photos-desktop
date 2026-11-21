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

// The one place the platform is decided. WebView2 (Windows) reports "Windows NT" in the
// user agent; WebKitGTK (the Linux build) reports "Linux" and never "Windows", and no
// custom user agent is set, so this is reliable. It is synchronous, so the first render
// can gate on it without a host round-trip. Everything bound to the File Explorer / Cloud
// Filter integration, the tray and the self-updater is Windows-only, which is exactly
// what `isWindows` guards; the Linux build has its own file-manager drive instead.
export const isWindows = /windows/i.test(navigator.userAgent);

// WKWebView (the macOS build) reports "Macintosh". The Linux-only integrations, the
// file-manager drive and running on after the window closes, are hidden there; every other
// non-Windows branch still serves macOS as it serves Linux.
export const isMac = !isWindows && /macintosh|mac os x/i.test(navigator.userAgent);
export const isLinux = !isWindows && !isMac;

// The OS itself confirms it is the account's owner: Windows Hello, or Touch ID with the Mac's
// password behind it. Linux has no such prompt for an app, so its locks use a password of their own.
export const hasOsLock = isWindows || isMac;
