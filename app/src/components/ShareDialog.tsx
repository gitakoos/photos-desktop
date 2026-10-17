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

// The one dialog behind every Share action: a photo's public link, and the people
// invited to a photo or an album. The sidecar settles what may be offered for a
// given node, so this only ever draws what the server would accept.
//
// The link's URL carries its own decryption secret in the fragment, which is why
// it is copied whole and shown whole, and why neither it nor the addresses below
// are ever written anywhere but this window. A link's password is the one secret
// that travels the other way: it is typed here, sent once, and never read back,
// so the dialog only ever learns whether a password exists, not what it is.
//
// Keys are grabbed in the capture phase the way `Confirm` does, so Escape closes
// this dialog rather than also closing the lightbox behind it.

import { useCallback, useEffect, useState } from "react";
import { rpc } from "../lib/rpc";
import { useT, type TFunc } from "../lib/i18n";
import { locale } from "../lib/format";
import { Confirm } from "./Confirm";
import { CloseIcon, PersonAddIcon } from "./icons";
import "../styles/Confirm.css";
import "../styles/ShareDialog.css";

type Role = "viewer" | "editor";

type SharePerson = {
  uid: string;
  email: string;
  role: string;
  state: "member" | "invited" | "external";
};

type PublicLink = {
  url: string;
  role: string;
  creationTime: number;
  expirationTime: number | null;
  hasCustomPassword: boolean;
  canUpdate: boolean;
};

export type SharingInfo = {
  uid: string;
  canShare: boolean;
  supportsPublicLink: boolean;
  publicLink: PublicLink | null;
  people: SharePerson[];
  /** A share exists, whether or not a link or an invitation sits on it yet. */
  isShared: boolean;
};

/** Enough to catch a typo before the server does; the server is the real judge. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * A date field speaks in local `YYYY-MM-DD` and a link's expiry in millis. A day
 * picked here is meant to be a day the link still works, so it is read as ending
 * when that day does rather than at the midnight that opens it.
 */
const toDateField = (ms: number): string => {
  const at = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
};

const fromDateField = (value: string): number => {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day, 23, 59, 59, 999).getTime();
};

const showDate = (ms: number): string =>
  new Date(ms).toLocaleDateString(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

/**
 * The sidecar's refusals, which name nothing about the node. Anything else is
 * reported in general terms on purpose: the SDK quotes uids and addresses in its
 * messages, and none of that belongs on screen.
 */
function messageFor(t: TFunc, e: unknown): string {
  const s = String(e);
  if (s.includes("SHARE_NOT_OWNED")) return t("share.notOwned");
  if (s.includes("SHARE_NO_ALBUM_LINK")) return t("share.albumInviteOnly");
  return t("share.failed");
}

export function ShareDialog({
  uid,
  title,
  onClose,
  onChanged,
}: {
  uid: string;
  /** The node's name, shown as the subtitle so it is clear what is being shared. */
  title: string;
  onClose: () => void;
  /** A share was created or revoked, so any list showing it is now stale. */
  onChanged?: () => void;
}) {
  const t = useT();
  const [info, setInfo] = useState<SharingInfo | null>(null);
  const [loading, setLoading] = useState(true);
  /**
   * Which call is in flight. One mutation at a time is the rule, but the reason
   * it is held by name is that several of the buttons below are the same call,
   * and only the one that started it may say it is working.
   */
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [draftEmail, setDraftEmail] = useState("");
  const [draftRole, setDraftRole] = useState<Role>("viewer");
  /** Which of the link's settings is open for editing, if any. */
  const [editing, setEditing] = useState<"password" | "expiry" | null>(null);
  const [draftPassword, setDraftPassword] = useState("");
  const [draftExpiry, setDraftExpiry] = useState("");
  const [confirming, setConfirming] = useState<"link" | "all" | null>(null);
  /**
   * A settings change waiting on an answer, because the link it would change cannot
   * be changed: see `updateLink` below.
   */
  const [replacing, setReplacing] = useState<{
    params: Record<string, unknown>;
    then?: () => void;
    tag: string;
  } | null>(null);

  const busy = !!pending;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      e.stopPropagation();
      if (e.key === "Escape" && !confirming && !replacing) onClose();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, confirming, replacing]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const state = await rpc<SharingInfo>("getSharingInfo", { uid });
        if (!cancelled) setInfo(state);
      } catch (e) {
        if (!cancelled) setError(messageFor(t, e));
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid]);

  const copy = useCallback(
    async (url: string) => {
      try {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      } catch {
        setError(t("share.copyFailed"));
      }
    },
    [t],
  );

  /**
   * Every mutation answers with the whole new state, so they all land the same
   * way. `tag` is what the running call is known as while it is in flight, and
   * defaults to the method: three of the buttons below are all `setPublicLink`,
   * and each has to be able to tell its own work from the other two's.
   */
  async function run(
    method: string,
    params: Record<string, unknown>,
    then?: (s: SharingInfo) => void,
    tag: string = method,
  ) {
    if (busy) return;
    setPending(tag);
    setError("");
    try {
      const state = await rpc<SharingInfo>(method, { uid, ...params });
      setInfo(state);
      onChanged?.();
      then?.(state);
    } catch (e) {
      setError(messageFor(t, e));
    }
    setPending("");
  }

  // The URL carries the secret that decrypts what it points at, and Windows keeps a
  // clipboard history it will sync off the machine given the chance, so the link is put
  // there when the user asks for it and not a moment before. Copy, below, is that ask.
  const createLink = () => run("setPublicLink", {});

  /**
   * Changes one of the link's settings.
   *
   * A link made before Drive generated its own secrets cannot be amended: saving
   * anything against one drops it and creates a fresh link in its place, at a different
   * address and with no password on it. `canUpdate` is what the sidecar calls that, and
   * the cost is entirely the user's to weigh, so the change waits here for an answer.
   */
  function updateLink(params: Record<string, unknown>, then?: () => void, tag = "setPublicLink") {
    if (link && !link.canUpdate) {
      setReplacing({ params, then, tag });
      return;
    }
    void run("setPublicLink", params, then, tag);
  }

  /** Opens one of the link's settings, the expiry seeded with the date it holds. */
  function edit(which: "password" | "expiry") {
    setError("");
    setDraftPassword("");
    setDraftExpiry(info?.publicLink?.expirationTime ? toDateField(info.publicLink.expirationTime) : "");
    setEditing(which);
  }

  function stopEditing() {
    setDraftPassword("");
    setEditing(null);
  }

  // Sent exactly as typed: a password is a secret, and trimming it would quietly
  // set something other than what was read off the screen.
  function savePassword() {
    if (!draftPassword) return;
    updateLink({ customPassword: draftPassword }, stopEditing, "savePassword");
  }

  function saveExpiry() {
    if (!draftExpiry) return;
    const at = fromDateField(draftExpiry);
    if (!Number.isFinite(at) || at <= Date.now()) {
      setError(t("share.expiryPast"));
      return;
    }
    updateLink({ expiration: at }, () => setEditing(null), "saveExpiry");
  }

  function invite() {
    const email = draftEmail.trim();
    if (!email) return;
    if (!EMAIL_SHAPE.test(email)) {
      setError(t("share.badEmail"));
      return;
    }
    void run("invitePeople", { emails: [email], role: draftRole }, () => setDraftEmail(""));
  }

  const link = info?.publicLink ?? null;
  const people = info?.people ?? [];
  // The share itself counts, not only what is on it: one that carries neither a
  // link nor a person is still a share, and stopping it is the only way out.
  const isShared = !!link || people.length > 0 || !!info?.isShared;

  const stateLabel = (person: SharePerson): string =>
    person.state === "member"
      ? t(person.role === "editor" ? "share.roleEditor" : "share.roleViewer")
      : person.state === "external"
        ? t("share.stateExternal")
        : t("share.stateInvited");

  return (
    <div
      className="cf-backdrop"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div className="cf-panel sh-panel" role="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="sh-head">
          <div>
            <h3 className="cf-title sh-title">{t("share.title")}</h3>
            <p className="sh-subtitle">{title}</p>
          </div>
          <button className="sh-close" onClick={onClose} title={t("common.close")}>
            <CloseIcon size={14} />
          </button>
        </div>

        {loading && <p className="sh-dim">{t("common.loading")}</p>}

        {!loading && info && !info.canShare && <p className="sh-dim">{t("share.notOwned")}</p>}

        {!loading && info?.canShare && (
          <>
            {info.supportsPublicLink ? (
              <section className="sh-section">
                <h4 className="sh-heading">{t("share.linkTitle")}</h4>
                {link ? (
                  <>
                    <div className="sh-linkrow">
                      <input className="sh-url" readOnly value={link.url} onFocus={(e) => e.currentTarget.select()} />
                      <button className="cf-btn primary" disabled={busy} onClick={() => void copy(link.url)}>
                        {copied ? t("share.copied") : t("share.copyLink")}
                      </button>
                    </div>
                    <p className="sh-note">{t("share.linkDesc")}</p>

                    <div className="sh-settings">
                      <div className="sh-setting">
                        <span className="sh-setting-name">{t("share.passwordLabel")}</span>
                        {editing === "password" ? (
                          <>
                            <input
                              className="sh-secret"
                              type="password"
                              autoFocus
                              value={draftPassword}
                              placeholder={t("share.passwordPlaceholder")}
                              disabled={busy}
                              onChange={(e) => setDraftPassword(e.currentTarget.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") savePassword();
                              }}
                            />
                            <button className="sh-mini" disabled={busy || !draftPassword} onClick={savePassword}>
                              {pending === "savePassword" ? t("share.working") : t("share.save")}
                            </button>
                            <button className="sh-mini" disabled={busy} onClick={stopEditing}>
                              {t("common.cancel")}
                            </button>
                          </>
                        ) : (
                          <>
                            <span className="sh-setting-value">
                              {link.hasCustomPassword ? t("share.passwordSet") : t("share.passwordNone")}
                            </span>
                            <button className="sh-mini" disabled={busy} onClick={() => edit("password")}>
                              {link.hasCustomPassword ? t("share.change") : t("share.add")}
                            </button>
                            {link.hasCustomPassword && (
                              <button
                                className="sh-linkbtn"
                                disabled={busy}
                                onClick={() => updateLink({ customPassword: null })}
                              >
                                {t("share.remove")}
                              </button>
                            )}
                          </>
                        )}
                      </div>

                      <div className="sh-setting">
                        <span className="sh-setting-name">{t("share.expiryLabel")}</span>
                        {editing === "expiry" ? (
                          <>
                            <input
                              className="sh-date"
                              type="date"
                              autoFocus
                              value={draftExpiry}
                              min={toDateField(Date.now())}
                              disabled={busy}
                              onChange={(e) => setDraftExpiry(e.currentTarget.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") saveExpiry();
                              }}
                            />
                            <button className="sh-mini" disabled={busy || !draftExpiry} onClick={saveExpiry}>
                              {pending === "saveExpiry" ? t("share.working") : t("share.save")}
                            </button>
                            <button className="sh-mini" disabled={busy} onClick={() => setEditing(null)}>
                              {t("common.cancel")}
                            </button>
                          </>
                        ) : (
                          <>
                            <span className="sh-setting-value">
                              {link.expirationTime ? showDate(link.expirationTime) : t("share.expiryNever")}
                            </span>
                            <button className="sh-mini" disabled={busy} onClick={() => edit("expiry")}>
                              {link.expirationTime ? t("share.change") : t("share.set")}
                            </button>
                            {!!link.expirationTime && (
                              <button
                                className="sh-linkbtn"
                                disabled={busy}
                                onClick={() => updateLink({ expiration: null })}
                              >
                                {t("share.remove")}
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </div>

                    <button className="sh-linkbtn" disabled={busy} onClick={() => setConfirming("link")}>
                      {t("share.removeLink")}
                    </button>
                  </>
                ) : (
                  <>
                    <p className="sh-note">{t("share.linkDesc")}</p>
                    <button className="cf-btn primary" disabled={busy} onClick={() => void createLink()}>
                      {pending === "setPublicLink" ? t("share.working") : t("share.createLink")}
                    </button>
                  </>
                )}
              </section>
            ) : (
              <p className="sh-note">{t("share.albumInviteOnly")}</p>
            )}

            <section className="sh-section">
              <h4 className="sh-heading">{t("share.peopleTitle")}</h4>
              <div className="sh-invite">
                <input
                  className="sh-email"
                  type="email"
                  value={draftEmail}
                  placeholder={t("share.emailPlaceholder")}
                  disabled={busy}
                  onChange={(e) => setDraftEmail(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") invite();
                  }}
                />
                <select
                  className="sh-role"
                  value={draftRole}
                  disabled={busy}
                  onChange={(e) => setDraftRole(e.currentTarget.value as Role)}
                >
                  <option value="viewer">{t("share.roleViewer")}</option>
                  <option value="editor">{t("share.roleEditor")}</option>
                </select>
                <button className="sh-add" disabled={busy || !draftEmail.trim()} onClick={invite} title={t("share.invite")}>
                  <PersonAddIcon size={15} />
                </button>
              </div>

              {people.length === 0 ? (
                <p className="sh-dim sh-nobody">{t("share.noPeople")}</p>
              ) : (
                <ul className="sh-people">
                  {people.map((person) => (
                    <li className="sh-person" key={person.uid}>
                      <span className="sh-email-text">{person.email}</span>
                      <span className="sh-state">{stateLabel(person)}</span>
                      <button
                        className="sh-linkbtn"
                        disabled={busy}
                        onClick={() => void run("removePerson", { email: person.email })}
                      >
                        {t("share.remove")}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {isShared && (
              <button className="cf-btn danger sh-stop" disabled={busy} onClick={() => setConfirming("all")}>
                {t("share.stopSharing")}
              </button>
            )}
          </>
        )}

        {error && <p className="sh-error">{error}</p>}
      </div>

      {confirming === "link" && (
        <Confirm
          title={t("confirm.removeLinkTitle")}
          message={t("confirm.removeLinkMessage")}
          confirmLabel={t("confirm.removeLinkConfirm")}
          danger
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            setConfirming(null);
            void run("removePublicLink", {});
          }}
        />
      )}

      {confirming === "all" && (
        <Confirm
          title={t("confirm.stopSharingTitle")}
          message={t("confirm.stopSharingMessage")}
          confirmLabel={t("confirm.stopSharingConfirm")}
          danger
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            setConfirming(null);
            void run("stopSharing", {});
          }}
        />
      )}

      {replacing && (
        <Confirm
          title={t("confirm.replaceLinkTitle")}
          message={t("confirm.replaceLinkMessage")}
          confirmLabel={t("confirm.replaceLinkConfirm")}
          danger
          onCancel={() => setReplacing(null)}
          onConfirm={() => {
            const change = replacing;
            setReplacing(null);
            void run(
              "setPublicLink",
              change.params,
              (s) => {
                change.then?.();
                // The address is a new one, so the clipboard is holding a link that no
                // longer opens anything. This was asked for, so put the new one there.
                if (s.publicLink) void copy(s.publicLink.url);
              },
              change.tag,
            );
          }}
        />
      )}
    </div>
  );
}
