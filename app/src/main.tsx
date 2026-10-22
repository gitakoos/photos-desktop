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

import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
// Tokens first: every other stylesheet resolves its colours against them.
import "./styles/theme.css";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { TrayPopup } from "./views/TrayPopup";
import { ViewerWindow } from "./views/ViewerWindow";
import { LangProvider } from "./lib/i18n";
import { applyTheme, type ThemeMode } from "./lib/theme";
import { isWindows } from "./lib/platform";

/**
 * A line in the app's log, from the page.
 *
 * Everything below this point can throw, and until now a throw up here was completely
 * silent: React never mounted, so the error boundary did not exist to catch it, and
 * the window came up as an empty transparent pane with the log saying nothing at all.
 * These few breadcrumbs are what turn that into a report.
 *
 * Fire and forget, and never allowed to fail: a log line must not be the thing that
 * stops the app starting.
 */
function boot(step: string) {
  void invoke("log_note", { message: `boot ${step}` }).catch(() => {});
}

boot("module");

// One bundle, three windows. The host loads this same frontend into each of them, so
// what to render is decided by which window this is running in and never by state:
// they are separate processes' worth of React, with nothing shared between them but
// what the host holds.
const label = getCurrentWindow().label;
const isTrayPopup = label === "tray_popup";
const isViewer = label === "viewer";

// Only <App/> restores the theme as part of starting up, so the two windows that skip
// it have to do it themselves or they always paint in the default dark palette.
if (isTrayPopup || isViewer) {
  (async () => {
    try {
      const raw = await invoke<string | null>("store_get", { name: "settings" });
      if (raw) {
        const s = JSON.parse(raw);
        applyTheme((s.theme as ThemeMode) ?? "dark", s.palette, s.amoled === true);
      }
    } catch {
      /* keep the default dark theme */
    }
  })();
}

// On Windows the system rounds and shades the window (see the host's `framed`), so the
// page draws no corners of its own; and the window's own colour, which shows for a frame
// wherever a resize uncovers it, follows what the page paints at its edge.
if (isWindows) {
  const root = document.documentElement;
  root.setAttribute("data-native-frame", "");
  let painted = "";
  const follow = () => {
    const edge =
      document.querySelector(".app-shell") ?? document.querySelector(".lbx.owns-window") ?? document.body;
    const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(edge).backgroundColor);
    if (!match || match[0] === painted) return;
    painted = match[0];
    void getCurrentWindow()
      .setBackgroundColor([Number(match[1]), Number(match[2]), Number(match[3]), 255])
      .catch(() => {});
  };
  new MutationObserver(follow).observe(root, { attributes: true, attributeFilter: ["data-theme", "data-layout", "style"] });
  window.addEventListener("load", follow);
  setTimeout(follow, 1500);
}

// Outside the language provider on purpose: it has to survive a fault in the very
// thing that would translate its message.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <ErrorBoundary>
    <LangProvider>
      {isTrayPopup ? <TrayPopup /> : isViewer ? <ViewerWindow /> : <App />}
    </LangProvider>
  </ErrorBoundary>,
);

boot(`rendered ${label}`);

// Both real windows ship hidden so the empty transparent frame is never seen while the
// WebView loads. The app's is revealed once the first frame has painted; the viewer
// waits for the file it was opened for and asks for itself. The tray popup owns its own
// visibility (shown on a tray click), so it is left alone.
if (!isTrayPopup && !isViewer) {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      void invoke("reveal_window").catch(() => {});
    }),
  );
}
