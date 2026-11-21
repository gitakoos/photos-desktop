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

/**
 * What a sign-out came to: `out` once the sidecar let the account go, `held` while changes not on
 * Drive keep it, `failed` when the sidecar did not answer that it let go, so the account may still
 * be held there and the window stays signed in.
 */
export type SignOutOutcome = { kind: "out" } | { kind: "held"; unsaved: string[] } | { kind: "failed" };

/** Asks the sidecar to sign out; `discard` is the user's choice to lose changes not on Drive. */
export async function requestSignOut(
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  discard: boolean,
): Promise<SignOutOutcome> {
  let answer: { ok?: unknown; unsaved?: unknown } | null;
  try {
    answer = (await call("signOut", discard ? { discard: true } : {})) as typeof answer;
  } catch {
    return { kind: "failed" };
  }
  if (answer?.ok === true) return { kind: "out" };
  const unsaved = Array.isArray(answer?.unsaved) ? answer.unsaved.filter((k): k is string => typeof k === "string") : [];
  return unsaved.length > 0 ? { kind: "held", unsaved } : { kind: "failed" };
}
