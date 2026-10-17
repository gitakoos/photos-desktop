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

import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LocalViewer } from "../components/LocalViewer";
import { useOpenFile } from "../hooks/useOpenFile";

/**
 * The whole of the "viewer" window: one file, opened from Explorer, and nothing of
 * the app around it.
 *
 * Its own window rather than a branch inside the app's, so someone browsing their
 * library still has it when a photo is opened, and so the two can be closed
 * separately. Nothing here reaches the sidecar, which is what lets it paint with no
 * vault and nobody signed in.
 */
export function ViewerWindow() {
  const { path, delivery, checked, retarget } = useOpenFile();

  // Held back until the host has answered AND that answer has been painted, so the
  // window arrives with the file in it rather than as an empty frame that fills in
  // afterwards.
  useEffect(() => {
    if (!checked) return;
    let gone = false;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (!gone) void invoke("reveal_window").catch(() => {});
      }),
    );
    return () => {
      gone = true;
    };
  }, [checked]);

  // A viewer with no file is not a window anyone asked for. The host only ever builds
  // this one alongside a path, so reaching here means the file went away between the
  // double-click and the window, and there is nothing to show or to say.
  useEffect(() => {
    if (checked && !path) void getCurrentWindow().close();
  }, [checked, path]);

  // The webview's own menu, off. The app's window has done this since it grew a menu
  // of its own; this window never did, so it still offered the browser's, and on a
  // video that menu carries Save-as and Picture-in-picture: a page's furniture, in a
  // window that is meant to read as a photo viewer. Nothing takes its place yet.
  useEffect(() => {
    function block(e: MouseEvent) {
      e.preventDefault();
    }
    document.addEventListener("contextmenu", block);
    return () => document.removeEventListener("contextmenu", block);
  }, []);

  if (!path) return null;

  return (
    <LocalViewer
      path={path}
      delivery={delivery}
      onClose={() => void getCurrentWindow().close()}
      // Uploading needs an account, so this is the one thing in here that wants the
      // app. It brings the app's window up and starts what a viewer launch skipped;
      // this window stays exactly as it is, with the file that prompted it still open.
      onSignIn={() => void invoke("enter_app").catch(() => {})}
      onRetarget={retarget}
    />
  );
}
