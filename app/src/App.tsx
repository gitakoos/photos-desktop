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

import { ChevronLeftIcon, LockIcon, SpinnerIcon } from "./components/icons";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { flushSync } from "react-dom";
import { setAppCover } from "./lib/appCover";
import { Titlebar } from "./components/Titlebar";
import { UpdateOverlay } from "./components/UpdateOverlay";
import { ContextMenu, type MenuAction } from "./components/ContextMenu";
import { Photos } from "./views/Photos";
import { LoginCard } from "./components/LoginCard";
import { Lock } from "./views/Lock";
import { AppLock } from "./components/AppLock";
import { SignOutConfirm } from "./components/SignOutConfirm";
import { rpc } from "./lib/rpc";
import { applyTheme, type ThemeMode } from "./lib/theme";
import { useT } from "./lib/i18n";
import "./styles/App.css";
import { isWindows } from "./lib/platform";

type Phase = "credentials" | "browser" | "protect" | "offline";
type MenuState = { x: number; y: number } | null;
type LoginResult =
  | { status: "ok"; email: string }
  | { status: "protect"; email: string }
  | { status: "relogin" }
  | { status: "offline"; email?: string; kept?: number }
  | { status: "error"; error: string };
type BrowserStatus = LoginResult | { status: "waiting" } | { status: "cancelled" };
type LockStatus = {
  hasVault: boolean;
  unlocked: boolean;
  email: string | null;
  mode: "password" | "device" | null;
  protect: boolean;
};

/** How often the app tries again to resume a saved session while Proton cannot be reached. */
const OFFLINE_RETRY_MS = 15_000;
/** How often the app asks whether the sign-in in the browser has finished. */
const BROWSER_POLL_MS = 500;
/** How long the sign-in button only spins before it offers to open the page again. */
const REOPEN_AFTER_MS = 4000;
/** As the sidecar requires of a password of the user's own. */
const MIN_APP_PASSWORD = 8;
/** The sign-in message for a session that lapsed, kept as its key (see `shownStatus`). */
const SESSION_ENDED = "login.sessionEnded";

/** Where the window remembers it is locked, across a reload of the page. */
const HELLO_LOCKED_KEY = "pfp.helloLocked";

/**
 * How the app locks, from the settings: Windows Hello, the password (a vault with one), and after
 * how many seconds of not being used or of waiting in the tray, 0 for as soon as it goes there.
 */
type LockPrefs = { hello: boolean; password: boolean; after: number; minimized: boolean };
const NO_LOCK: LockPrefs = { hello: false, password: false, after: 0, minimized: false };

async function readLockPrefs(): Promise<LockPrefs> {
  try {
    const raw = await invoke<string | null>("store_get", { name: "settings" });
    if (!raw) return NO_LOCK;
    const s = JSON.parse(raw) as { helloLock?: boolean; lockOnHide?: boolean; lockAfter?: number; lockOnMinimize?: boolean };
    return {
      minimized: s.lockOnMinimize === true,
      // On Linux the same lock asks for the local lock's password instead of Windows Hello.
      hello: s.helloLock === true,
      password: s.lockOnHide === true,
      after: typeof s.lockAfter === "number" && s.lockAfter > 0 ? s.lockAfter : 0,
    };
  } catch {
    return NO_LOCK;
  }
}

/** Covers the window while it comes back from the tray, until it is known whether it locks. */
const VEIL = "pfp-veil";
/** How often the app looks whether it has gone unused long enough to lock. */
const IDLE_LOOK_MS = 5_000;

function App() {
  const t = useT();
  const [restoring, setRestoring] = useState(true);
  const [email, setEmail] = useState<string | null>(null);
  // Open on the photos kept offline: Proton could not be reached to resume the session, and
  // the app keeps trying. `libraryKey` starts the library afresh once Proton answers.
  const [offlineLibrary, setOfflineLibrary] = useState(false);
  const [libraryKey, setLibraryKey] = useState(0);
  // Set when a saved (encrypted) account exists but is still locked: the app
  // shows the lock screen and waits for the password before anything else.
  const [locked, setLocked] = useState<{ email: string | null } | null>(null);
  const [phase, setPhase] = useState<Phase>("credentials");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  // A message set while the app starts is kept as its key and translated when shown: the
  // saved language arrives a moment after the first screen, and a string translated
  // before it would stay in the language of Windows.
  const shownStatus = status === SESSION_ENDED ? t(SESSION_ENDED) : status;
  const [menu, setMenu] = useState<MenuState>(null);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [browserUrl, setBrowserUrl] = useState<string | null>(null);
  // The browser sign-in's button turns into "open the page again" a moment after it starts.
  const [reopenReady, setReopenReady] = useState(false);
  // The browser would not open: the button hands over the link to open by hand instead.
  const [openFailed, setOpenFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [protection, setProtection] = useState<"hello" | "password" | "device">("password");
  // A password of the user's own is set on a step of its own, after the choice.
  const [protectStep, setProtectStep] = useState<"choose" | "password">("choose");
  // Windows Hello is offered for the sign-in, and picked first, where it can answer here.
  const [helloReady, setHelloReady] = useState(false);
  useEffect(() => {
    if (!isWindows) return;
    void invoke<boolean>("hello_available")
      .then((ready) => {
        setHelloReady(ready);
        if (ready) {
          setProtection("hello");
          setMoveChoice("hello");
        }
      })
      .catch(() => {});
  }, []);
  const [appPassword, setAppPassword] = useState("");
  const [appPassword2, setAppPassword2] = useState("");
  // An account signed in with the Proton password, from before the app stopped asking for it:
  // null until known, then whether the user still has to pick how the app opens from now on.
  const [legacy, setLegacy] = useState<boolean | null>(null);
  const [moveChoice, setMoveChoice] = useState<"hello" | "device" | "password">("password");
  // The tray listeners register once on mount, so they read the live email
  // through this ref instead of a stale closure captured at registration.
  const emailRef = useRef<string | null>(null);
  // The app lock: Windows Hello before the photos show again. The setting is kept here as last
  // read, so hiding to the tray can lock at once, before the page is put to sleep.
  // Kept for the life of the window, so a reload does not open what the lock is closing.
  const [helloLocked, setHelloLocked] = useState(() => {
    try {
      return sessionStorage.getItem(HELLO_LOCKED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const lockPrefs = useRef<LockPrefs>(NO_LOCK);
  // Whether the taskbar preview has been set for the lock since the window opened.
  const previewSet = useRef(false);
  // When the app was last used, and when it went to the tray, for locking after a while.
  const lastUsed = useRef(Date.now());
  const hiddenAt = useRef(0);
  // A lock started as the window went away, which a return waits for before uncovering.
  const pendingLock = useRef<Promise<void> | null>(null);
  useEffect(() => {
    try {
      if (helloLocked) sessionStorage.setItem(HELLO_LOCKED_KEY, "1");
      else sessionStorage.removeItem(HELLO_LOCKED_KEY);
    } catch {
      /* storage refused: a reload then opens without asking */
    }
  }, [helloLocked]);

  // Read here rather than in Photos: the theme has to be up for the sign-in
  // screen, which paints long before Photos mounts.
  useEffect(() => {
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
  }, []);

  // On startup, decide between the app, the lock screen, and a fresh sign-in.
  //
  // Both calls below are the first thing to reach the sidecar, and starting the SDK
  // process is the single most expensive thing about a launch. This window is the only
  // one that pays it: a file opened from Explorer gets a window of its own, which is
  // built without any of this and paints with no vault, no sign-in and no sidecar.
  async function decideSession(cold = false) {
    try {
      // A reload throws away the WebView, not the sidecar process. If the vault
      // is still unlocked in it, reuse the live session and skip the password.
      const live = await rpc<{ email: string } | null>("whoami").catch(() => null);
      if (live) {
        setEmail(live.email);
        setRestoring(false);
        return;
      }

      // Otherwise ask the sidecar what it holds. A saved-but-locked account
      // (cold start) always needs the password before the session is readable.
      const s = await rpc<LockStatus>("lockStatus");
      keepLockPrefs(await readLockPrefs());
      // Opened without a password, the app asks Windows Hello first when its owner asked for that.
      if (cold && s.mode === "device" && lockPrefs.current.hello) setHelloLocked(true);
      if (s.protect) {
        // A browser sign-in finished before a reload, and still waits for its choice.
        setPhase("protect");
      } else if (s.unlocked && s.email) {
        setEmail(s.email);
      } else if (s.unlocked && s.mode === "device") {
        // Open with no session yet: a resume may still be under way (the window was
        // reloaded during it), and this waits for that one rather than starting another.
        // A session that lapsed answers with a sign-in, as below.
        await applyResult(await rpc<LoginResult>("unlockDevice"));
      } else if (s.unlocked) {
        // The vault is open but its session lapsed: a sign-in again, into the same vault.
      } else if (s.hasVault && s.mode === "device") {
        // Nothing to ask: this Windows account opens the vault.
        await applyResult(await rpc<LoginResult>("unlockDevice"));
      } else if (s.hasVault) {
        setLocked({ email: s.email });
      }
      // else: no saved account -> fall through to the full sign-in screen.
    } catch {
      /* fall through to the login screen */
    }
    setRestoring(false);
  }

  useEffect(() => {
    void decideSession(true);
  }, []);

  // Proton refused the session while the app was open (a password change, "sign out of all
  // devices", this device removed): nothing more of it is shown, the sign-in asks again.
  useEffect(() => {
    let off: (() => void) | undefined;
    let disposed = false;
    void listen("session-ended", () => {
      if (!emailRef.current) return;
      setEmail(null);
      setLocked(null);
      setBrowserUrl(null);
      setPhase("credentials");
      setStatus(SESSION_ENDED);
    }).then((stop) => {
      if (disposed) stop();
      else off = stop;
    });
    return () => {
      disposed = true;
      off?.();
    };
  }, []);

  // The sidecar was replaced (it stopped answering, or it quit) and the signed-in session
  // went with it. Decide again from the start: a vault this Windows account opens is
  // unlocked straight back, a password one shows the lock screen. Left alone, every
  // call would fail while the window still looked signed in.
  useEffect(() => {
    let off: (() => void) | undefined;
    let disposed = false;
    void listen("sidecar-restarted", () => {
      if (!emailRef.current) return;
      setEmail(null);
      setLocked(null);
      setPhase("credentials");
      setRestoring(true);
      void decideSession();
    }).then((stop) => {
      if (disposed) stop();
      else off = stop;
    });
    return () => {
      disposed = true;
      off?.();
    };
  }, []);

  // With no session to show, the page has nothing more to do by itself once it has put
  // the sign-in or the lock screen up, and the host may then suspend it in the tray. Not
  // while offline: that screen tries again on its own. A session that is restored is
  // settled by the photos view, once the timeline is read.
  useEffect(() => {
    if (!restoring && !email && phase !== "offline") void invoke("page_settled").catch(() => {});
  }, [restoring, email, phase]);

  // The native menu is off everywhere, and this is what stands in for it on a
  // right-click nothing else claimed. A photo or an album has a menu of its own
  // and stops the event before it reaches the document, so exactly one menu ever
  // opens. The menu itself owns its dismissal, so there is no click handler here.
  useEffect(() => {
    function onContextMenu(e: MouseEvent) {
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY });
    }
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);

  /** Route a sign-in result to the phase it asks for. */
  async function applyResult(r: LoginResult) {
    if (r.status === "ok") {
      setEmail(r.email);
    } else if (r.status === "protect") {
      setPhase("protect");
    } else if (r.status === "relogin") {
      setPhase("credentials");
      setStatus(SESSION_ENDED);
    } else if (r.status === "offline") {
      setLocked(null);
      setPhase("offline");
      // Photos kept offline open as they are, while the app keeps trying.
      if (r.kept) {
        setOfflineLibrary(true);
        // A session saved before its address was kept has none to show until Proton answers.
        setEmail(r.email || t("offlineMode.label"));
      }
    } else {
      setStatus(r.error);
    }
  }

  /** Opens Proton's sign-in page in the browser and waits for it here. */
  async function onBrowserSignIn(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setStatus("");
    try {
      const { url } = await rpc<{ url: string }>("startBrowserLogin");
      setBrowserUrl(url);
      setOpenFailed(false);
      setCopied(false);
      setPhase("browser");
      await invoke("open_sign_in_page", { url }).catch(() => {
        setOpenFailed(true);
        setStatus(t("login.browserNotOpened"));
      });
    } catch (err) {
      setStatus(String(err));
    }
    setBusy(false);
  }

  async function cancelBrowserSignIn() {
    await rpc("cancelBrowserLogin").catch(() => {});
    setBrowserUrl(null);
    setPhase("credentials");
  }

  // While the browser sign-in is open: ask now and then whether Proton has answered, and
  // at once when the user comes back to the window, which is when it most likely has.
  useEffect(() => {
    if (phase !== "browser") return;
    let stopped = false;
    let handled = false;
    let timer = 0;
    const ask = async (nudge = false) => {
      let r: BrowserStatus;
      try {
        r = await rpc<BrowserStatus>("browserLoginStatus", nudge ? { nudge: true } : {});
      } catch (err) {
        r = { status: "error", error: String(err) };
      }
      if (stopped || handled) return;
      if (r.status === "waiting") {
        if (!nudge) timer = window.setTimeout(() => void ask(), BROWSER_POLL_MS);
        return;
      }
      handled = true;
      window.clearTimeout(timer);
      setBrowserUrl(null);
      if (r.status === "cancelled") {
        setPhase("credentials");
      } else if (r.status === "error") {
        setPhase("credentials");
        setStatus(r.error === "timeout" ? t("login.browserTimeout") : r.error);
      } else {
        await applyResult(r);
      }
    };
    timer = window.setTimeout(() => void ask(), BROWSER_POLL_MS);
    const onFocus = () => void ask(true);
    window.addEventListener("focus", onFocus);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [phase]);

  // The saved sign-in is kept while Proton cannot be reached: try again now and then,
  // and the moment it gets through the app opens as it would have.
  async function retryResume() {
    setBusy(true);
    setStatus("");
    try {
      const r = await rpc<LoginResult>("retryResume");
      if (r.status !== "offline") {
        setPhase("credentials");
        if (offlineLibrary) {
          setOfflineLibrary(false);
          // Back online: the whole library reads again. Anything else leaves it for the sign-in.
          if (r.status === "ok") setLibraryKey((k) => k + 1);
          else setEmail(null);
        }
        await applyResult(r);
      }
    } catch (err) {
      setStatus(String(err));
    }
    setBusy(false);
  }

  useEffect(() => {
    if (phase !== "offline") return;
    const timer = window.setInterval(() => void retryResume(), OFFLINE_RETRY_MS);
    return () => window.clearInterval(timer);
  }, [phase, offlineLibrary]);

  // Signed out, locked or ended: the next account opens as itself, not offline.
  useEffect(() => {
    if (!email) setOfflineLibrary(false);
  }, [email]);

  /** The browser sign-in's page, opened again for a user who closed or lost it. */
  function onReopenSignIn(e: FormEvent) {
    e.preventDefault();
    if (!browserUrl) return;
    if (openFailed) {
      void navigator.clipboard
        .writeText(browserUrl)
        .then(() => setCopied(true))
        .catch(() => {});
      return;
    }
    void invoke("open_sign_in_page", { url: browserUrl }).catch(() => {
      setOpenFailed(true);
      setStatus(t("login.browserNotOpened"));
    });
  }

  useEffect(() => {
    setReopenReady(false);
    if (phase !== "browser") return;
    const timer = window.setTimeout(() => setReopenReady(true), REOPEN_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);

  /** Turns the Windows Hello app lock on in the settings, beside whatever else they hold. */
  async function keepHelloLock() {
    try {
      const raw = await invoke<string | null>("store_get", { name: "settings" });
      const settings = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      settings.helloLock = true;
      settings.lockOnHide = false;
      await invoke("store_set", { name: "settings", value: JSON.stringify(settings) });
      keepLockPrefs({ ...lockPrefs.current, hello: true });
    } catch {
      /* turned on in Settings instead */
    }
  }

  /** Seals the browser sign-in the way the user picked. */
  async function onProtect(e: FormEvent) {
    e.preventDefault();
    setStatus("");
    if (protection === "password" && protectStep === "choose") {
      setProtectStep("password");
      return;
    }
    if (protection === "password") {
      if (appPassword.length < MIN_APP_PASSWORD) {
        setStatus(t("protect.tooShort", { n: MIN_APP_PASSWORD }));
        return;
      }
      if (appPassword !== appPassword2) {
        setStatus(t("protect.mismatch"));
        return;
      }
    }
    if (protection === "hello") {
      // Hello answers once here, so nobody keeps a lock they cannot open.
      const answer = await invoke<string>("hello_verify", { message: t("appLock.prompt") }).catch(() => "failed");
      if (answer !== "verified") return;
    }
    setBusy(true);
    try {
      const r = await rpc<LoginResult>("protectSession", {
        password: protection === "password" ? appPassword : null,
      });
      if (r.status === "ok" && protection === "hello") await keepHelloLock();
      if (r.status === "ok") {
        setAppPassword("");
        setAppPassword2("");
        setProtectStep("choose");
      }
      if (r.status === "error" && r.error === "too short") {
        setStatus(t("protect.tooShort", { n: MIN_APP_PASSWORD }));
      } else {
        await applyResult(r);
      }
    } catch (err) {
      setStatus(String(err));
    }
    setBusy(false);
  }

  /** Forget the account. The sidecar deletes the saved session and vault; here we relock the UI. */
  async function signOut() {
    await rpc("signOut").catch(() => {});
    setEmail(null);
    setLocked(null);
    setHelloLocked(false);
    setPhase("credentials");
    setStatus("");
  }

  // Whether the account just opened was signed in with the Proton password, and so still
  // waits for the user to pick how the app opens from now on.
  useEffect(() => {
    if (!email) {
      setLegacy(null);
      return;
    }
    let live = true;
    void rpc<{ legacy: boolean }>("signInChoice")
      .then((r) => live && setLegacy(r.legacy))
      .catch(() => live && setLegacy(false));
    return () => {
      live = false;
    };
  }, [email]);

  /** Keeps the account signed in the way the user picked, with nothing fetched or built again. */
  async function onMove(e: FormEvent) {
    e.preventDefault();
    setStatus("");
    if (moveChoice === "hello") {
      const answer = await invoke<string>("hello_verify", { message: t("appLock.prompt") }).catch(() => "failed");
      if (answer !== "verified") return;
    }
    setBusy(true);
    try {
      const r = await rpc<{ ok: boolean }>("keepSignIn", { choice: moveChoice === "password" ? "password" : "device" });
      if (r.ok) {
        if (moveChoice === "hello") await keepHelloLock();
        setLegacy(false);
      } else {
        setStatus(t("lock.failed"));
      }
    } catch (err) {
      setStatus(String(err));
    }
    setBusy(false);
  }

  // Keep the ref in step with the state for the mount-time tray listeners.
  useEffect(() => {
    emailRef.current = email;
  }, [email]);

  // React to the system-tray menu. Registered once; the handlers read the live
  // email via emailRef and the live lockOnHide straight from the persisted
  // settings, so neither goes stale between mount and the moment the tray fires.
  useEffect(() => {
    let unlistenSignout: (() => void) | undefined;
    let unlistenHidden: (() => void) | undefined;
    let unlistenWillHide: (() => void) | undefined;
    let disposed = false;

    (async () => {
      const offSignout = await listen("tray-signout", () => {
        if (emailRef.current) setConfirmSignOut(true);
      });
      const offHidden = await listen("window-hidden", async () => {
        if (!emailRef.current) return; // only when a session is open
        hiddenAt.current = Date.now();
        // Set at once, before the page is put to sleep in the tray: what was on screen never
        // shows again before the lock does.
        const known = lockPrefs.current;
        if (known.after === 0 && known.hello) setHelloLocked(true);
        else if (known.after > 0 && (known.hello || known.password)) document.documentElement.classList.add(VEIL);
        const prefs = await readLockPrefs();
        keepLockPrefs(prefs);
        if (prefs.after === 0) {
          pendingLock.current = lockNow();
          await pendingLock.current;
        }
      });
      // Before the window goes to the tray: the page covers itself first, then lets it go.
      const offWillHide = await listen("window-will-hide", async () => {
        await coverNow("tray");
        void invoke("page_covered").catch(() => {});
      });

      if (disposed) {
        offSignout();
        offHidden();
        offWillHide();
        return;
      }
      unlistenWillHide = offWillHide;
      unlistenSignout = offSignout;
      unlistenHidden = offHidden;
    })();

    return () => {
      disposed = true;
      unlistenSignout?.();
      unlistenHidden?.();
      unlistenWillHide?.();
    };
  }, []);

  /** Keeps the lock settings as last read; with a lock, the taskbar preview shows only the icon. */
  function keepLockPrefs(prefs: LockPrefs) {
    const locks = prefs.hello || prefs.password;
    if (locks !== (lockPrefs.current.hello || lockPrefs.current.password) || !previewSet.current) {
      previewSet.current = true;
      void invoke("set_private_preview", { on: locks }).catch(() => {});
    }
    lockPrefs.current = prefs;
  }

  /**
   * Covers the app before its window goes away, when a lock is set for that way out: the lock
   * screen when it locks right away with Windows Hello, a blank sheet otherwise until the lock is
   * known, painted before the window goes. Answers whether it covered.
   */
  async function coverNow(why: "tray" | "minimize"): Promise<boolean> {
    if (!emailRef.current) return false;
    const prefs = await readLockPrefs();
    keepLockPrefs(prefs);
    if (!prefs.hello && !prefs.password) return false;
    if (why === "minimize" && !prefs.minimized) return false;
    hiddenAt.current = Date.now();
    if (prefs.after === 0 && prefs.hello) flushSync(() => setHelloLocked(true));
    else document.documentElement.classList.add(VEIL);
    await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
    if (why === "minimize" && prefs.after === 0) pendingLock.current = lockNow();
    return true;
  }

  useEffect(() => {
    setAppCover(async (why) => {
      await coverNow(why);
    });
    return () => setAppCover(null);
    // Reads everything through refs and state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Locks the app the way its owner chose: a vault with a password forgets its key and asks for
   * the password again; otherwise Windows Hello is asked before the photos show again.
   */
  async function lockNow() {
    const current = emailRef.current;
    if (!current) return;
    const prefs = lockPrefs.current;
    if (prefs.password) {
      // A vault this Windows account opens has no password to lock behind.
      const vault = await rpc<LockStatus>("lockStatus").catch(() => null);
      if (vault?.mode !== "device") {
        await rpc("lock").catch(() => {});
        // Remember the email so the lock screen can greet the same account.
        setLocked({ email: current });
        setEmail(null);
        return;
      }
    }
    if (prefs.hello) setHelloLocked(true);
  }

  // Locking after a while: so long without a touch of the mouse or the keyboard, or so long in
  // the tray, counted when the window comes back.
  useEffect(() => {
    const used = () => {
      lastUsed.current = Date.now();
    };
    const events = ["pointerdown", "pointermove", "keydown", "wheel"] as const;
    for (const name of events) window.addEventListener(name, used, { passive: true });
    const back = async () => {
      if (document.visibilityState !== "visible") return;
      const since = hiddenAt.current;
      hiddenAt.current = 0;
      const prefs = lockPrefs.current;
      if (pendingLock.current) await pendingLock.current;
      pendingLock.current = null;
      if (since && prefs.after > 0 && Date.now() - since >= prefs.after * 1000) await lockNow();
      document.documentElement.classList.remove(VEIL);
      lastUsed.current = Date.now();
    };
    // Minimised counts as put away too when its owner asked for that: right away it locks, later
    // it waits. The tray has its own event, above.
    const win = getCurrentWindow();
    const minimized = async () => {
      const prefs = lockPrefs.current;
      if (!emailRef.current || hiddenAt.current || !prefs.minimized || (!prefs.hello && !prefs.password)) return;
      if (!(await win.isMinimized().catch(() => false))) return;
      hiddenAt.current = Date.now();
      if (prefs.after === 0) void lockNow();
      else document.documentElement.classList.add(VEIL);
    };
    const shown = () => {
      if (document.visibilityState === "hidden") void minimized();
      else void back();
    };
    const offResized = win.onResized(() => void minimized());
    document.addEventListener("visibilitychange", shown);
    window.addEventListener("focus", back);
    const timer = window.setInterval(async () => {
      if (!emailRef.current || document.visibilityState !== "visible") return;
      const prefs = await readLockPrefs();
      keepLockPrefs(prefs);
      if (prefs.after > 0 && (prefs.hello || prefs.password) && Date.now() - lastUsed.current >= prefs.after * 1000) {
        lastUsed.current = Date.now();
        await lockNow();
      }
    }, IDLE_LOOK_MS);
    return () => {
      for (const name of events) window.removeEventListener(name, used);
      document.removeEventListener("visibilitychange", shown);
      window.removeEventListener("focus", back);
      void offResized.then((off) => off());
      window.clearInterval(timer);
    };
    // Reads everything through refs and state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // What a right-click on the app itself offers, as opposed to on a photo or an
  // album. Reloading is the whole of it for now, and the placeholder says so
  // rather than leaving a menu of one.
  const shellActions: MenuAction[] = [
    {
      key: "reload",
      label: t("menu.reload"),
      // Signed in, the page is read again where it is; before that there is nothing to keep.
      onSelect: () => (emailRef.current ? window.dispatchEvent(new Event("pfp-refresh")) : window.location.reload()),
    },
    { key: "moreSoon", label: t("menu.moreSoon"), disabled: true, onSelect: () => {} },
  ];

  return (
    <div className="app-shell">
      <Titlebar />
      <UpdateOverlay />

      {restoring ? (
        <div className="app-content">
          <p className="login-sub">{t("app.restoring")}</p>
        </div>
      ) : locked ? (
        <Lock
          email={locked.email}
          onResult={(r) => {
            setLocked(null);
            void applyResult(r);
          }}
          onDifferentAccount={() => {
            setLocked(null);
            setPhase("credentials");
            setStatus("");
          }}
        />
      ) : email && helloLocked ? (
        <AppLock onUnlock={() => setHelloLocked(false)} />
      ) : email && legacy === null ? (
        <div className="app-content">
          <p className="login-sub">{t("app.restoring")}</p>
        </div>
      ) : email && legacy ? (
        <div className="app-content">
          <LoginCard phase="move">
            <h1 className="login-title">Photos for Proton</h1>
            <p className="login-sub">{t("move.title")}</p>
            <form className="login-form" onSubmit={onMove}>
              <p className="login-hint">{t("move.intro")}</p>
              {helloReady && (
                <label className="login-choice">
                  <input
                    type="radio"
                    name="move"
                    checked={moveChoice === "hello"}
                    onChange={() => setMoveChoice("hello")}
                  />
                  <span>
                    <strong>{t("protect.hello")}</strong>
                    <small>{t("protect.helloDesc")}</small>
                  </span>
                </label>
              )}
              <label className="login-choice">
                <input
                  type="radio"
                  name="move"
                  checked={moveChoice === "password"}
                  onChange={() => setMoveChoice("password")}
                />
                <span>
                  <strong>{t("move.keep")}</strong>
                  <small>{t("move.keepDesc")}</small>
                </span>
              </label>
              <label className="login-choice">
                <input
                  type="radio"
                  name="move"
                  checked={moveChoice === "device"}
                  onChange={() => setMoveChoice("device")}
                />
                <span>
                  <strong>{t("protect.device")}</strong>
                  <small>{t(isWindows ? "protect.deviceDesc" : "protect.deviceDescLinux")}</small>
                </span>
              </label>
              <button type="submit" disabled={busy}>
                {t("protect.continue")}
              </button>
              <p className="login-hint">{t("move.signOutNote")}</p>
            </form>
            {status && <p className="login-status">{shownStatus}</p>}
          </LoginCard>
        </div>
      ) : email ? (
        <Photos
          key={libraryKey}
          email={email}
          offline={offlineLibrary}
          onSignOut={() => setConfirmSignOut(true)}
        />
      ) : (
        <div className="app-content">
          <LoginCard phase={phase === "protect" ? `protect-${protectStep}` : phase}>
            <h1 className="login-title">Photos for Proton</h1>
            <p className="login-sub">{t("login.subtitle")}</p>

            {/* One button for the whole sign-in: it starts it, spins while the browser is
                out, and after a few seconds offers to open the page again. The line under it
                keeps one height for both of its texts, so the card does not move. */}
            {(phase === "credentials" || phase === "browser") && (
              <form className="login-form" onSubmit={phase === "browser" ? onReopenSignIn : onBrowserSignIn}>
                <button type="submit" disabled={busy || (phase === "browser" && !reopenReady && !openFailed)}>
                  {(busy || phase === "browser") && (
                    <span className="login-spin">
                      <SpinnerIcon size={16} />
                    </span>
                  )}
                  {phase !== "browser"
                    ? t("login.withBrowser")
                    : openFailed
                      ? t(copied ? "login.browserCopied" : "login.browserCopy")
                      : reopenReady
                        ? t("login.browserOpenAgain")
                        : t("login.withBrowser")}
                </button>
                <div className="login-stack">
                  <p
                    className={phase === "credentials" ? "login-hint login-safe login-pane on" : "login-hint login-safe login-pane"}
                    aria-hidden={phase !== "credentials"}
                  >
                    <LockIcon size={13} />
                    {t("login.withBrowserHint")}
                  </p>
                  <p
                    className={phase === "browser" ? "login-hint login-pane on" : "login-hint login-pane"}
                    aria-hidden={phase !== "browser"}
                  >
                    {t("login.browserWaiting")}{" "}
                    <button
                      type="button"
                      className="link login-inline"
                      tabIndex={phase === "browser" ? 0 : -1}
                      onClick={() => void cancelBrowserSignIn()}
                    >
                      {t("common.cancel")}
                    </button>
                  </p>
                </div>
              </form>
            )}

            {phase === "offline" && (
              <div className="login-form">
                <p className="login-hint">{t("login.offline")}</p>
                <button type="button" className="login-secondary" disabled={busy} onClick={() => void retryResume()}>
                  {busy ? t("login.verifying") : t("login.retry")}
                </button>
              </div>
            )}

            {phase === "protect" && protectStep === "choose" && (
              <form className="login-form" onSubmit={onProtect}>
                <p className="login-hint">{t("protect.intro")}</p>
                {helloReady && (
                  <label className="login-choice">
                    <input
                      type="radio"
                      name="protection"
                      checked={protection === "hello"}
                      onChange={() => setProtection("hello")}
                    />
                    <span>
                      <strong>{t("protect.hello")}</strong>
                      <small>{t("protect.helloDesc")}</small>
                    </span>
                  </label>
                )}
                <label className="login-choice">
                  <input
                    type="radio"
                    name="protection"
                    checked={protection === "password"}
                    onChange={() => setProtection("password")}
                  />
                  <span>
                    <strong>{t("protect.password")}</strong>
                    <small>{t("protect.passwordDesc")}</small>
                  </span>
                </label>
                <label className="login-choice">
                  <input
                    type="radio"
                    name="protection"
                    checked={protection === "device"}
                    onChange={() => setProtection("device")}
                  />
                  <span>
                    <strong>{t("protect.device")}</strong>
                    <small>{t(isWindows ? "protect.deviceDesc" : "protect.deviceDescLinux")}</small>
                  </span>
                </label>
                <button type="submit" disabled={busy}>
                  {t("protect.continue")}
                </button>
              </form>
            )}

            {phase === "protect" && protectStep === "password" && (
              <>
                <button
                  type="button"
                  className="login-back"
                  onClick={() => {
                    setProtectStep("choose");
                    setStatus("");
                  }}
                  title={t("common.back")}
                  aria-label={t("common.back")}
                >
                  <ChevronLeftIcon />
                </button>
                <form className="login-form" onSubmit={onProtect}>
                  <p className="login-hint">{t("protect.passwordDesc")}</p>
                  <label>
                    <span>{t("protect.newPassword")}</span>
                    <input
                      type="password"
                      autoComplete="new-password"
                      autoFocus
                      value={appPassword}
                      onChange={(e) => setAppPassword(e.currentTarget.value)}
                    />
                  </label>
                  <label>
                    <span>{t("protect.repeatPassword")}</span>
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={appPassword2}
                      onChange={(e) => setAppPassword2(e.currentTarget.value)}
                    />
                  </label>
                  <button type="submit" disabled={busy}>
                    {t("protect.continue")}
                  </button>
                </form>
              </>
            )}

            {status && <p className="login-status">{shownStatus}</p>}
            {(phase === "credentials" || phase === "browser") && <p className="login-note">{t("login.unofficial")}</p>}
          </LoginCard>
        </div>
      )}

      {confirmSignOut && (
        <SignOutConfirm
          onConfirm={() => {
            setConfirmSignOut(false);
            void signOut();
          }}
          onCancel={() => setConfirmSignOut(false)}
        />
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} actions={shellActions} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}

export default App;
