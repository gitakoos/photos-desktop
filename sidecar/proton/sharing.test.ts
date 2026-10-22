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

// The module takes the SDK client as its first argument, so a stub standing in
// for it exercises the real exported functions: what may be shared, what may
// carry a link, and what the SDK is asked to do about it.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi } from "vitest";
import {
  acceptInvitation,
  declineInvitation,
  getSharingInfo,
  invitePeople,
  listInvitations,
  removePerson,
  removePublicLink,
  setPublicLink,
  stopSharing,
} from "./sharing.ts";

const OWN_VOLUME = "vol-own";
const ROOT_UID = `${OWN_VOLUME}~root`;
const PHOTO_UID = `${OWN_VOLUME}~photo-1`;
const ALBUM_UID = `${OWN_VOLUME}~album-1`;
// A node shared with the user lives on the volume of whoever owns it.
const FOREIGN_UID = "vol-theirs~photo-9";

/** The generated secret is 12 characters, which is what marks a link updatable. */
const SECRET = "abcdefghijkl";
const URL_WITH_SECRET = `https://drive.proton.me/urls/TOKEN#${SECRET}`;

type Calls = { method: string; args: any[] }[];

/**
 * A stand-in for `ProtonDrivePhotosClient` that records what it was asked to do.
 * `sharing` is what the server would currently report for the node.
 *
 * Its `shareNode` answers the way the SDK's does, which is what makes an
 * assertion about the reported link an assertion about what was really set:
 * `shareViaLink` and `updateSharedLink` both build their answer by echoing the
 * role, password and expiry they were handed, and both write every one of them
 * every time. Keeping that here is the only way a test can tell a setting that
 * was carried over from one that was quietly dropped.
 */
function makePhotos(opts: { type?: string; sharing?: any; shareResult?: any } = {}) {
  const calls: Calls = [];
  let sharing = opts.sharing;
  const photos: any = {
    calls,
    getNode: async (uid: string) => {
      calls.push({ method: "getNode", args: [uid] });
      return { uid, type: opts.type ?? "photo" };
    },
    getMyPhotosRootFolder: async () => ({ uid: ROOT_UID }),
    getSharingInfo: async (uid: string) => {
      calls.push({ method: "getSharingInfo", args: [uid] });
      return sharing;
    },
    shareNode: async (uid: string, settings: any) => {
      calls.push({ method: "shareNode", args: [uid, settings] });
      if (opts.shareResult) return opts.shareResult;
      if (!settings?.publicLink) return sharing ?? emptyResult();
      const wanted = settings.publicLink === true ? { role: "viewer" } : settings.publicLink;
      const before = sharing?.publicLink;
      sharing = {
        ...emptyResult(),
        ...sharing,
        publicLink: {
          uid: before?.uid ?? "link-1",
          // An update keeps the URL it had; a creation mints one.
          url: before?.url ?? URL_WITH_SECRET,
          role: wanted.role,
          creationTime: before?.creationTime ?? new Date("2026-07-17T10:00:00Z"),
          customPassword: wanted.customPassword,
          expirationTime: wanted.expiration,
          numberOfInitializedDownloads: 0,
        },
      };
      return sharing;
    },
    unshareNode: async (uid: string, settings?: any) => {
      calls.push({ method: "unshareNode", args: [uid, settings] });
      if (settings?.publicLink === "remove" && sharing) sharing = { ...sharing, publicLink: undefined };
      else if (!settings) sharing = undefined;
      return undefined;
    },
  };
  return photos;
}

const emptyResult = () => ({
  protonInvitations: [],
  nonProtonInvitations: [],
  members: [],
  publicLink: undefined,
  editorsCanShare: false,
});

/**
 * A node the server reports as carrying a link. `extra` is what the SDK decrypts
 * off the link itself (`customPassword` and `expirationTime`), which is where the
 * current settings come from when a request changes only one of them.
 */
const linkResult = (url: string, extra: Record<string, unknown> = {}) => ({
  ...emptyResult(),
  publicLink: {
    uid: "link-1",
    url,
    role: "viewer",
    creationTime: new Date("2026-07-17T10:00:00Z"),
    numberOfInitializedDownloads: 0,
    ...extra,
  },
});

const named = (photos: any, method: string) => photos.calls.filter((c: any) => c.method === method);

describe("what may be shared", () => {
  it("offers a link and invitations on the user's own photo", async () => {
    const info = await getSharingInfo(makePhotos(), PHOTO_UID);
    expect(info.canShare).toBe(true);
    expect(info.supportsPublicLink).toBe(true);
  });

  // Drive refuses a public URL on an album share, so the view is told not to
  // offer one; invitations remain the way an album is shared.
  it("offers invitations but no link on an album", async () => {
    const info = await getSharingInfo(makePhotos({ type: "album" }), ALBUM_UID);
    expect(info.canShare).toBe(true);
    expect(info.supportsPublicLink).toBe(false);
  });

  it("offers nothing on a node from someone else's volume, and does not ask the server", async () => {
    const photos = makePhotos();
    const info = await getSharingInfo(photos, FOREIGN_UID);
    expect(info.canShare).toBe(false);
    expect(info.supportsPublicLink).toBe(false);
    expect(info.publicLink).toBeNull();
    expect(named(photos, "getSharingInfo")).toHaveLength(0);
  });
});

describe("refusals instead of thrown SDK errors", () => {
  it("refuses a link on an album without calling shareNode", async () => {
    const photos = makePhotos({ type: "album" });
    await expect(setPublicLink(photos, ALBUM_UID)).rejects.toThrow("SHARE_NO_ALBUM_LINK");
    expect(named(photos, "shareNode")).toHaveLength(0);
  });

  it("refuses every share action on a node the user does not own", async () => {
    for (const action of [setPublicLink, removePublicLink, stopSharing]) {
      const photos = makePhotos();
      await expect(action(photos, FOREIGN_UID)).rejects.toThrow("SHARE_NOT_OWNED");
      expect(named(photos, "shareNode")).toHaveLength(0);
      expect(named(photos, "unshareNode")).toHaveLength(0);
    }
    const photos = makePhotos();
    await expect(invitePeople(photos, FOREIGN_UID, ["a@b.com"], "viewer")).rejects.toThrow(
      "SHARE_NOT_OWNED",
    );
    await expect(removePerson(photos, FOREIGN_UID, "a@b.com")).rejects.toThrow("SHARE_NOT_OWNED");
  });
});

describe("the public link", () => {
  it("keeps the URL whole, fragment included", async () => {
    const photos = makePhotos({ shareResult: linkResult(URL_WITH_SECRET) });
    const info = await setPublicLink(photos, PHOTO_UID);
    expect(info.publicLink?.url).toBe(URL_WITH_SECRET);
    expect(info.publicLink?.canUpdate).toBe(true);
  });

  it("marks a legacy link (no 12-character secret) as one that cannot be updated", async () => {
    const legacy = "https://drive.proton.me/urls/TOKEN#short";
    const photos = makePhotos({ sharing: linkResult(legacy) });
    const info = await getSharingInfo(photos, PHOTO_UID);
    expect(info.publicLink?.canUpdate).toBe(false);
  });

  // Drive cannot update a legacy link, so the only way to honour the request is
  // to drop it first and let the create path run.
  it("replaces a legacy link rather than asking the SDK to update it", async () => {
    const photos = makePhotos({
      sharing: linkResult("https://drive.proton.me/urls/TOKEN#short"),
      shareResult: linkResult(URL_WITH_SECRET),
    });
    await setPublicLink(photos, PHOTO_UID);
    expect(named(photos, "unshareNode")[0].args[1]).toEqual({ publicLink: "remove" });
    expect(named(photos, "shareNode")[0].args[1]).toEqual({ publicLink: { role: "viewer" } });
  });

  it("leaves a current link to the SDK's own create-or-update call", async () => {
    const photos = makePhotos({
      sharing: linkResult(URL_WITH_SECRET),
      shareResult: linkResult(URL_WITH_SECRET),
    });
    await setPublicLink(photos, PHOTO_UID);
    expect(named(photos, "unshareNode")).toHaveLength(0);
    expect(named(photos, "shareNode")[0].args[1]).toEqual({ publicLink: { role: "viewer" } });
  });

  // Photo links are viewer links. The object form the SDK takes has to say so,
  // and this pins that spelling it out does not widen what a link grants.
  it("asks for a viewer link, never an editor one", async () => {
    const photos = makePhotos();
    await setPublicLink(photos, PHOTO_UID);
    expect(named(photos, "shareNode")[0].args[1].publicLink.role).toBe("viewer");
  });

  it("reports nothing shared once the last revoke deletes the share", async () => {
    const info = await removePublicLink(makePhotos(), PHOTO_UID);
    expect(info.publicLink).toBeNull();
    expect(info.people).toEqual([]);
  });

  // A share whose creation went through and whose link then did not leaves this
  // behind. Without it the dialog would see an unshared photo and offer no way
  // to take the share off again.
  it("reports a bare share with neither link nor people as shared", async () => {
    const info = await getSharingInfo(makePhotos({ sharing: emptyResult() }), PHOTO_UID);
    expect(info.publicLink).toBeNull();
    expect(info.people).toEqual([]);
    expect(info.isShared).toBe(true);
  });

  it("reports a photo with no share at all as not shared", async () => {
    const info = await getSharingInfo(makePhotos(), PHOTO_UID);
    expect(info.isShared).toBe(false);
  });
});

/**
 * Drive rewrites a link's role, password and expiry together, so every one of
 * these is as much about what the request left alone as about what it changed.
 */
describe("the link's password and expiry", () => {
  const PASSWORD = "correct horse battery";
  const OTHER_PASSWORD = "a different one entirely";
  const EXPIRY = Date.UTC(2027, 0, 15);

  /** The settings the last `shareNode` was handed. */
  const sentLink = (photos: any) => named(photos, "shareNode").at(-1)!.args[1].publicLink;

  it("creates a link carrying a password", async () => {
    const photos = makePhotos();
    const info = await setPublicLink(photos, PHOTO_UID, { customPassword: PASSWORD });
    expect(sentLink(photos).customPassword).toBe(PASSWORD);
    expect(info.publicLink?.hasCustomPassword).toBe(true);
  });

  it("puts a password on a link that had none", async () => {
    const photos = makePhotos({ sharing: linkResult(URL_WITH_SECRET) });
    expect((await getSharingInfo(photos, PHOTO_UID)).publicLink?.hasCustomPassword).toBe(false);

    const info = await setPublicLink(photos, PHOTO_UID, { customPassword: PASSWORD });
    expect(sentLink(photos).customPassword).toBe(PASSWORD);
    expect(info.publicLink?.hasCustomPassword).toBe(true);
    // The link itself is untouched: the URL people already hold still works.
    expect(info.publicLink?.url).toBe(URL_WITH_SECRET);
  });

  it("changes a password that is already there", async () => {
    const photos = makePhotos({ sharing: linkResult(URL_WITH_SECRET, { customPassword: PASSWORD }) });
    const info = await setPublicLink(photos, PHOTO_UID, { customPassword: OTHER_PASSWORD });
    expect(sentLink(photos).customPassword).toBe(OTHER_PASSWORD);
    expect(info.publicLink?.hasCustomPassword).toBe(true);
  });

  // Null is the way a caller says "take it off". The SDK reads a missing custom
  // password as no password at all, so this is the whole of removing one.
  it("takes a password off again", async () => {
    const photos = makePhotos({ sharing: linkResult(URL_WITH_SECRET, { customPassword: PASSWORD }) });
    const info = await setPublicLink(photos, PHOTO_UID, { customPassword: null });
    expect(sentLink(photos).customPassword).toBeUndefined();
    expect(info.publicLink?.hasCustomPassword).toBe(false);
  });

  it("reads an empty password as taking it off, the way a cleared field arrives", async () => {
    const photos = makePhotos({ sharing: linkResult(URL_WITH_SECRET, { customPassword: PASSWORD }) });
    const info = await setPublicLink(photos, PHOTO_UID, { customPassword: "" });
    expect(sentLink(photos).customPassword).toBeUndefined();
    expect(info.publicLink?.hasCustomPassword).toBe(false);
  });

  it("sets an expiry, and reports it back as millis", async () => {
    const photos = makePhotos({ sharing: linkResult(URL_WITH_SECRET) });
    const info = await setPublicLink(photos, PHOTO_UID, { expiration: EXPIRY });
    expect(sentLink(photos).expiration).toEqual(new Date(EXPIRY));
    expect(info.publicLink?.expirationTime).toBe(EXPIRY);
  });

  it("takes an expiry off again", async () => {
    const photos = makePhotos({
      sharing: linkResult(URL_WITH_SECRET, { expirationTime: new Date(EXPIRY) }),
    });
    const info = await setPublicLink(photos, PHOTO_UID, { expiration: null });
    expect(sentLink(photos).expiration).toBeUndefined();
    expect(info.publicLink?.expirationTime).toBeNull();
  });

  // The trap this feature is built around: the SDK writes both settings on every
  // update, so a request naming one of them has to carry the other back itself.
  it("keeps the expiry when only the password changes", async () => {
    const photos = makePhotos({
      sharing: linkResult(URL_WITH_SECRET, { expirationTime: new Date(EXPIRY) }),
    });
    const info = await setPublicLink(photos, PHOTO_UID, { customPassword: PASSWORD });
    expect(sentLink(photos).expiration).toEqual(new Date(EXPIRY));
    expect(info.publicLink?.expirationTime).toBe(EXPIRY);
    expect(info.publicLink?.hasCustomPassword).toBe(true);
  });

  it("keeps the password when only the expiry changes", async () => {
    const photos = makePhotos({ sharing: linkResult(URL_WITH_SECRET, { customPassword: PASSWORD }) });
    const info = await setPublicLink(photos, PHOTO_UID, { expiration: EXPIRY });
    expect(sentLink(photos).customPassword).toBe(PASSWORD);
    expect(info.publicLink?.hasCustomPassword).toBe(true);
    expect(info.publicLink?.expirationTime).toBe(EXPIRY);
  });

  it("keeps both when a plain refresh names neither", async () => {
    const photos = makePhotos({
      sharing: linkResult(URL_WITH_SECRET, {
        customPassword: PASSWORD,
        expirationTime: new Date(EXPIRY),
      }),
    });
    const info = await setPublicLink(photos, PHOTO_UID);
    expect(sentLink(photos).customPassword).toBe(PASSWORD);
    expect(sentLink(photos).expiration).toEqual(new Date(EXPIRY));
    expect(info.publicLink?.hasCustomPassword).toBe(true);
  });

  // A legacy link is deleted and remade, so there is nothing left to carry a
  // setting over from, and nothing may be invented for the link that replaces it.
  it("carries nothing over when a legacy link is replaced", async () => {
    const photos = makePhotos({
      sharing: linkResult("https://drive.proton.me/urls/TOKEN#short", {
        customPassword: PASSWORD,
        expirationTime: new Date(EXPIRY),
      }),
    });
    const info = await setPublicLink(photos, PHOTO_UID);
    expect(sentLink(photos).customPassword).toBeUndefined();
    expect(sentLink(photos).expiration).toBeUndefined();
    expect(info.publicLink?.hasCustomPassword).toBe(false);
  });

  it("gives the link replacing a legacy one the password that was asked for", async () => {
    const photos = makePhotos({
      sharing: linkResult("https://drive.proton.me/urls/TOKEN#short"),
    });
    const info = await setPublicLink(photos, PHOTO_UID, { customPassword: PASSWORD });
    expect(named(photos, "unshareNode")[0].args[1]).toEqual({ publicLink: "remove" });
    expect(sentLink(photos).customPassword).toBe(PASSWORD);
    expect(info.publicLink?.hasCustomPassword).toBe(true);
  });

  // The password is the sidecar's to hold: the dialog is told whether one exists
  // and never what it is, so there is nothing for the window to leak.
  it("reports that a password exists without reporting the password", async () => {
    const photos = makePhotos({ sharing: linkResult(URL_WITH_SECRET, { customPassword: PASSWORD }) });
    const info = await getSharingInfo(photos, PHOTO_UID);
    expect(info.publicLink?.hasCustomPassword).toBe(true);
    expect(JSON.stringify(info)).not.toContain(PASSWORD);
  });
});

describe("people", () => {
  it("flattens members and both kinds of invitation into one list", async () => {
    const sharing = {
      ...emptyResult(),
      members: [{ uid: "m1", inviteeEmail: "member@proton.me", role: "editor" }],
      protonInvitations: [{ uid: "i1", inviteeEmail: "invited@proton.me", role: "viewer" }],
      nonProtonInvitations: [{ uid: "x1", inviteeEmail: "outside@example.com", role: "viewer" }],
    };
    const info = await getSharingInfo(makePhotos({ sharing }), PHOTO_UID);
    expect(info.people).toEqual([
      { uid: "m1", email: "member@proton.me", role: "editor", state: "member" },
      { uid: "i1", email: "invited@proton.me", role: "viewer", state: "invited" },
      { uid: "x1", email: "outside@example.com", role: "viewer", state: "external" },
    ]);
  });

  it("passes an invitation to the SDK with the role asked for", async () => {
    const photos = makePhotos();
    await invitePeople(photos, PHOTO_UID, ["someone@example.com"], "editor");
    expect(named(photos, "shareNode")[0].args[1]).toEqual({
      users: [{ email: "someone@example.com", role: "editor" }],
    });
  });

  it("treats any role other than editor as viewer", async () => {
    const photos = makePhotos();
    await invitePeople(photos, PHOTO_UID, ["someone@example.com"], "admin");
    expect(named(photos, "shareNode")[0].args[1]).toEqual({
      users: [{ email: "someone@example.com", role: "viewer" }],
    });
  });

  it("removes one person by address, whoever they are to the share", async () => {
    const photos = makePhotos();
    await removePerson(photos, PHOTO_UID, "someone@example.com");
    expect(named(photos, "unshareNode")[0].args[1]).toEqual({ users: ["someone@example.com"] });
  });

  it("ends everything at once with no settings, which is the SDK's full unshare", async () => {
    const photos = makePhotos();
    await stopSharing(photos, PHOTO_UID);
    expect(named(photos, "unshareNode")[0].args[1]).toBeUndefined();
  });
});

/**
 * The trace a failure leaves is the one thing here a user might be asked to
 * send on, so these pin down what it may and may not contain.
 */
describe("what a failure writes down", () => {
  /** Collects the module's stderr lines for the duration of one call. */
  async function traceOf(work: () => Promise<unknown>): Promise<string> {
    const lines: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: any) => (lines.push(String(chunk)), true));
    try {
      await work().catch(() => {});
    } finally {
      spy.mockRestore();
    }
    return lines.join("");
  }

  it("names the operation and our own refusal, and nothing about the node", async () => {
    const trace = await traceOf(() => setPublicLink(makePhotos({ type: "album" }), ALBUM_UID));
    expect(trace).toContain("op=setPublicLink");
    expect(trace).toContain("kind=SHARE_NO_ALBUM_LINK");
    expect(trace).not.toContain(ALBUM_UID);
  });

  it("keeps the SDK's own message out, uid, address, link and all", async () => {
    const photos = makePhotos();
    photos.shareNode = async () => {
      const e: any = new Error(
        `Cannot share ${PHOTO_UID} with someone@example.com: ${URL_WITH_SECRET}`,
      );
      e.name = "ValidationError";
      e.code = 2511;
      throw e;
    };
    const trace = await traceOf(() => setPublicLink(photos, PHOTO_UID));
    expect(trace).toContain("op=setPublicLink");
    expect(trace).toContain("kind=ValidationError");
    expect(trace).toContain("code=2511");
    expect(trace).not.toContain(PHOTO_UID);
    expect(trace).not.toContain("someone@example.com");
    expect(trace).not.toContain(SECRET);
    expect(trace).not.toContain("Cannot share");
  });

  // A link's password is the other secret this module handles, and a failure is
  // the one moment it is anywhere near a line of text. The SDK quotes what it
  // was given in its own messages, so the test hands it one that does.
  it("keeps a link password out, even when the failure quotes it back", async () => {
    const password = "correct horse battery";
    const photos = makePhotos();
    photos.shareNode = async () => {
      const e: any = new Error(`Rejected custom password "${password}" for ${PHOTO_UID}`);
      e.name = "ValidationError";
      throw e;
    };
    const trace = await traceOf(() => setPublicLink(photos, PHOTO_UID, { customPassword: password }));
    expect(trace).toContain("op=setPublicLink");
    expect(trace).toContain("kind=ValidationError");
    expect(trace).not.toContain(password);
    expect(trace).not.toContain("custom password");
  });

  it("writes nothing when a password is set and the call goes through", async () => {
    const trace = await traceOf(() =>
      setPublicLink(makePhotos(), PHOTO_UID, { customPassword: "correct horse battery" }),
    );
    expect(trace).toBe("");
  });

  it("writes nothing at all when the call succeeds", async () => {
    const trace = await traceOf(() => getSharingInfo(makePhotos(), PHOTO_UID));
    expect(trace).toBe("");
  });
});

describe("invitations to someone else's photos", () => {
  const invitation = (over: any = {}) => ({
    uid: "share-1~inv-1",
    invitationTime: new Date("2026-10-01T10:00:00Z"),
    addedByEmail: { ok: true, value: "anna@proton.me" },
    inviteeEmail: "me@proton.me",
    role: "viewer",
    node: { uid: "vol-theirs~album-1", name: { ok: true, value: "Lisbon" }, type: "album" },
    ...over,
  });
  const client = (list: any[], calls: Calls = []) => ({
    async *iterateInvitations() {
      yield* list;
    },
    async acceptInvitation(uid: string) {
      calls.push({ method: "acceptInvitation", args: [uid] });
    },
    async rejectInvitation(uid: string) {
      calls.push({ method: "rejectInvitation", args: [uid] });
    },
  });

  it("lists them newest first, with who sent each and what it is for", async () => {
    const older = invitation({ uid: "share-2~inv-2", invitationTime: new Date("2026-09-01T10:00:00Z") });
    const list = await listInvitations(client([older, invitation()]));
    expect(list.map((i) => i.uid)).toEqual(["share-1~inv-1", "share-2~inv-2"]);
    expect(list[0]).toEqual({
      uid: "share-1~inv-1",
      from: "anna@proton.me",
      verified: true,
      name: "Lisbon",
      type: "album",
      role: "viewer",
      time: Date.parse("2026-10-01T10:00:00Z"),
    });
  });

  it("keeps the claimed sender of an unverified invitation, marked as unverified", async () => {
    const [inv] = await listInvitations(
      client([invitation({ addedByEmail: { ok: false, error: { claimedAuthor: "anna@proton.me", error: "bad signature" } } })]),
    );
    expect(inv.from).toBe("anna@proton.me");
    expect(inv.verified).toBe(false);
  });

  it("shows the SDK's placeholder for a name it cannot read, and nothing for any other failure", async () => {
    const [placeholder, failed] = await listInvitations(
      client([
        invitation({ node: { uid: "a", type: "album", name: { ok: false, error: { name: "Unnamed", error: "x" } } } }),
        invitation({
          invitationTime: new Date("2026-01-01T00:00:00Z"),
          node: { uid: "b", type: "photo", name: { ok: false, error: new Error("decrypt") } },
        }),
      ]),
    );
    expect(placeholder.name).toBe("Unnamed");
    expect(failed.name).toBe("");
  });

  it("accepts and declines the invitation it is handed", async () => {
    const calls: Calls = [];
    const photos = client([], calls);
    await acceptInvitation(photos, "share-1~inv-1");
    await declineInvitation(photos, "share-2~inv-2");
    expect(calls).toEqual([
      { method: "acceptInvitation", args: ["share-1~inv-1"] },
      { method: "rejectInvitation", args: ["share-2~inv-2"] },
    ]);
  });
});
