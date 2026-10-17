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

import { Component, type ErrorInfo, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * The last thing between a failed render and a window with nothing in it.
 *
 * React answers an uncaught error during render by unmounting the whole tree. Both of
 * this app's real windows are frameless and transparent, so what that leaves on screen
 * is not a blank page but an empty pane of glass: no message, no controls, nothing to
 * say the app is even still running. It reads as a crash and is impossible to report.
 *
 * So this says what happened and offers the one thing that fixes it. The message is
 * shown rather than only logged, because the person looking at the window is the only
 * one who can say what they were doing when it went.
 *
 * Deliberately not translated. A fault in the dictionaries is exactly the kind of thing
 * that lands here, and a screen that fails to render its own apology helps nobody.
 */
type Props = { children: ReactNode };
type State = { message: string | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { message: null };

  static getDerivedStateFromError(error: unknown): State {
    const message = error instanceof Error ? error.message : String(error);
    return { message: message || "Something went wrong." };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    // The component stack is what turns "it went blank" into a place to look.
    const where = info.componentStack ?? "";
    // eslint-disable-next-line no-console
    console.error("[render]", error, where);
    // And to the app's own log, because the webview console is not something a user
    // can be asked to open. First line only: the stack's top frame names the
    // component, and the rest is depth nobody reads out of a log file.
    const message = error instanceof Error ? error.message : String(error);
    const top = where.trim().split("\n")[0]?.trim() ?? "";
    void invoke("log_note", { message: `render failed: ${message} ${top}` }).catch(() => {});
  }

  render() {
    if (this.state.message === null) return this.props.children;
    return (
      <div className="eb-wrap">
        <div className="eb-card">
          <h1 className="eb-title">Photos for Proton ran into a problem</h1>
          <p className="eb-text">
            The window could not be drawn. Reopening it usually clears this, and nothing
            in your library or on your PC has been changed.
          </p>
          <p className="eb-detail">{this.state.message}</p>
          <button className="eb-btn" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}
