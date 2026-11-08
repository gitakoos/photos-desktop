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

// Where the face models run. On Windows the graphics card takes them through DirectML, which
// any DirectX 12 card offers, built in or separate, from any maker; the runtime loads the copy
// Windows itself carries, so nothing of it ships with the app. Where that is missing, too old,
// or fails, the processor runs them instead, on a few threads when the work is background
// work, so the computer stays usable while a library is scanned.

export type Accel = "gpu" | "cpu";

/** Processor threads for background work: enough to make progress, few enough to go unnoticed. */
export const BACKGROUND_THREADS = 2;

/** Set once the graphics card has failed this run; everything opened after it uses the processor. */
let gpuFailed = false;

export function gpuUsable(): boolean {
  return process.platform === "win32" && !gpuFailed;
}

/** The graphics card is not to be tried again until the sidecar restarts. */
export function markGpuFailed(reason: string): void {
  if (gpuFailed) return;
  gpuFailed = true;
  // The error's class only: its text can carry a driver path.
  process.stderr.write(`[inference] the graphics card is not used: ${reason}\n`);
}

export type ModelSession = { session: any; accel: Accel };

/**
 * Opens `path` on the graphics card when one is usable, else on the processor. `background`
 * holds a processor session to `BACKGROUND_THREADS`; an interactive one takes them all. The
 * half-precision CLIP models take the basic graph optimisation, as on the phone.
 */
export async function openModel(
  path: string,
  background: boolean,
  optimization: "all" | "basic" = "all",
): Promise<ModelSession> {
  const ort = await import("onnxruntime-node");
  if (gpuUsable()) {
    try {
      const session = await ort.InferenceSession.create(path, {
        executionProviders: [{ name: "dml" }],
        graphOptimizationLevel: optimization,
        // DirectML needs both: it neither reuses memory patterns nor runs nodes in parallel.
        enableMemPattern: false,
        executionMode: "sequential",
        logSeverityLevel: 3,
      });
      return { session, accel: "gpu" };
    } catch (e) {
      markGpuFailed((e as Error)?.name ?? "open failed");
    }
  }
  const session = await ort.InferenceSession.create(path, {
    executionProviders: ["cpu"],
    graphOptimizationLevel: optimization,
    ...(background ? { intraOpNumThreads: BACKGROUND_THREADS, interOpNumThreads: 1 } : {}),
    logSeverityLevel: 3,
  });
  return { session, accel: "cpu" };
}
