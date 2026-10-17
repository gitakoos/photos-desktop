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

import { getCurrentWindow } from "@tauri-apps/api/window";
import { useT } from "../lib/i18n";
import logo from "../assets/applogo.png";

const appWindow = getCurrentWindow();

/**
 * The window's own controls.
 *
 * Separate from the bar around them because the bar is not always there: the
 * viewer covers it whole, and when the viewer IS the window's content there is
 * nothing else left to minimise or close the window with. Both places carry the
 * same three, so a window never has two ways of being closed that behave
 * differently.
 */
export function WindowButtons() {
  const t = useT();
  return (
    <div className="titlebar-buttons">
      <button className="win-btn" title={t("titlebar.minimize")} onClick={() => appWindow.minimize()}>
        <svg width="10" height="10" viewBox="0 0 10 10">
          <rect x="1" y="4.5" width="8" height="1" fill="currentColor" />
        </svg>
      </button>
      <button className="win-btn" title={t("titlebar.maximize")} onClick={() => appWindow.toggleMaximize()}>
        <svg width="10" height="10" viewBox="0 0 10 10">
          <rect x="1.5" y="1.5" width="7" height="7" fill="none" stroke="currentColor" />
        </svg>
      </button>
      <button className="win-btn close" title={t("common.close")} onClick={() => appWindow.close()}>
        <svg width="10" height="10" viewBox="0 0 10 10">
          <path d="M1 1 L9 9 M9 1 L1 9" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
    </div>
  );
}

export function Titlebar() {
  return (
    <div className="titlebar" data-tauri-drag-region>
      <span className="titlebar-title" data-tauri-drag-region>
        <img className="titlebar-logo" src={logo} alt="" draggable={false} />
        Photos for Proton
      </span>
      <WindowButtons />
    </div>
  );
}
