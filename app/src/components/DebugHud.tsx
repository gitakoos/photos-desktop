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

import { useEffect, useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import { thumbCacheSize } from "../lib/thumbStore";
import { previewCacheSize } from "../lib/previewStore";
import "../styles/DebugHud.css";

type Heap = { rss: number; heapUsed: number; heapTotal: number };
const mb = (bytes: number) => Math.round(bytes / 1048576);

/**
 * A tiny live memory HUD, shown only when debug mode is on (Settings). Samples
 * every 1.5s, keeps ~90s of history, and copies the whole series to the
 * clipboard on click so it is easy to paste a "does the heap keep growing?" trace.
 */
export function DebugHud({ itemCount }: { itemCount: number }) {
  const [line, setLine] = useState("sampling...");
  const [copied, setCopied] = useState(false);
  const history = useRef<string[]>([]);
  const start = useRef(performance.now());
  // Read the live count inside the poll without making it an effect dependency:
  // the timeline count climbs from 0 to the whole library as it loads, and
  // re-subscribing on every change would tear down and restart the interval each
  // time, firing a burst of extra heapStats calls during exactly the busy startup.
  const itemCountRef = useRef(itemCount);
  itemCountRef.current = itemCount;

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      const h = await rpc<Heap>("heapStats").catch(() => null);
      if (!alive) return;
      const js = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
      const secs = Math.round((performance.now() - start.current) / 1000);
      const l = [
        `t+${secs}s`,
        js ? `js=${mb(js.usedJSHeapSize)}MB` : "js=?",
        h ? `sidecar=${mb(h.heapUsed)}/${mb(h.rss)}MB` : "sidecar=?",
        `thumbs=${thumbCacheSize()}`,
        `prev=${previewCacheSize()}`,
        `items=${itemCountRef.current}`,
      ].join("  ");
      setLine(l);
      history.current.push(l);
      if (history.current.length > 60) history.current.shift();
    };
    void poll();
    const id = setInterval(poll, 1500);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const copy = () => {
    void navigator.clipboard.writeText(history.current.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="debug-hud" onClick={copy} title="Click to copy the last ~90s of readings">
      <div className="debug-hud-title">{copied ? "copied ✓" : "debug · click to copy"}</div>
      <div className="debug-hud-line">{line}</div>
    </div>
  );
}
