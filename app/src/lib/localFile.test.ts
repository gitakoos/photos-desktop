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


import { describe, it, expect } from "vitest";
import { deletePrompt, isCancelled, isNameTaken, untilNameFree } from "./localFile";
import { en } from "./locales/en";
import { hu } from "./locales/hu";
import { de } from "./locales/de";
import { cs } from "./locales/cs";
import { es } from "./locales/es";
import { fr } from "./locales/fr";
import { it as itLocale } from "./locales/it";
import { nl } from "./locales/nl";
import { pl } from "./locales/pl";
import { sk } from "./locales/sk";
import { sl } from "./locales/sl";

const locales = { en, hu, de, cs, es, fr, it: itLocale, nl, pl, sk, sl };

describe("deletePrompt", () => {
  it("asks the platform's own question while the host can trash the file or has not said", () => {
    expect(deletePrompt(true, "windows")).toEqual({ kind: "confirm", messageKey: "local.deleteMessage" });
    expect(deletePrompt(undefined, "mac")).toEqual({ kind: "confirm", messageKey: "local.deleteMessageMac" });
    expect(deletePrompt(true, "linux")).toEqual({ kind: "confirm", messageKey: "local.deleteMessageLinux" });
  });

  it("says the file is out of reach instead of asking, before anything is confirmed", () => {
    expect(deletePrompt(false, "linux")).toEqual({
      kind: "outOfReach",
      titleKey: "local.trashOutOfReachTitleLinux",
      messageKey: "local.trashOutOfReachLinux",
    });
  });

  it("has every key it can name in all 11 languages, with the file's name in the message", () => {
    const keys = [deletePrompt(false, "linux"), deletePrompt(true, "linux")].flatMap((p) =>
      p.kind === "outOfReach" ? [p.titleKey, p.messageKey] : [p.messageKey],
    );
    for (const [code, table] of Object.entries(locales)) {
      for (const key of keys) expect(table[key], `${code} ${key}`).toBeTruthy();
      expect(table["local.trashOutOfReachLinux"], code).toContain("{name}");
    }
  });
});

describe("saving an edited copy where the save dialog asks", () => {
  // As the save command words it for a name that is already there.
  const TAKEN = "name taken: a file with that name is already there, so nothing was written";

  it("reads a dismissed dialog as nothing done, and anything else as a failure", () => {
    expect(isCancelled("cancelled")).toBe(true);
    expect(isCancelled(new Error("cancelled"))).toBe(true);
    expect(isCancelled(TAKEN)).toBe(false);
  });

  it("asks again while the picked name is taken, and stops on a dismissed dialog or a failure", async () => {
    expect(isNameTaken(TAKEN)).toBe(true);
    expect(isNameTaken("cancelled")).toBe(false);

    const answers: unknown[] = [TAKEN, TAKEN, "saved.jpg"];
    let told = 0;
    const attempt = () => {
      const next = answers.shift();
      return next === "saved.jpg" ? Promise.resolve(next) : Promise.reject(next);
    };
    await expect(untilNameFree(attempt, () => told++)).resolves.toBe("saved.jpg");
    expect(told).toBe(2);

    const dismissed: unknown[] = [TAKEN, "cancelled"];
    await expect(untilNameFree(() => Promise.reject(dismissed.shift()), () => {})).rejects.toBe("cancelled");
    await expect(untilNameFree(() => Promise.reject("disk full"), () => {})).rejects.toBe("disk full");
  });

  it("has its wording in all 11 languages", () => {
    const keys = [
      "editor.saveCopyWhereLinux",
      "editor.saveSheet.copyComputerPickSubLinux",
      "videoEditor.saveComputerPickLinux",
      "editor.nameTakenLinux",
    ];
    for (const [code, table] of Object.entries(locales)) {
      for (const key of keys) expect(table[key], `${code} ${key}`).toBeTruthy();
    }
  });
});
