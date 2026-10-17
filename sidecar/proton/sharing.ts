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

// Sharing: who else can reach a photo or an album, and the one string in this
// app that must never be written down.
//
// A public link's URL ends in `#<secret>`, and that fragment is the decryption
// key itself: it never travels to the server, and the link is worthless without
// it. So the URL is carried whole, handed to the user intact, and never logged,
// neither whole nor in part. A link's custom password is the second secret here:
// it arrives to be set, goes straight to the SDK, and turns back into a single
// boolean before anything leaves this module. The same goes for the addresses
// invited here. A failure leaves behind the operation and the error's kind and
// nothing else, so the log stays sendable; `noteFailure` sets out exactly what
// that means.
//
// Drive offers two shapes of sharing and does not offer both everywhere. A photo
// takes a public link (anyone holding the URL) and named invitations; an album
// takes invitations only, because the server refuses a public URL on an album
// share. `supportsPublicLink` carries that split up to the view, so it never
// offers a button the server would answer with an error.
//
// Public links are encrypted to the owner's own address key, so Proton grants
// them only on a volume the user owns. `canShare` settles that here rather than
// letting the SDK throw at someone who merely opened a photo shared with them.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { toMillis } from "./nodes.ts";

/**
 * The SDK's `NodeType.Album` and `MemberRole` values. They are inlined because
 * they are the server's wire format and fixed by it, and because reaching for
 * them through the SDK's entry point would pull the whole client into a module
 * that otherwise needs nothing beyond the client object it is handed.
 */
const ALBUM = "album";
const VIEWER = "viewer";
const EDITOR = "editor";

/**
 * The length of the secret the SDK generates for a new link (its own
 * `PUBLIC_LINK_GENERATED_PASSWORD_LENGTH`). Links minted before that scheme
 * carry a fragment of another length, which is how one is recognised.
 */
const GENERATED_SECRET_LENGTH = 12;

/** Refusals the view turns into its own wording; they name nothing about the node. */
export const SHARE_NOT_OWNED = "SHARE_NOT_OWNED";
export const SHARE_NO_ALBUM_LINK = "SHARE_NO_ALBUM_LINK";

/** The refusals above, which are fixed strings and so are safe to write down. */
const OWN_REFUSALS: readonly string[] = [SHARE_NOT_OWNED, SHARE_NO_ALBUM_LINK];

/**
 * Names a failed call by what was attempted and by the kind of error only.
 *
 * The message is never written: the SDK quotes uids, addresses and node names in
 * its own, and this log is what a user would be asked to send. What is left is
 * the operation, the error's class, and whatever numeric code came with it —
 * enough to tell a refused share from an expired token from a network drop, and
 * not enough to say whose photo it was. A refusal of our own is matched against
 * the fixed list above rather than read off the error.
 */
function noteFailure(operation: string, e: unknown): void {
  const err = e as { name?: unknown; code?: unknown; status?: unknown } | null;
  const message = e instanceof Error ? e.message : "";
  const parts = [`op=${operation}`, `kind=${OWN_REFUSALS.find((r) => r === message) ?? String(err?.name ?? "Error")}`];
  if (typeof err?.code === "number") parts.push(`code=${err.code}`);
  if (typeof err?.status === "number") parts.push(`status=${err.status}`);
  process.stderr.write(`[share] failed ${parts.join(" ")}\n`);
}

/** Runs one sharing call, leaving a trace of it behind if it fails. */
async function watch<T>(operation: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    noteFailure(operation, e);
    throw e;
  }
}

/** Someone who can reach the node: a member who accepted, or an invitation still out. */
export type SharePerson = {
  uid: string;
  email: string;
  role: string;
  /** `invited` is an invitation to a Proton account, `external` to an address without one. */
  state: "member" | "invited" | "external";
};

export type PublicLinkInfo = {
  /** The whole URL, `#secret` fragment included. Hand it over intact; never log it. */
  url: string;
  role: string;
  creationTime: number;
  expirationTime: number | null;
  hasCustomPassword: boolean;
  /**
   * Legacy links carry no usable generated secret, so Drive refuses to update
   * them. Replacing one is the only way to change it, which `setPublicLink` does.
   */
  canUpdate: boolean;
};

/**
 * What a link is being changed to.
 *
 * Drive writes a link's role, password and expiry as one set: whatever an update
 * leaves out is not left alone but cleared. So the three states are spelled out
 * here. Absent keeps what the link already carries, `null` takes it off, and a
 * value sets it; `setPublicLink` reads the current link to honour the first.
 */
export type PublicLinkOptions = {
  /** Never logged and never returned; only `hasCustomPassword` leaves here. */
  customPassword?: string | null;
  /** Epoch millis. Drive refuses a date already past. */
  expiration?: number | null;
};

export type SharingInfo = {
  uid: string;
  /** A node on someone else's volume: Proton allows neither a link nor an invitation from here. */
  canShare: boolean;
  /** False for albums, which Drive shares by invitation only. */
  supportsPublicLink: boolean;
  publicLink: PublicLinkInfo | null;
  people: SharePerson[];
  /**
   * A share exists on the node, even if nothing has been put on it yet. A share
   * whose creation succeeded and whose link then failed leaves exactly that, and
   * without this the view would see an unshared node and offer no way to clear it.
   */
  isShared: boolean;
};

/** What the node is and whether it is ours, which together decide what may be offered. */
type ShareContext = { owns: boolean; isAlbum: boolean };

/** A node uid is `volumeId~nodeId` (the SDK composes it that way in `generateNodeUid`). */
const volumeOf = (uid: string): string => uid.split("~")[0] ?? "";

const roleOf = (role: unknown): string => String(role ?? VIEWER);

/**
 * The node's volume against the one this account's photos live on. Public links
 * are encrypted to the owner's address key, and that same volume test is the
 * SDK's own gate on sharing, so it is the one used here.
 */
async function readContext(photos: any, uid: string): Promise<ShareContext> {
  const [node, root] = await Promise.all([photos.getNode(uid), photos.getMyPhotosRootFolder()]);
  const own = volumeOf(String((root as any)?.uid ?? ""));
  return {
    owns: own.length > 0 && own === volumeOf(uid),
    isAlbum: (node as any)?.type === ALBUM,
  };
}

function toPublicLink(link: any): PublicLinkInfo | null {
  if (!link?.url) return null;
  const url = String(link.url);
  const secret = url.split("#")[1] ?? "";
  return {
    url,
    role: roleOf(link.role),
    creationTime: toMillis(link.creationTime),
    expirationTime: link.expirationTime ? toMillis(link.expirationTime) : null,
    hasCustomPassword: !!link.customPassword,
    canUpdate: secret.length === GENERATED_SECRET_LENGTH,
  };
}

/** Members and both kinds of pending invitation, flattened into one list to render. */
function toPeople(result: any): SharePerson[] {
  if (!result) return [];
  const people: SharePerson[] = [];
  const add = (entry: any, state: SharePerson["state"]) => {
    people.push({
      uid: String(entry.uid),
      email: String(entry.inviteeEmail ?? ""),
      role: roleOf(entry.role),
      state,
    });
  };
  for (const member of result.members ?? []) add(member, "member");
  for (const invitation of result.protonInvitations ?? []) add(invitation, "invited");
  for (const invitation of result.nonProtonInvitations ?? []) add(invitation, "external");
  return people;
}

/**
 * The SDK's `ShareResult` as the view wants it. `undefined` is what both an
 * unshared node and a share the last revoke just deleted come back as, and they
 * mean the same thing here: nothing is shared.
 */
function describe(uid: string, ctx: ShareContext, result: any): SharingInfo {
  return {
    uid,
    canShare: ctx.owns,
    supportsPublicLink: ctx.owns && !ctx.isAlbum,
    publicLink: toPublicLink(result?.publicLink),
    people: toPeople(result),
    isShared: !!result,
  };
}

/**
 * Who can currently reach the node. A node shared *with* the user is reported as
 * unshareable rather than queried: every share call would throw on it, and the
 * view only needs to know not to offer them.
 */
export async function getSharingInfo(photos: any, uid: string): Promise<SharingInfo> {
  return watch("getSharingInfo", async () => {
    const ctx = await readContext(photos, uid);
    const result = ctx.owns ? await photos.getSharingInfo(uid) : undefined;
    return describe(uid, ctx, result);
  });
}

/** A setting the request is changing, or the one the link already carries. */
function settle<T>(wanted: T | null | undefined, current: T | undefined): T | undefined {
  return wanted === undefined ? current : (wanted ?? undefined);
}

/**
 * Creates the node's public link, refreshes the one it already has, or changes
 * its password or expiry: the SDK's `shareNode` is the same call for all of them.
 * The returned link is the one to show, because it is the only place the secret
 * exists in usable form.
 *
 * Because that one call rewrites every setting at once, a request that names
 * only the password has to send the current expiry back with it, and the other
 * way round. The link is read first for exactly that, and its password is read
 * back the same way the SDK reads it: off the link itself, not from anything
 * this app kept.
 */
export async function setPublicLink(
  photos: any,
  uid: string,
  options: PublicLinkOptions = {},
): Promise<SharingInfo> {
  return watch("setPublicLink", async () => {
    const ctx = await readContext(photos, uid);
    if (!ctx.owns) throw new Error(SHARE_NOT_OWNED);
    if (ctx.isAlbum) throw new Error(SHARE_NO_ALBUM_LINK);

    const current = await photos.getSharingInfo(uid);
    const link = current?.publicLink;
    const existing = toPublicLink(link);

    // A legacy link cannot be updated, only replaced, so it is dropped first and
    // the request becomes the creation it has to be. What it carried goes with
    // it: there is no link left to keep a setting from.
    const replacing = !!existing && !existing.canUpdate;
    if (replacing) await photos.unshareNode(uid, { publicLink: "remove" });
    const kept = replacing ? undefined : link;

    // An emptied field arrives as an empty string or a zero, which is the same
    // request as taking the setting off, and is folded into it here so that what
    // reaches the SDK is only ever a setting or nothing.
    const wantsPassword =
      options.customPassword === undefined ? undefined : options.customPassword || null;
    const wantsExpiry =
      options.expiration === undefined
        ? undefined
        : options.expiration
          ? new Date(options.expiration)
          : null;

    const result = await photos.shareNode(uid, {
      publicLink: {
        // A photo's link is a viewer link, which is what the boolean form of
        // these settings meant and what the object form has to say outright.
        // Reading the link's own role back would widen it instead of keeping it.
        role: VIEWER,
        customPassword: settle(wantsPassword, kept?.customPassword),
        expiration: settle(wantsExpiry, kept?.expirationTime ? new Date(kept.expirationTime) : undefined),
      },
    });
    return describe(uid, ctx, result);
  });
}

/** Revokes the public link. Anyone still holding the URL loses the node with it. */
export async function removePublicLink(photos: any, uid: string): Promise<SharingInfo> {
  return watch("removePublicLink", async () => {
    const ctx = await readContext(photos, uid);
    if (!ctx.owns) throw new Error(SHARE_NOT_OWNED);
    const result = await photos.unshareNode(uid, { publicLink: "remove" });
    return describe(uid, ctx, result);
  });
}

/**
 * Invites people by address. The SDK sorts Proton addresses from the rest and
 * sends each the invitation it can read, so both are passed in together.
 */
export async function invitePeople(
  photos: any,
  uid: string,
  emails: string[],
  role: string,
): Promise<SharingInfo> {
  return watch("invitePeople", async () => {
    const ctx = await readContext(photos, uid);
    if (!ctx.owns) throw new Error(SHARE_NOT_OWNED);
    const wanted = role === EDITOR ? EDITOR : VIEWER;
    const users = emails.map((email) => ({ email, role: wanted }));
    const result = await photos.shareNode(uid, { users });
    return describe(uid, ctx, result);
  });
}

/** Takes one person off the node, whether they had accepted or were still invited. */
export async function removePerson(photos: any, uid: string, email: string): Promise<SharingInfo> {
  return watch("removePerson", async () => {
    const ctx = await readContext(photos, uid);
    if (!ctx.owns) throw new Error(SHARE_NOT_OWNED);
    const result = await photos.unshareNode(uid, { users: [email] });
    return describe(uid, ctx, result);
  });
}

/** Ends all of it at once: every member, every invitation, and the link. */
export async function stopSharing(photos: any, uid: string): Promise<SharingInfo> {
  return watch("stopSharing", async () => {
    const ctx = await readContext(photos, uid);
    if (!ctx.owns) throw new Error(SHARE_NOT_OWNED);
    const result = await photos.unshareNode(uid);
    return describe(uid, ctx, result);
  });
}
