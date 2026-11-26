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

import { describe, expect, it } from "vitest";
import { errorText, newCaptureTime, type DateEditInfo, type DateEditInput } from "./dateEdit";

const taken = new Date(2024, 4, 10, 14, 25, 30).getTime();
const photo = (over: Partial<DateEditInfo> = {}): DateEditInfo => ({
  uid: "v~a",
  name: "IMG_20210604_103000.jpg",
  captureMs: taken,
  nameMs: new Date(2021, 5, 4, 10, 30, 0).getTime(),
  place: null,
  blocked: null,
  ...over,
});
const input = (over: Partial<DateEditInput> = {}): DateEditInput => ({
  date: "2020-01-02",
  time: "",
  shift: { days: 0, hours: 0, minutes: 0 },
  ...over,
});

describe("the date a photo gets in the date editor", () => {
  it("sets a day and keeps the photo's own time when no time is given", () => {
    expect(newCaptureTime(photo(), "set", input())).toEqual({ kind: "change", captureMs: new Date(2020, 0, 2, 14, 25, 30).getTime() });
  });

  it("sets a day and a time for one photo", () => {
    expect(newCaptureTime(photo(), "set", input({ time: "08:05" }))).toEqual({ kind: "change", captureMs: new Date(2020, 0, 2, 8, 5, 0).getTime() });
  });

  it("shifts by days, hours and minutes, either way", () => {
    expect(newCaptureTime(photo(), "shift", input({ shift: { days: -1, hours: 2, minutes: -30 } }))).toEqual({
      kind: "change",
      captureMs: taken + (-24 + 2) * 3_600_000 - 30 * 60_000,
    });
  });

  it("takes the date the file name records, and says so when there is none", () => {
    expect(newCaptureTime(photo(), "name", input())).toEqual({ kind: "change", captureMs: new Date(2021, 5, 4, 10, 30, 0).getTime() });
    expect(newCaptureTime(photo({ nameMs: null }), "name", input())).toEqual({ kind: "noName" });
  });

  it("leaves a photo that already has the date, one that cannot change, and a date that is not one", () => {
    expect(newCaptureTime(photo(), "shift", input())).toEqual({ kind: "same" });
    expect(newCaptureTime(photo({ blocked: "live" }), "set", input())).toEqual({ kind: "live" });
    expect(newCaptureTime(photo(), "set", input({ date: "" }))).toEqual({ kind: "invalid" });
  });
});

describe("errorText", () => {
  const t = (key: string, vars?: Record<string, string | number>) => `[${key}${vars ? ` ${JSON.stringify(vars)}` : ""}]`;

  it("words a photo still being changed in the window's language, and shows other reasons as given", () => {
    expect(errorText({ uid: "a", error: "This photo is still being changed.", code: "busy" }, t)).toBe("[dateEdit.busy]");
    expect(errorText({ uid: "a", error: "The original could not be moved to the trash" }, t)).toBe("The original could not be moved to the trash");
  });

  it("words a paused run with the count of photos left, in the window's language", () => {
    expect(errorText({ uid: "paused", error: "Drive stopped answering", code: "paused", left: 7 }, t)).toBe(
      '[dateEdit.paused {"photos":"[common.photoCount.other {\\"count\\":7}]"}]',
    );
    expect(errorText({ uid: "paused", error: "Drive stopped answering", code: "paused", left: 1 }, t)).toBe(
      '[dateEdit.paused {"photos":"[common.photoCount.one {\\"count\\":1}]"}]',
    );
  });
});
