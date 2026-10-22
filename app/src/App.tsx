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

import { ChevronLeftIcon, LockIcon } from "./components/icons";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Titlebar } from "./components/Titlebar";
import { UpdateOverlay } from "./components/UpdateOverlay";
import { ContextMenu, type MenuAction } from "./components/ContextMenu";
import { Photos } from "./views/Photos";
import { Lock } from "./views/Lock";
import { SignOutConfirm } from "./components/SignOutConfirm";
import { rpc } from "./lib/rpc";
import { applyTheme, type ThemeMode } from "./lib/theme";
import { useT } from "./lib/i18n";
import "./styles/App.css";

type Phase = "credentials" | "twofa" | "captcha" | "browser" | "protect" | "offline";
type MenuState = { x: number; y: number } | null;
type LoginResult =
  | { status: "ok"; email: string }
  | { status: "2fa" }
  | { status: "hv"; url: string }
  | { status: "protect"; email: string }
  | { status: "relogin" }
  | { status: "offline" }
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
const BROWSER_POLL_MS = 1500;
/** As the sidecar requires of a password of the user's own. */
const MIN_APP_PASSWORD = 8;

function App() {
  const t = useT();
  const [restoring, setRestoring] = useState(true);
  const [email, setEmail] = useState<string | null>(null);
  // Set when a saved (encrypted) account exists but is still locked: the app
  // shows the lock screen and waits for the password before anything else.
  const [locked, setLocked] = useState<{ email: string | null } | null>(null);
  const [phase, setPhase] = useState<Phase>("credentials");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [menu, setMenu] = useState<MenuState>(null);
  const [hvUrl, setHvUrl] = useState<string | null>(null);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [passwordForm, setPasswordForm] = useState(false);
  const [browserUrl, setBrowserUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [protection, setProtection] = useState<"password" | "device">("password");
  const [appPassword, setAppPassword] = useState("");
  const [appPassword2, setAppPassword2] = useState("");
  const captchaBoxRef = useRef<HTMLDivElement>(null);
  // The tray listeners register once on mount, so they read the live email
  // through this ref instead of a stale closure captured at registration.
  const emailRef = useRef<string | null>(null);

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
  async function decideSession() {
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
    void decideSession();
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
      setPassword("");
      setEmail(r.email);
    } else if (r.status === "2fa") {
      setPhase("twofa");
    } else if (r.status === "hv") {
      setHvUrl(r.url);
      setPhase("captcha");
    } else if (r.status === "protect") {
      setPhase("protect");
    } else if (r.status === "relogin") {
      setPhase("credentials");
      setStatus(t("login.sessionEnded"));
    } else if (r.status === "offline") {
      setLocked(null);
      setPhase("offline");
    } else {
      setStatus(r.error);
    }
  }

  // Proton's captcha page refuses to be iframed, so the Rust host lays a child
  // webview over this box, inside the same window, and relays the result.
  useEffect(() => {
    if (phase !== "captcha" || !hvUrl) return;
    const box = captchaBoxRef.current;
    if (!box) return;

    let unlisten: (() => void) | undefined;
    let disposed = false;

    (async () => {
      const stop = await listen<{ type: string; token: string }>("captcha", async ({ payload }) => {
        if (payload.type === "pm_captcha_expired") {
          setStatus(t("login.captchaExpired"));
          return;
        }
        if (payload.type !== "pm_captcha" || !payload.token) return;

        setBusy(true);
        setStatus("");
        try {
          await invoke("close_captcha").catch(() => {});
          await applyResult(await rpc<LoginResult>("submitCaptcha", { token: payload.token }));
        } catch (err) {
          setStatus(String(err));
        }
        setBusy(false);
      });

      if (disposed) {
        stop();
        return;
      }
      unlisten = stop;

      const r = box.getBoundingClientRect();
      await invoke("open_captcha", {
        url: hvUrl,
        x: r.left,
        y: r.top,
        width: r.width,
        height: r.height,
      }).catch((err) => setStatus(String(err)));
    })();

    return () => {
      disposed = true;
      unlisten?.();
      invoke("close_captcha").catch(() => {});
    };
  }, [phase, hvUrl]);

  // The child webview floats at absolute coordinates, so it has to be told
  // whenever its placeholder moves: window resize, maximise, or a scroll.
  useEffect(() => {
    if (phase !== "captcha" || !hvUrl) return;
    const box = captchaBoxRef.current;
    if (!box) return;

    let frame = 0;
    const sync = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const r = box.getBoundingClientRect();
        invoke("move_captcha", {
          x: r.left,
          y: r.top,
          width: r.width,
          height: r.height,
        }).catch(() => {});
      });
    };

    const observer = new ResizeObserver(sync);
    observer.observe(box);
    window.addEventListener("resize", sync);
    const scroller = document.querySelector(".app-content");
    scroller?.addEventListener("scroll", sync, { passive: true });

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", sync);
      scroller?.removeEventListener("scroll", sync);
    };
  }, [phase, hvUrl]);

  /** Opens Proton's sign-in page in the browser and waits for it here. */
  async function onBrowserSignIn(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setStatus("");
    try {
      const { url } = await rpc<{ url: string }>("startBrowserLogin");
      setBrowserUrl(url);
      setCopied(false);
      setPhase("browser");
      await invoke("open_sign_in_page", { url }).catch(() => setStatus(t("login.browserNotOpened")));
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

  // While the browser sign-in is open: ask now and then whether Proton has answered.
  useEffect(() => {
    if (phase !== "browser") return;
    let stopped = false;
    let timer = 0;
    const ask = async () => {
      let r: BrowserStatus;
      try {
        r = await rpc<BrowserStatus>("browserLoginStatus");
      } catch (err) {
        r = { status: "error", error: String(err) };
      }
      if (stopped) return;
      if (r.status === "waiting") {
        timer = window.setTimeout(ask, BROWSER_POLL_MS);
        return;
      }
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
    timer = window.setTimeout(ask, BROWSER_POLL_MS);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
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
  }, [phase]);

  async function copySignInLink() {
    if (!browserUrl) return;
    try {
      await navigator.clipboard.writeText(browserUrl);
      setCopied(true);
    } catch {
      /* the link stays on offer through the button */
    }
  }

  /** Seals the browser sign-in the way the user picked. */
  async function onProtect(e: FormEvent) {
    e.preventDefault();
    setStatus("");
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
    setBusy(true);
    try {
      const r = await rpc<LoginResult>("protectSession", {
        password: protection === "password" ? appPassword : null,
      });
      if (r.status === "ok") {
        setAppPassword("");
        setAppPassword2("");
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

  async function onSignIn(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setStatus("");
    try {
      await applyResult(await rpc<LoginResult>("login", { username, password }));
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
    setPhase("credentials");
    setPasswordForm(false);
    setUsername("");
    setPassword("");
    setCode("");
    setStatus("");
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
    let disposed = false;

    (async () => {
      const offSignout = await listen("tray-signout", () => {
        if (emailRef.current) setConfirmSignOut(true);
      });
      const offHidden = await listen("window-hidden", async () => {
        const current = emailRef.current;
        if (!current) return; // only when a session is open
        let lockOnHide = false;
        try {
          const raw = await invoke<string | null>("store_get", { name: "settings" });
          if (raw) lockOnHide = (JSON.parse(raw) as { lockOnHide?: boolean }).lockOnHide === true;
        } catch {
          /* leave it unlocked if the setting cannot be read */
        }
        if (!lockOnHide) return;
        // A vault this Windows account opens has no password to lock behind.
        const vault = await rpc<LockStatus>("lockStatus").catch(() => null);
        if (vault?.mode === "device") return;
        await rpc("lock").catch(() => {});
        // Remember the email so the lock screen can greet the same account.
        setLocked({ email: current });
        setEmail(null);
      });

      if (disposed) {
        offSignout();
        offHidden();
        return;
      }
      unlistenSignout = offSignout;
      unlistenHidden = offHidden;
    })();

    return () => {
      disposed = true;
      unlistenSignout?.();
      unlistenHidden?.();
    };
  }, []);

  async function onSubmitCode(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setStatus("");
    try {
      await applyResult(await rpc<LoginResult>("submit2fa", { code }));
    } catch (err) {
      setStatus(String(err));
    }
    setBusy(false);
  }

  // What a right-click on the app itself offers, as opposed to on a photo or an
  // album. Reloading is the whole of it for now, and the placeholder says so
  // rather than leaving a menu of one.
  const shellActions: MenuAction[] = [
    { key: "reload", label: t("menu.reload"), onSelect: () => window.location.reload() },
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
            setUsername("");
            setPassword("");
            setStatus("");
          }}
        />
      ) : email ? (
        <Photos email={email} onSignOut={() => setConfirmSignOut(true)} />
      ) : (
        <div className="app-content">
          <div className={phase === "captcha" ? "login-card wide" : "login-card"}>
            <h1 className="login-title">Photos for Proton</h1>
            <p className="login-sub">{t("login.subtitle")}</p>

            {phase === "credentials" && !passwordForm && (
              <form className="login-form" onSubmit={onBrowserSignIn}>
                <button type="submit" disabled={busy}>
                  {t("login.withBrowser")}
                </button>
                <p className="login-hint login-safe">
                  <LockIcon size={13} />
                  {t("login.withBrowserHint")}
                </p>
                <button type="button" className="login-secondary" onClick={() => setPasswordForm(true)}>
                  {t("login.withPassword")}
                </button>
              </form>
            )}

            {/* Email and password in place of the browser's way in, not under it: one way at a
                time, with the way back at the top and the other way at the foot. */}
            {phase === "credentials" && passwordForm && (
              <button
                type="button"
                className="login-back"
                onClick={() => setPasswordForm(false)}
                title={t("common.back")}
                aria-label={t("common.back")}
              >
                <ChevronLeftIcon />
              </button>
            )}

            {phase === "credentials" && passwordForm && (
              <form className="login-form" onSubmit={onSignIn}>
                <label>
                  <span>{t("login.emailLabel")}</span>
                  <input
                    type="text"
                    autoComplete="username"
                    value={username}
                    onChange={(e) => setUsername(e.currentTarget.value)}
                    placeholder="you@proton.me"
                    required
                  />
                </label>
                <label>
                  <span>{t("login.passwordLabel")}</span>
                  <input
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.currentTarget.value)}
                    placeholder={t("login.passwordPlaceholder")}
                    required
                  />
                </label>
                <button type="submit" disabled={busy}>
                  {busy ? t("login.signingIn") : t("login.signIn")}
                </button>
                <button type="button" className="link" onClick={() => setPasswordForm(false)}>
                  {t("login.withBrowserInstead")}
                </button>
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

            {phase === "browser" && (
              <div className="login-form">
                <p className="login-hint">{t("login.browserWaiting")}</p>
                <button type="button" className="login-secondary" onClick={() => browserUrl && void invoke("open_sign_in_page", { url: browserUrl }).catch(() => {})}>
                  {t("login.browserOpenAgain")}
                </button>
                <button type="button" className="login-secondary" onClick={() => void copySignInLink()}>
                  {copied ? t("login.browserCopied") : t("login.browserCopy")}
                </button>
                <button type="button" className="link" onClick={() => void cancelBrowserSignIn()}>
                  {t("common.cancel")}
                </button>
              </div>
            )}

            {phase === "protect" && (
              <form className="login-form" onSubmit={onProtect}>
                <p className="login-hint">{t("protect.intro")}</p>
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
                {protection === "password" && (
                  <>
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
                  </>
                )}
                <label className="login-choice">
                  <input
                    type="radio"
                    name="protection"
                    checked={protection === "device"}
                    onChange={() => setProtection("device")}
                  />
                  <span>
                    <strong>{t("protect.device")}</strong>
                    <small>{t("protect.deviceDesc")}</small>
                  </span>
                </label>
                <button type="submit" disabled={busy}>
                  {t("protect.continue")}
                </button>
              </form>
            )}

            {phase === "twofa" && (
              <form className="login-form" onSubmit={onSubmitCode}>
                <label>
                  <span>{t("login.twofaLabel")}</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    autoFocus
                    value={code}
                    onChange={(e) => setCode(e.currentTarget.value)}
                    placeholder="123456"
                    required
                  />
                </label>
                <button type="submit" disabled={busy}>
                  {busy ? t("login.verifying") : t("login.verify")}
                </button>
                <button type="button" className="link" onClick={() => setPhase("credentials")}>
                  {t("common.back")}
                </button>
              </form>
            )}

            {phase === "captcha" && hvUrl && (
              <div className="captcha">
                <p className="captcha-hint">{t("login.captchaHint")}</p>
                <div ref={captchaBoxRef} className="captcha-frame" />
                {busy && <p className="captcha-hint">{t("login.verifying")}</p>}
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    setPhase("credentials");
                    setHvUrl(null);
                    setStatus("");
                  }}
                >
                  {t("common.back")}
                </button>
              </div>
            )}

            {status && <p className="login-status">{status}</p>}
            {phase === "credentials" && <p className="login-note">{t("login.unofficial")}</p>}
          </div>
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
