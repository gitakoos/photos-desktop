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

import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";

import { CloseIcon, ContentCopyIcon, TextIcon } from "./icons";
import { useT } from "../lib/i18n";
import { rpc } from "../lib/rpc";
import { textRunLayout, type TextRead } from "../lib/textLayout";

/** Where the text is read from: a photo of the library, or a picture file on this computer. */
export type TextSource = { uid?: string; path?: string };

type Job = { state: "working" | "done" | "failed" | "unavailable"; stage: "detecting" | "reading" | null; result: TextRead | null };

export type ViewerTextState =
  | { kind: "idle" }
  /** Read ahead, without a word on screen: the text is there to select, nothing shows it. */
  | { kind: "quiet"; read: TextRead }
  | { kind: "working"; stage: "detecting" | "reading" | null }
  | { kind: "ready"; read: TextRead }
  | { kind: "message"; key: string };

/** A photo looked at this long is read ahead; one flicked past is not. */
const READ_AHEAD_MS = 300;

/** Whether Copy text is on in Settings. */
async function copyTextOn(): Promise<boolean> {
  try {
    const raw = await invoke<string | null>("store_get", { name: "settings" });
    return !!raw && (JSON.parse(raw) as { copyText?: boolean }).copyText === true;
  } catch {
    return false;
  }
}

/**
 * Copy text in the viewer, as on the phone: asked for, the photo is read on this computer and
 * its text laid over it to select and copy. With Copy text off in Settings, or its models not
 * yet on this computer, it says where to turn it on instead. With it on, a photo looked at for a
 * moment is read ahead without a word on screen, so its text can be selected straight away.
 */
export function useViewerText(source: TextSource | null, itemKey: string) {
  const [state, setState] = useState<ViewerTextState>({ kind: "idle" });
  const run = useRef(0);
  // What the read ahead found, kept when the shown text is put away again.
  const ahead = useRef<TextRead | null>(null);

  const leave = useCallback(() => {
    run.current++;
    setState(ahead.current ? { kind: "quiet", read: ahead.current } : { kind: "idle" });
  }, []);

  // Another photo is another page: whatever was read leaves with the one it was read from.
  useEffect(
    () => () => {
      run.current++;
      ahead.current = null;
      setState({ kind: "idle" });
    },
    [itemKey],
  );

  // The read ahead: quiet, and silent when it finds nothing or cannot run.
  useEffect(() => {
    if (!source) return;
    const id = run.current;
    const timer = window.setTimeout(async () => {
      if (id !== run.current || !(await copyTextOn())) return;
      try {
        const { id: job } = await rpc<{ id: number }>("ocrStart", source);
        for (;;) {
          await new Promise((r) => setTimeout(r, 250));
          if (id !== run.current) return;
          const r = await rpc<Job | null>("ocrResult", { id: job });
          if (id !== run.current || !r || r.state === "failed" || r.state === "unavailable") return;
          if (r.state === "working") continue;
          if (r.result && r.result.blocks.length > 0) {
            ahead.current = r.result;
            setState({ kind: "quiet", read: r.result });
          }
          return;
        }
      } catch {
        /* nothing read ahead; the button still asks */
      }
    }, READ_AHEAD_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source?.uid, source?.path, itemKey]);

  const start = useCallback(async () => {
    if (!source) return;
    if (ahead.current) {
      run.current++;
      setState({ kind: "ready", read: ahead.current });
      return;
    }
    const id = ++run.current;
    const on = await copyTextOn();
    if (id !== run.current) return;
    if (!on) {
      setState({ kind: "message", key: "viewer.textOff" });
      return;
    }
    setState({ kind: "working", stage: null });
    try {
      const { id: job } = await rpc<{ id: number }>("ocrStart", source);
      for (;;) {
        await new Promise((r) => setTimeout(r, 250));
        if (id !== run.current) return;
        const r = await rpc<Job | null>("ocrResult", { id: job });
        if (id !== run.current) return;
        if (!r || r.state === "failed") return setState({ kind: "message", key: "viewer.textFailed" });
        if (r.state === "unavailable") return setState({ kind: "message", key: "viewer.textNoModel" });
        if (r.state === "working") {
          setState({ kind: "working", stage: r.stage });
          continue;
        }
        if (!r.result || r.result.blocks.length === 0) return setState({ kind: "message", key: "viewer.textNone" });
        return setState({ kind: "ready", read: r.result });
      }
    } catch {
      if (id === run.current) setState({ kind: "message", key: "viewer.textFailed" });
    }
  }, [source?.uid, source?.path]);

  return { state, start, leave, active: state.kind !== "idle" && state.kind !== "quiet" };
}

/**
 * The text read off a photo, laid over it where each run sits: transparent letters the mouse
 * selects and Ctrl+C copies, on a faint wash that shows where text was found. `box` is the
 * photo's drawn rectangle inside the layer. Presses on it stay with it, so selecting never pans.
 * `quiet`, the text read ahead: no wash, and only a press on the words themselves selects; the
 * rest of the photo pans as ever.
 */
export function TextLayer({
  read,
  box,
  quiet = false,
}: {
  read: TextRead;
  box: { x: number; y: number; w: number; h: number };
  quiet?: boolean;
}) {
  const scale = box.w / read.width;
  const hold = (e: { stopPropagation: () => void }) => e.stopPropagation();
  return (
    <div
      className={`vt-layer${quiet ? " vt-quiet" : ""}`}
      onMouseDown={quiet ? undefined : hold}
      onDoubleClick={quiet ? undefined : hold}
    >
      {read.blocks.map((block, i) => {
        const run = textRunLayout(block, scale, box.x, box.y);
        return (
          <span
            key={i}
            onMouseDown={quiet ? hold : undefined}
            onDoubleClick={quiet ? hold : undefined}
            className="vt-run"
            style={{
              left: run.left,
              top: run.top,
              height: run.height,
              fontSize: run.fontSize,
              lineHeight: `${run.height}px`,
              transform: `rotate(${run.angle}rad) scaleX(${run.stretch})`,
            }}
          >
            {block.text}
            {/* A line break no one sees, so a selection across runs copies as lines. */}
            <span className="vt-sep">{"\n"}</span>
          </span>
        );
      })}
    </div>
  );
}

/**
 * A copy button while text read ahead is selected, right under the selection (over it where
 * there is no room below); Ctrl+C copies too. Nothing shows before a selection is made.
 */
export function SelectionCopy({ state }: { state: ViewerTextState }) {
  const t = useT();
  const [selected, setSelected] = useState<{ text: string; x: number; y: number; above: boolean } | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (state.kind !== "quiet") {
      setSelected(null);
      return;
    }
    const look = () => {
      const sel = document.getSelection();
      const inside = !!sel && sel.rangeCount > 0 && !!sel.anchorNode?.parentElement?.closest(".vt-layer");
      const text = inside ? sel!.toString().trim() : "";
      if (!text) {
        setSelected(null);
        return;
      }
      const box = sel!.getRangeAt(0).getBoundingClientRect();
      const above = box.bottom + COPY_GAP + COPY_HEIGHT > window.innerHeight;
      setSelected({ text, x: box.left + box.width / 2, y: above ? box.top - COPY_GAP : box.bottom + COPY_GAP, above });
      setCopied(false);
    };
    document.addEventListener("selectionchange", look);
    window.addEventListener("resize", look);
    window.addEventListener("wheel", look, { passive: true });
    return () => {
      document.removeEventListener("selectionchange", look);
      window.removeEventListener("resize", look);
      window.removeEventListener("wheel", look);
    };
  }, [state]);
  if (state.kind !== "quiet" || !selected) return null;
  return (
    <div
      className={`vt-copy${selected.above ? " above" : ""}`}
      style={{ left: selected.x, top: selected.y }}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        className="vt-pill-btn"
        onClick={() => {
          void navigator.clipboard
            .writeText(selected.text)
            .then(() => setCopied(true))
            .catch(() => {});
        }}
      >
        <ContentCopyIcon size={15} />
        <span>{t(copied ? "viewer.textCopied" : "viewer.textCopy")}</span>
      </button>
    </div>
  );
}

/** Room between the selection and its copy button, and the button's height. */
const COPY_GAP = 8;
const COPY_HEIGHT = 36;

/** What copy text is doing, at the foot of the photo: working, ready with a copy-all, or why not. */
export function TextPill({ state, onLeave }: { state: ViewerTextState; onLeave: () => void }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [state]);
  if (state.kind === "idle" || state.kind === "quiet") return null;
  const label =
    state.kind === "working"
      ? t(state.stage === "reading" ? "viewer.textReading" : "viewer.textDetecting")
      : state.kind === "ready"
        ? t("viewer.textSelectable")
        : t(state.key);
  return (
    <div className="vt-pill" role="status" aria-live="polite" onClick={(e) => e.stopPropagation()}>
      {state.kind === "working" ? <span className="pv-spinner vt-spin" aria-hidden /> : <TextIcon size={16} />}
      <span className="vt-pill-text">{label}</span>
      {state.kind === "ready" && (
        <button
          className="vt-pill-btn"
          onClick={() => {
            void navigator.clipboard
              .writeText(state.read.blocks.map((b) => b.text).join("\n"))
              .then(() => setCopied(true))
              .catch(() => {});
          }}
        >
          <ContentCopyIcon size={15} />
          <span>{t(copied ? "viewer.textCopied" : "viewer.textCopyAll")}</span>
        </button>
      )}
      <button className="vt-pill-close" onClick={onLeave} title={t("common.close")} aria-label={t("common.close")}>
        <CloseIcon size={16} />
      </button>
    </div>
  );
}
