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

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import logo from "./assets/logo.png";

const VERSION = "1.1.0";
const APP_NAME = "Photos for Proton";

// Each of these is allow-listed in src-tauri/capabilities/default.json; the opener
// plugin hands them to the default browser, so the installer window never navigates.
const LINKS = {
  author: "https://akoos.eu",
  website: "https://www.photosforproton.eu",
  source: "https://github.com/gitakoos/photos-desktop",
  issues: "https://github.com/gitakoos/photos-desktop/issues",
  contact: "mailto:support@photosforproton.eu",
};

function Link({ href, children }: { href: string; children: string }) {
  return (
    <button className="link" onClick={() => void openUrl(href).catch(() => {})}>
      {children}
    </button>
  );
}

// Verbatim from the project README ("Not affiliated with Proton"). Trademark wording:
// keep it in sync with the README rather than rephrasing it here.
const DISCLAIMER =
  'This is an independent project, not affiliated with, endorsed by, or supported by Proton AG. "Proton" and "Proton Drive" are trademarks of Proton AG.';

// An installer named "Photos for Proton" should never leave the user guessing where it
// came from, so who made it sits in plain view instead of behind a disclosure. The
// address is spelled out rather than hidden behind the word "Contact": a mailto opens
// nothing on a machine with no mail client set up, and a reader still needs it then.
function About() {
  return (
    <div className="about">
      <p className="about-what">Unofficial desktop client for Proton Drive Photos.</p>
      <p className="about-links">
        Made by <Link href={LINKS.author}>Akoos</Link> &middot; <Link href={LINKS.website}>Website</Link> &middot;{" "}
        <Link href={LINKS.source}>Source</Link> &middot; <Link href={LINKS.issues}>Issues</Link>
      </p>
      <p className="about-links">
        Contact <Link href={LINKS.contact}>support@photosforproton.eu</Link>
      </p>
    </div>
  );
}

// How this exe was launched: as the installer, as the installed uninstall.exe, or by
// the running app's own updater.
type Mode = "install" | "uninstall" | "update";
// What the user asked for. Running the installer over an install that is already
// there offers all three, so this is not the same thing as the launch mode.
type Action = "install" | "upgrade" | "uninstall";
type Step = "welcome" | "options" | "remove" | "working" | "done" | "error" | "updating" | "updated";

export default function App() {
  const [mode, setMode] = useState<Mode>("install");
  const [action, setAction] = useState<Action>("install");
  const [step, setStep] = useState<Step>("welcome");
  const [dir, setDir] = useState("");
  const [desktop, setDesktop] = useState(true);
  const [startMenu, setStartMenu] = useState(true);
  const [networkDrive, setNetworkDrive] = useState(true);
  // Off unless asked for. The other options put this app where the user looks for it;
  // this one changes what Windows offers for files that are not the app's own.
  const [fileTypes, setFileTypes] = useState(false);
  const [error, setError] = useState("");
  const [existing, setExisting] = useState<string | null>(null);
  const [dataReset, setDataReset] = useState(false);

  useEffect(() => {
    (async () => {
      const m = await invoke<Mode>("mode").catch(() => "install" as Mode);
      setMode(m);
      if (m === "update") {
        // The update is already running from the Rust side; this window only follows it.
        setAction("upgrade");
        setStep("updating");
      } else if (m === "install") {
        setDir(await invoke<string>("default_dir").catch(() => "C:\\Users\\...\\Photos for Proton"));
        setExisting(await invoke<string | null>("existing_install").catch(() => null));
      } else {
        // Launched as the installed uninstall.exe: there is nothing to choose here,
        // so open on the confirmation.
        setAction("uninstall");
        setStep("remove");
      }
      // The window starts hidden; reveal it now that the right screen is ready
      // (avoids a flash of the empty transparent frame while the WebView loads).
      requestAnimationFrame(() => void invoke("show_window").catch(() => {}));
    })();
  }, []);

  // Disable the WebView's native right-click menu (this is an installer, not a page).
  useEffect(() => {
    const block = (e: MouseEvent) => e.preventDefault();
    document.addEventListener("contextmenu", block);
    return () => document.removeEventListener("contextmenu", block);
  }, []);

  const close = () => getCurrentWindow().close().catch(() => {});

  // An update launched by the app: follow it until the app is back up, then go.
  useEffect(() => {
    if (step !== "updating") return;
    const id = setInterval(async () => {
      const state = await invoke<string>("update_state").catch(() => "running");
      if (state === "done") {
        clearInterval(id);
        setStep("updated");
        setTimeout(() => close(), 1400);
      } else if (state.startsWith("failed")) {
        clearInterval(id);
        setError(state.replace(/^failed: /, ""));
        setStep("error");
      }
    }, 300);
    return () => clearInterval(id);
  }, [step]);

  // After a successful uninstall, close automatically: the detached folder cleanup
  // waits for this window to exit before it can remove the install directory.
  useEffect(() => {
    if (action === "uninstall" && step === "done") {
      const t = setTimeout(() => close(), 1800);
      return () => clearTimeout(t);
    }
  }, [action, step]);

  async function doInstall() {
    setAction("install");
    setStep("working");
    try {
      await invoke("install", { dir, desktop, startMenu, networkDrive, fileTypes });
      setStep("done");
    } catch (e) {
      setError(String(e));
      setStep("error");
    }
  }

  // Lay this version over the one already installed, keeping the sign-in, the
  // cached photos, the settings and the shortcuts. It answers with whether the data
  // had to be reset, which only a change of storage format can cause.
  async function doUpgrade() {
    setAction("upgrade");
    setStep("working");
    try {
      setDataReset(await invoke<boolean>("upgrade"));
      setStep("done");
    } catch (e) {
      setError(String(e));
      setStep("error");
    }
  }

  // `uninstall` removes the folder this exe lives in, which is the installed
  // uninstall.exe removing itself; `uninstall_existing` looks the install up in the
  // registry, which is how the installer removes one it was run over.
  async function doUninstall() {
    setAction("uninstall");
    setStep("working");
    try {
      await invoke(mode === "uninstall" ? "uninstall" : "uninstall_existing");
      setStep("done");
    } catch (e) {
      setError(String(e));
      setStep("error");
    }
  }

  async function launchAndClose() {
    // An upgrade leaves the app where it already was, which is not necessarily the
    // default path the fresh-install screen offers.
    await invoke("launch", { dir: existing ?? dir }).catch(() => {});
    close();
  }

  return (
    <div className="win">
      <div className="titlebar" data-tauri-drag-region>
        <button className="tb-close" onClick={close} aria-label="Close">
          &#x2715;
        </button>
      </div>

      <div className="body">
        {/* ---------- INSTALL ---------- */}
        {/* Already installed. Upgrading is what running a newer installer is for, so
            it is the button in reach; removing the app is a choice of its own, made
            on its own screen, rather than what happens for running this twice. */}
        {mode === "install" && step === "welcome" && existing && (
          <div className="step center">
            <img className="logo" src={logo} alt="" />
            <h1 className="title">{APP_NAME}</h1>
            <p className="sub">
              is already installed at
              <br />
              <span className="path">{existing}</span>
            </p>
            <button className="btn primary wide" onClick={doUpgrade}>
              Upgrade
            </button>
            <p className="hint">Updates the app to {VERSION} and keeps your sign-in, photos and settings.</p>
            <div className="footer center-footer">
              <button className="btn ghost" onClick={close}>
                Close
              </button>
              <button className="btn ghost" onClick={() => setStep("remove")}>
                Uninstall
              </button>
            </div>
          </div>
        )}

        {mode === "install" && step === "welcome" && !existing && (
          <div className="step center">
            <img className="logo" src={logo} alt="" />
            <h1 className="title">{APP_NAME}</h1>
            <p className="sub">for Windows &middot; {VERSION}</p>
            <button className="btn primary wide" onClick={() => setStep("options")}>
              Install
            </button>
            <About />
          </div>
        )}

        {mode === "install" && step === "options" && (
          <div className="step">
            <h2 className="h2">Install {APP_NAME}</h2>
            <p className="sub-left">Installs to your user folder. No administrator rights needed.</p>

            <span className="group-label">Shortcuts</span>
            <div className="rows">
              <label className="opt">
                <span className="opt-text">
                  <span className="opt-label">Desktop</span>
                </span>
                <input
                  className="opt-switch"
                  type="checkbox"
                  checked={desktop}
                  onChange={(e) => setDesktop(e.currentTarget.checked)}
                />
              </label>
              <label className="opt">
                <span className="opt-text">
                  <span className="opt-label">Start menu</span>
                </span>
                <input
                  className="opt-switch"
                  type="checkbox"
                  checked={startMenu}
                  onChange={(e) => setStartMenu(e.currentTarget.checked)}
                />
              </label>
            </div>

            <span className="group-label">File Explorer</span>
            <div className="rows">
              {/* The note is described-by rather than wrapped in the label's name, so a
                  screen reader announces the switch by its short name and then the note. */}
              <label className="opt">
                <span className="opt-text">
                  <span className="opt-label">Show "Proton Photos" in File Explorer</span>
                  {/* Hydration is not user-initiated: the app registers a full hydration
                      policy, so a read by anything at all pulls the photo down. */}
                  <span className="opt-desc" id="explorer-note">
                    Your photos, favourites and albums as folders. Copy photos in to upload them, rename, or delete
                    to the Proton trash. A photo downloads when any program opens it, a backup tool or an antivirus
                    scan included. Windows Search leaves the folder out.
                  </span>
                </span>
                <input
                  className="opt-switch"
                  type="checkbox"
                  aria-describedby="explorer-note"
                  checked={networkDrive}
                  onChange={(e) => setNetworkDrive(e.currentTarget.checked)}
                />
              </label>
            </div>

            <span className="group-label">File types</span>
            <div className="rows">
              <label className="opt">
                <span className="opt-text">
                  <span className="opt-label">Add to the "Open with" list</span>
                  {/* Honest about the ceiling: Windows protects the default handler behind
                      a hash of its own, so no installer can set one, and this does not try. */}
                  <span className="opt-desc" id="filetypes-note">
                    For common photo and video files. Nothing becomes the default: Windows takes that choice only
                    from you.
                  </span>
                </span>
                <input
                  className="opt-switch"
                  type="checkbox"
                  aria-describedby="filetypes-note"
                  checked={fileTypes}
                  onChange={(e) => setFileTypes(e.currentTarget.checked)}
                />
              </label>
            </div>

            <div className="footer">
              <button className="btn ghost" onClick={() => setStep("welcome")}>
                Back
              </button>
              <button className="btn primary" onClick={doInstall} disabled={!dir.trim()}>
                Install
              </button>
            </div>
          </div>
        )}

        {step === "updating" && (
          <div className="step center">
            <img className="logo small" src={logo} alt="" />
            <h2 className="h2 tight">Updating {APP_NAME}</h2>
            <p className="working-text">Installing {VERSION}. The app opens again by itself.</p>
            <div className="bar">
              <div className="bar-fill" />
            </div>
          </div>
        )}

        {step === "updated" && (
          <div className="step center">
            <div className="checkmark" aria-hidden>
              &#x2713;
            </div>
            <h2 className="h2 tight">Updated to {VERSION}</h2>
            <p className="working-text">Opening {APP_NAME}...</p>
          </div>
        )}

        {step === "working" && (
          <div className="step center">
            <img className="logo small" src={logo} alt="" />
            <p className="working-text">
              {action === "uninstall" ? "Removing..." : action === "upgrade" ? "Upgrading..." : "Installing..."}
            </p>
            <div className="bar">
              <div className="bar-fill" />
            </div>
          </div>
        )}

        {action === "install" && step === "done" && (
          <div className="step center">
            <div className="checkmark" aria-hidden>&#x2713;</div>
            <h2 className="h2">{APP_NAME} is installed</h2>
            <p className="sub">Ready to go.</p>
            <div className="footer center-footer">
              <button className="btn ghost" onClick={close}>
                Close
              </button>
              <button className="btn primary" onClick={launchAndClose}>
                Launch
              </button>
            </div>
          </div>
        )}

        {action === "upgrade" && step === "done" && (
          <div className="step center">
            <div className="checkmark" aria-hidden>&#x2713;</div>
            {/* Not "up to date": nothing compares versions, and running an older
                installer over a newer install ends up on this screen too. */}
            <h2 className="h2">
              {APP_NAME} {VERSION} is installed
            </h2>
            {/* A reset only happens when this version stores its data differently
                from the one it replaced, and it is never left to be discovered. */}
            <p className="sub">
              {dataReset
                ? "This version stores its data differently, so the sign-in and the cached photos had to be cleared. Signing in again brings them back."
                : "Your sign-in, photos and settings are as you left them."}
            </p>
            <div className="footer center-footer">
              <button className="btn ghost" onClick={close}>
                Close
              </button>
              <button className="btn primary" onClick={launchAndClose}>
                Launch
              </button>
            </div>
          </div>
        )}

        {/* ---------- UNINSTALL ---------- */}
        {/* Reached by launching the installed uninstall.exe, or by choosing Uninstall
            over an existing install. Cancel goes back where it came from. */}
        {step === "remove" && (
          <div className="step center">
            <img className="logo" src={logo} alt="" />
            <h1 className="title">Uninstall {APP_NAME}?</h1>
            {/* Fully downloaded files are deliberately reverted to ordinary files and
                kept (see `detach_one`), so this cannot claim the photos go with it. */}
            <p className="sub">
              This removes the app, the sign-in and the encrypted cache. Photos already downloaded to your Proton
              Photos folder stay on this computer as ordinary files.
            </p>
            <div className="footer center-footer">
              <button className="btn ghost" onClick={mode === "uninstall" ? close : () => setStep("welcome")}>
                Cancel
              </button>
              <button className="btn danger" onClick={doUninstall}>
                Uninstall
              </button>
            </div>
          </div>
        )}

        {action === "uninstall" && step === "done" && (
          <div className="step center">
            <div className="checkmark" aria-hidden>&#x2713;</div>
            <h2 className="h2">{APP_NAME} has been removed</h2>
            <div className="footer center-footer">
              <button className="btn primary" onClick={close}>
                Close
              </button>
            </div>
          </div>
        )}

        {step === "error" && (
          <div className="step center">
            <div className="checkmark err">!</div>
            <h2 className="h2">Something went wrong</h2>
            <p className="err-text">{error}</p>
            {/* The one screen where a reader actively needs somewhere to take this. */}
            <About />
            <div className="footer center-footer">
              <button className="btn ghost" onClick={close}>
                Close
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Outside the steps, so no screen can be added without it. The app registers an
          Explorer sidebar entry labelled "Proton Photos", which is the surface most
          likely to be taken for Proton's own product. */}
      <p className="legal">{DISCLAIMER}</p>
    </div>
  );
}
