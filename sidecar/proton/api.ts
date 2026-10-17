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

// Raw Proton API client for the sidecar: auth + core endpoints, plus the
// session-aware HTTP client the Drive SDK consumes.

export const BASE_URL = "https://drive-api.proton.me";
// Mirror the Android app's proven appVersion exactly. The underscore form passes
// both ProtonCore's client-side regex and the auth server; other shapes get a
// "this version is no longer supported" rejection. Do not change the shape.
export const APP_VERSION = "external-drive-akoos_proton_photos@2.3.10-stable";

/**
 * The User-Agent, which is what Proton's security log shows as the device ("the app, and
 * the system it runs on"). Unlike the appVersion it is only displayed, so it names the
 * system the sidecar is actually running on. The Windows string is kept exactly as it
 * always was.
 */
export function userAgentFor(platform: NodeJS.Platform): string {
  const system = platform === "win32" ? "Windows 11" : platform === "darwin" ? "macOS" : "Linux";
  return `AkoosProtonPhotos/2.3.10 (${system}; Desktop)`;
}
export const USER_AGENT = userAgentFor(process.platform);

const API_ORIGIN = new URL(BASE_URL).origin;

/**
 * Whether a request goes to the Proton API itself, the only place the session's tokens
 * may be sent. Compared by origin: a prefix test would also match
 * `https://drive-api.proton.me.example.com` or `https://drive-api.proton.me@example.com`,
 * so a URL handed to the SDK from anywhere could carry the access token off.
 */
export function isApiUrl(url: string): boolean {
  try {
    return new URL(url).origin === API_ORIGIN;
  } catch {
    return false;
  }
}

export type Session = { uid: string; accessToken: string; refreshToken?: string };

/** A human-verification challenge the API demands (Code 9001). */
export type HvChallenge = { token: string; methods: string[] };
/** The solved proof, replayed as headers on the retried request. */
export type HvProof = { token: string; type: string };

/**
 * Proton's captcha page. `ForceWebMessaging=1` makes it report the result with
 * `window.parent.postMessage({type: "pm_captcha", token}, "*")`, so it can be
 * embedded in an iframe and the token read from the message.
 */
export const captchaUrl = (token: string): string =>
  `${BASE_URL}/core/v4/captcha?Token=${encodeURIComponent(token)}&ForceWebMessaging=1&Dark=1`;

/** Field names are not in the SDK's type set, so read defensively and log misses. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function hvChallengeFrom(json: any): HvChallenge | null {
  if (json?.Code !== 9001) return null;
  const d = json.Details ?? {};
  const token = d.HumanVerificationToken ?? d.Token;
  const methods = d.HumanVerificationMethods ?? d.Methods ?? [];
  if (!token) {
    process.stderr.write(`[api] 9001 without a token; Details=${JSON.stringify(d)}\n`);
    return null;
  }
  return { token, methods };
}

function baseHeaders(session?: Session): Record<string, string> {
  const h: Record<string, string> = {
    "x-pm-appversion": APP_VERSION,
    "User-Agent": USER_AGENT,
    Accept: "application/vnd.protonmail.v1+json",
  };
  if (session) {
    h["x-pm-uid"] = session.uid;
    h["Authorization"] = `Bearer ${session.accessToken}`;
  }
  return h;
}

async function apiFetch(
  path: string,
  opts: { method?: string; body?: object; session?: Session; hv?: HvProof } = {},
): Promise<Record<string, unknown>> {
  const headers = baseHeaders(opts.session);
  if (opts.body) headers["Content-Type"] = "application/json";
  if (opts.hv) {
    headers["x-pm-human-verification-token"] = opts.hv.token;
    headers["x-pm-human-verification-token-type"] = opts.hv.type;
  }
  const res = await fetch(BASE_URL + path, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    /* non-JSON body */
  }
  const ok = res.ok && (json?.Code === undefined || json.Code === 1000 || json.Code === 1001);
  if (!ok) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const err: any = new Error(json?.Error || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = json?.Code;
    err.details = json;
    err.hv = hvChallengeFrom(json);
    throw err;
  }
  return json;
}

export const ProtonApi = {
  authInfo: (username: string) =>
    apiFetch("/auth/v4/info", { method: "POST", body: { Username: username } }),
  auth: (body: object, hv?: HvProof) => apiFetch("/auth/v4", { method: "POST", body, hv }),
  auth2fa: (session: Session, code: string) =>
    apiFetch("/auth/v4/2fa", { method: "POST", body: { TwoFactorCode: code }, session }),
  /** Ends the session on Proton's side, so its tokens stop working everywhere. */
  revoke: (session: Session) => apiFetch("/auth/v4", { method: "DELETE", session }),
  getUser: (session: Session) => apiFetch("/core/v4/users", { session }),
  getAddresses: (session: Session) => apiFetch("/core/v4/addresses", { session }),
  getKeySalts: (session: Session) => apiFetch("/core/v4/keys/salts", { session }),
  /** Public keys for an address, used to verify signatures on decrypted metadata. */
  getAddressPublicKeys: (session: Session, email: string) =>
    apiFetch(`/core/v4/keys/all?Email=${encodeURIComponent(email)}&InternalOnly=1`, { session }),
  photosShare: (session: Session) => apiFetch("/drive/v2/shares/photos", { session }),
  /** A session fork to sign in through the browser: its selector and user code. */
  forkInit: () => apiFetch("/auth/v4/sessions/forks"),
  forkStatus: (selector: string) => apiFetch(`/auth/v4/sessions/forks/${encodeURIComponent(selector)}`),
  forkDiscard: (selector: string) =>
    apiFetch(`/auth/v4/sessions/forks/${encodeURIComponent(selector)}`, { method: "DELETE" }),
  /** A fresh SRP modulus, signed by Proton. Minting a public link needs one. */
  authModulus: (session: Session) => apiFetch("/core/v4/auth/modulus", { session }),
};

/**
 * The signed modulus a public link's SRP verifier is built on, with the id the
 * server wants back alongside the verifier. Its signature is checked where the
 * verifier is computed, so both halves are carried together from here.
 */
export async function randomModulus(
  session: Session,
): Promise<{ modulus: string; modulusId: string }> {
  const res = await ProtonApi.authModulus(session);
  const modulus = String(res.Modulus ?? "");
  const modulusId = String(res.ModulusID ?? "");
  if (!modulus || !modulusId) throw new Error("the server returned no SRP modulus");
  return { modulus, modulusId };
}

/** Refresh the access token using the stored refresh token (used on resume). */
export async function refreshSession(uid: string, refreshToken: string): Promise<Session> {
  const res = await fetch(BASE_URL + "/auth/v4/refresh", {
    method: "POST",
    headers: {
      "x-pm-appversion": APP_VERSION,
      "User-Agent": USER_AGENT,
      "Content-Type": "application/json",
      "x-pm-uid": uid,
      Accept: "application/vnd.protonmail.v1+json",
    },
    body: JSON.stringify({
      UID: uid,
      RefreshToken: refreshToken,
      ResponseType: "token",
      GrantType: "refresh_token",
      RedirectURI: "https://protonmail.ch",
      State: "resume",
    }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || (json?.Code && json.Code !== 1000)) {
    throw new Error(json?.Error || `token refresh failed (HTTP ${res.status})`);
  }
  return { uid: json.UID ?? uid, accessToken: json.AccessToken, refreshToken: json.RefreshToken };
}

/**
 * The signal one attempt runs under: the caller's, the SDK's timeout, or both.
 *
 * The SDK's HTTP client contract makes the timeout the implementer's job, and it passes
 * one on every request (30s for metadata, 600s for file content). Left unimplemented, a
 * half-open connection (a laptop resuming from sleep, a captive portal) never settles
 * the fetch, so the handler never returns and no response line is written. The host
 * serialises every call on one channel, so that is the whole app frozen, with no error
 * and nothing to recover from.
 *
 * `AbortSignal.timeout` aborts with a reason named `TimeoutError`, which is the name the
 * SDK's own retry logic waits for, so honouring the contract is also what puts its
 * retries into service. Composing rather than replacing keeps a real cancel reporting as
 * `AbortError`, which the SDK treats as final instead of retrying it.
 *
 * The signal stays live while the response body is read, which is deliberate: a
 * connection that delivers headers and then stalls mid-body hangs the channel exactly
 * the same way, and this is what cuts it.
 */
function attemptSignal(timeoutMs: number, caller?: AbortSignal): AbortSignal | undefined {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return caller;
  const timeout = AbortSignal.timeout(timeoutMs);
  return caller ? AbortSignal.any([caller, timeout]) : timeout;
}

/**
 * The ProtonDriveHTTPClient the SDK calls for Drive requests.
 *
 * Proton access tokens are short-lived, so a 401 on a first-party API call means
 * "token expired": refresh once and retry, rather than surfacing it as a signed-out
 * state (which is what forced frequent re-logins). `onRefreshed` persists the new
 * tokens. Refresh is single-flight because Proton rotates the refresh token on every
 * use, so concurrent refreshes would invalidate each other and force a real logout.
 */
export function makeSdkHttpClient(session: Session, onRefreshed?: () => void) {
  function inject(url: string, headers: Headers): Headers {
    headers.set("x-pm-appversion", APP_VERSION);
    headers.set("User-Agent", USER_AGENT);
    // Only attach the API session to first-party API hosts; block storage (CDN)
    // uses its own pm-storage-token that the SDK sets on the request itself.
    if (isApiUrl(url)) {
      headers.set("x-pm-uid", session.uid);
      headers.set("Authorization", `Bearer ${session.accessToken}`);
    }
    return headers;
  }

  let refreshing: Promise<void> | null = null;
  function refresh(): Promise<void> {
    if (!refreshing) {
      refreshing = (async () => {
        if (!session.refreshToken) throw new Error("no refresh token");
        const fresh = await refreshSession(session.uid, session.refreshToken);
        // Mutate the shared session object in place so later requests (and the
        // persisted blob) see the new tokens.
        session.uid = fresh.uid;
        session.accessToken = fresh.accessToken;
        session.refreshToken = fresh.refreshToken;
        onRefreshed?.();
      })().finally(() => {
        refreshing = null;
      });
    }
    return refreshing;
  }

  async function withAuthRetry(url: string, run: () => Promise<Response>): Promise<Response> {
    const res = await run();
    if (res.status === 401 && isApiUrl(url)) {
      try {
        await refresh();
      } catch {
        return res; // refresh failed: surface the original 401
      }
      return run(); // retry once with the fresh access token
    }
    return res;
  }

  return {
    async fetchJson(req: {
      url: string;
      method: string;
      headers: Headers;
      timeoutMs: number;
      json?: object;
      body?: BodyInit;
      signal?: AbortSignal;
    }): Promise<Response> {
      // Built per attempt, so the retry a 401 triggers is bounded on its own rather
      // than inheriting what a slow first attempt already spent.
      return withAuthRetry(req.url, () => {
        const headers = inject(req.url, new Headers(req.headers));
        if (req.json) headers.set("Content-Type", "application/json");
        return fetch(req.url, {
          method: req.method,
          headers,
          body: req.json ? JSON.stringify(req.json) : req.body,
          signal: attemptSignal(req.timeoutMs, req.signal),
        });
      });
    },
    async fetchBlob(req: {
      url: string;
      method: string;
      headers: Headers;
      timeoutMs: number;
      body?: BodyInit;
      signal?: AbortSignal;
    }): Promise<Response> {
      return withAuthRetry(req.url, () => {
        const headers = inject(req.url, new Headers(req.headers));
        return fetch(req.url, {
          method: req.method,
          headers,
          body: req.body,
          signal: attemptSignal(req.timeoutMs, req.signal),
        });
      });
    },
  };
}
