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

import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { diag } from "./diag.ts";
import { diagnosticsReport, saveDiagnostics, withoutNames } from "./diagReport.ts";
import { initStore, setDataKey } from "./store.ts";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pfp-diag-"));
  initStore(dir);
  setDataKey(randomBytes(32));
  writeFileSync(
    join(dir, "sidecar.log"),
    "[faces] saved the copy to Drive: 3 faces, 2 photos\n[diag] 10:00:00.000 app start\nC:\\Users\\Anna\\x.jpg failed\n",
  );
});

describe("the diagnostics report", () => {
  it("starts with the window's header and how each part stands, and ends with the log", () => {
    diag.log("upload", "file", { ms: 5 });
    const { text } = diagnosticsReport(["App 1.2.0", "Settings: faces=on <script>"]);
    expect(text).toMatch(/^Photos for Proton diagnostics\nApp 1\.2\.0\nSettings: faces=on _script_\n/);
    expect(text).toContain("Faces: off");
    expect(text).toContain("Shared backup: off");
    expect(text).toContain("upload file ms=5");
    expect(text).toContain("[faces] saved the copy to Drive: 3 faces, 2 photos");
    expect(text).not.toContain("[diag] 10:00:00.000 app start");
    expect(text).not.toContain("Anna");
    expect(text).not.toContain("x.jpg");
  });

  it("takes paths and file names out of the log lines it carries", () => {
    expect(withoutNames("sharp: Input file is missing: C:\\Users\\Anna\\Pictures\\beach 2.jpg")).toBe(
      "sharp: Input file is missing: [path]",
    );
    expect(withoutNames("open /home/anna/photos/x.png failed")).toBe("open [path] failed");
    expect(withoutNames("[upload] done album: 3/5 uploaded in 1.25 s, v1.2.0")).toBe("[upload] done album: 3/5 uploaded in 1.25 s, v1.2.0");
    expect(withoutNames("IMG_20230512.HEIC could not be read")).toBe("[file] could not be read");
  });

  it("is saved only as a text file at a full path", async () => {
    await expect(saveDiagnostics("report.txt", [])).rejects.toThrow();
    await expect(saveDiagnostics(join(dir, "report.exe"), [])).rejects.toThrow();
    await saveDiagnostics(join(dir, "report.txt"), ["App 1.2.0"]);
    expect(readFileSync(join(dir, "report.txt"), "utf8")).toContain("App 1.2.0");
  });
});
