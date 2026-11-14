/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * This file is part of Photos for Proton, free software under the GNU General Public
 * License version 3. See <https://www.gnu.org/licenses/>.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { FaceCover } from "./Library";
import { CloseIcon, FaceIcon } from "./icons";
import { rpc } from "../lib/rpc";
import { useThumbnails } from "../hooks/useThumbnails";
import { useT } from "../lib/i18n";
import { personNameKey } from "../lib/personName";
import "../styles/Confirm.css";
import "../styles/AlbumDialogs.css";
import "../styles/PersonSplit.css";

type Box = [number, number, number, number];
type SplitFace = { faceId: string; uid: string; box: Box; year?: number };
type Start = {
  personId: string;
  name: string | null;
  faces: number;
  pairs: { left: SplitFace; right: SplitFace }[];
  contrast: SplitFace[];
  elsewhere: { name: string; faceIds: string[]; sample: SplitFace[] }[];
};
type Plan = {
  counts: { a: number; b: number; unsure: number };
  checked: { right: number; tried: number };
  clearShare: number;
  verdict: "reliable" | "weak" | "unreliable" | "few";
  leastSureA: SplitFace[];
  leastSureB: SplitFace[];
  unsure: (SplitFace & { lean: "a" | "b" | "even" | "none" })[];
  byYear: { year: number | null; a: number; b: number; unsure: number }[];
  waiting: number[];
};

/** Years as the shortest text: runs of years as "2016–2019", the rest by commas, newest first. */
function yearsText(years: number[]): string {
  const sorted = [...years].sort((x, y) => y - x);
  const runs: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] - 1) j++;
    runs.push(j > i ? `${sorted[j]}–${sorted[i]}` : String(sorted[i]));
    i = j + 1;
  }
  return runs.join(", ");
}
type Applied = { stayed: number; moved: number; unsure: number; undo: string };
type Undone = { ok: boolean; restored: number; skipped: number };
type Side = "a" | "b";

/** Unsure faces shown at once in the review. */
const REVIEW_PAGE = 12;

/** Faces another device named as the other person used as examples, at most. */
const ELSEWHERE_KEPT = 200;

/** Names compared as the people code compares them (accents kept). */
const same = (x: string, y: string) => personNameKey(x) === personNameKey(y);
/** Loose matching for the suggestions as the name is typed, accents aside. */
const loose = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase().trim();

/**
 * Splitting a person in two (see the sidecar's faceSplit): naming the other person, picking a
 * few faces of each, a preview of the split with how far to trust it, the unsure faces to
 * answer, and the split carried out with an undo. `act` runs a face call and reads the people
 * again afterwards, as every other change to the people does.
 */
export function PersonSplit({
  personId,
  name,
  names,
  act,
  onClose,
}: {
  personId: string;
  /** The person's name, or null while unnamed. */
  name: string | null;
  /** Everyone else already named, offered as the other person. */
  names: string[];
  act: <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
  onClose: () => void;
}) {
  const t = useT();
  const here = name ?? t("faces.split.thisPerson");
  const [step, setStep] = useState<"name" | "pick" | "preview" | "review" | "done">("name");
  const [start, setStart] = useState<Start | null>(null);
  const [error, setError] = useState("");
  const [other, setOther] = useState("");
  const [picks, setPicks] = useState<Map<string, Side>>(new Map());
  const [plan, setPlan] = useState<Plan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [applied, setApplied] = useState<Applied | null>(null);
  const [busy, setBusy] = useState(false);
  const [reviewed, setReviewed] = useState<Set<string>>(new Set());
  // The faces shown to answer stay where they are while answered: each answer works the split
  // out again, and lists that followed it moved the faces under the pointer. A page of the
  // review, and the preview's least-sure faces, change only when asked for.
  const [reviewPage, setReviewPage] = useState<Plan["unsure"] | null>(null);
  const [strips, setStrips] = useState<{ a: SplitFace[]; b: SplitFace[] } | null>(null);
  const stripsTouched = useRef(false);
  // Whether the faces another device named as the other person count as examples of them.
  const [useElsewhere, setUseElsewhere] = useState<boolean | null>(null);

  useEffect(() => {
    let live = true;
    rpc<Start>("faceSplitStart", { id: personId }).then(
      (s) => live && setStart(s),
      (e) => live && setError(String(e)),
    );
    return () => {
      live = false;
    };
  }, [personId]);

  // Escape closes it, before anything under it hears the key; not once it is done, where the
  // undo is offered and closing is a choice of its own.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (step !== "done" && !busy) onClose();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [step, onClose, busy]);

  const suggestions = useMemo(() => {
    const q = loose(other);
    const pool = [...new Set([...(start?.elsewhere.map((e) => e.name) ?? []), ...names])];
    return pool.filter((n) => !same(n, here) && (!q || loose(n).includes(q))).slice(0, 6);
  }, [other, names, start, here]);

  // Kept as the same arrays from one draw to the next, so the split is worked out again only
  // when the picks change.
  const a = useMemo(() => [...picks].filter(([, s]) => s === "a").map(([id]) => id), [picks]);
  const b = useMemo(() => [...picks].filter(([, s]) => s === "b").map(([id]) => id), [picks]);
  const otherName = other.trim();
  const sameName = !!otherName && same(otherName, here);

  // What another device said, for the name chosen: offered as examples of that person. On at
  // first only when they are a small share of the person; a device that named the whole merged
  // group the other name would otherwise make everything an example of them.
  const elsewhere = useMemo(() => start?.elsewhere.find((e) => same(e.name, otherName)) ?? null, [start, otherName]);
  const elsewhereByDefault = !!elsewhere && !!start && elsewhere.faceIds.length <= Math.max(25, start.faces * 0.25);
  const fromElsewhere = useMemo(
    () => ((useElsewhere ?? elsewhereByDefault) && elsewhere ? elsewhere.faceIds.slice(0, ELSEWHERE_KEPT) : []),
    [useElsewhere, elsewhereByDefault, elsewhere],
  );
  const bWithElsewhere = useMemo(() => [...new Set([...b, ...fromElsewhere])], [b, fromElsewhere]);
  const picksKey = `${a.join(",")}|${bWithElsewhere.join(",")}`;

  // The split worked out again as examples change, a moment after the last change.
  const planned = useRef(0);
  useEffect(() => {
    if (step !== "preview" && step !== "review") return;
    if (a.length === 0 || bWithElsewhere.length === 0) {
      planned.current++;
      setPlanning(false);
      return;
    }
    const ticket = ++planned.current;
    setPlanning(true);
    setError("");
    const timer = window.setTimeout(() => {
      rpc<Plan>("faceSplitPlan", { id: personId, other: otherName, a, b: bWithElsewhere }).then(
        (p) => {
          if (planned.current !== ticket) return;
          setPlan(p);
          setPlanning(false);
        },
        (e) => {
          // A preview given up for a newer one is not an error: the newer one answers.
          if (planned.current !== ticket || String(e).includes("superseded")) return;
          setError(String(e));
          setPlanning(false);
        },
      );
    }, 300);
    return () => window.clearTimeout(timer);
    // The picks are read through `picksKey`, which changes exactly when they do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, picksKey, personId, otherName]);

  // The preview's least-sure faces follow the split until one of them is clicked; then they
  // stay until "show others".
  useEffect(() => {
    if (plan && (!strips || !stripsTouched.current)) setStrips({ a: plan.leastSureA, b: plan.leastSureB });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan]);

  /** The next page of unsure faces to answer: neither answered nor skipped, nor on this page. */
  const nextReviewPage = () => {
    if (!plan) return [];
    const onPage = new Set((reviewPage ?? []).map((f) => f.faceId));
    return plan.unsure.filter((f) => !picks.has(f.faceId) && !reviewed.has(f.faceId) && !onPage.has(f.faceId)).slice(0, REVIEW_PAGE);
  };
  useEffect(() => {
    // Back in the preview from elsewhere, its least-sure faces follow the split again.
    if (step !== "preview") stripsTouched.current = false;
    else if (plan) setStrips({ a: plan.leastSureA, b: plan.leastSureB });
    if (step !== "review") setReviewPage(null);
    else if (reviewPage === null && plan) setReviewPage(nextReviewPage());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, plan]);

  // Pictures for exactly the faces on screen, and the review's next page ahead of time.
  const shown = useMemo(() => {
    const faces: SplitFace[] = [];
    if (start) {
      for (const p of start.pairs) faces.push(p.left, p.right);
      faces.push(...start.contrast);
      for (const e of start.elsewhere) faces.push(...e.sample);
    }
    if (reviewPage) faces.push(...reviewPage);
    if (strips && step === "preview") faces.push(...strips.a, ...strips.b);
    if (plan && step === "review") {
      const onPage = new Set((reviewPage ?? []).map((f) => f.faceId));
      faces.push(...plan.unsure.filter((f) => !onPage.has(f.faceId) && !picks.has(f.faceId) && !reviewed.has(f.faceId)).slice(0, REVIEW_PAGE));
    }
    return faces;
  }, [start, strips, reviewPage, plan, step, picks, reviewed]);
  const thumbs = useThumbnails(useMemo(() => [...new Set(shown.map((f) => f.uid))], [shown]));

  const choose = (faceId: string, side: Side | null) =>
    setPicks((before) => {
      const next = new Map(before);
      if (side === null || next.get(faceId) === side) next.delete(faceId);
      else next.set(faceId, side);
      return next;
    });

  async function apply() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const out = await act<Applied>("faceSplitApply", { id: personId, other: otherName, a, b: bWithElsewhere });
      setApplied(out);
      setStep("done");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function undo() {
    if (!applied || busy) return;
    setBusy(true);
    try {
      const out = await act<Undone>("faceSplitUndo", { token: applied.undo });
      if (!out.ok) {
        setError(t("faces.split.undoGone"));
        setBusy(false);
        return;
      }
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  const face = (f: SplitFace, extra?: string) => (
    <span className={`ps-face${extra ? ` ${extra}` : ""}`}>
      {thumbs[f.uid] ? (
        <span className="lib-facebox">
          <FaceCover uid={f.uid} thumb={thumbs[f.uid]!} box={f.box} />
        </span>
      ) : (
        <span className="ps-face-empty">
          <FaceIcon size={22} />
        </span>
      )}
    </span>
  );

  const sideButtons = (faceId: string) => (
    <span className="ps-sides">
      <button className={`ps-side a${picks.get(faceId) === "a" ? " on" : ""}`} aria-pressed={picks.get(faceId) === "a"} onClick={() => choose(faceId, "a")}>
        {here}
      </button>
      <button
        className={`ps-side b${picks.get(faceId) === "b" ? " on" : ""}`}
        aria-pressed={picks.get(faceId) === "b"}
        disabled={!otherName}
        onClick={() => choose(faceId, "b")}
      >
        {otherName || "…"}
      </button>
    </span>
  );

  // Said whenever the split is being worked out again, so a wait never looks like nothing.
  const working = (
    <span className={`ps-working${planning ? " on" : ""}`} role="status" aria-live="polite">
      {planning ? t("faces.split.working") : ""}
    </span>
  );

  const unsureLeft = plan ? plan.unsure.filter((f) => !picks.has(f.faceId) && !reviewed.has(f.faceId)) : [];
  const pageAnswered = (reviewPage ?? []).every((f) => picks.has(f.faceId) || reviewed.has(f.faceId));

  return (
    // Closed by a press on the backdrop itself, not by a click: a click that began in a field
    // inside (selecting a name by dragging) and ended outside must not close it.
    <div
      className="cf-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && step !== "done" && !busy) onClose();
      }}
    >
      <div className="cf-panel ad-picker ps-panel" role="dialog" aria-modal="true" aria-label={t("faces.split.title", { name: here })} onClick={(e) => e.stopPropagation()}>
        <div className="ad-picker-head">
          <div className="ad-picker-titles">
            <h3 className="cf-title">{t("faces.split.title", { name: here })}</h3>
            {start && <p className="cf-msg">{t("faces.split.faceCount", { count: start.faces.toLocaleString() })}</p>}
          </div>
          {step !== "done" && (
            <button className="ad-close" disabled={busy} onClick={onClose} title={t("common.cancel")} aria-label={t("common.cancel")}>
              <CloseIcon size={18} />
            </button>
          )}
        </div>

        {error && <p className="ps-error">{error}</p>}

        {step === "name" && (
          <div className="ps-body">
            <label className="ps-label" htmlFor="ps-other">
              {t("faces.split.otherLabel")}
            </label>
            <p className="cf-msg">{t("faces.split.otherHint", { name: here })}</p>
            <input
              id="ps-other"
              className="ps-input"
              autoFocus
              maxLength={100}
              value={other}
              placeholder={t("faces.split.otherPlaceholder")}
              onChange={(e) => setOther(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && otherName && !sameName) setStep("pick");
              }}
            />
            {sameName && <p className="ps-error">{t("faces.split.sameName")}</p>}
            {suggestions.length > 0 && (
              <div className="ps-chips">
                {suggestions.map((s) => (
                  <button key={s} className="ps-chip" onClick={() => setOther(s)}>
                    {s}
                  </button>
                ))}
              </div>
            )}
            {start && start.elsewhere.length > 0 && (
              <div className="ps-elsewhere">
                {start.elsewhere.map((e) => (
                  <button key={e.name} className="ps-elsewhere-row" onClick={() => setOther(e.name)}>
                    <span className="ps-strip">{e.sample.slice(0, 4).map((f) => <span key={f.faceId}>{face(f, "small")}</span>)}</span>
                    <span>{t("faces.split.elsewhere", { count: e.faceIds.length.toLocaleString(), name: e.name })}</span>
                  </button>
                ))}
                <p className="ps-note">{t("faces.split.elsewhereHint")}</p>
                {elsewhere && (
                  <label className="ps-check">
                    <input
                      type="checkbox"
                      checked={useElsewhere ?? elsewhereByDefault}
                      onChange={(e) => setUseElsewhere(e.currentTarget.checked)}
                    />
                    <span>{t("faces.split.useElsewhere", { count: Math.min(elsewhere.faceIds.length, ELSEWHERE_KEPT).toLocaleString(), name: elsewhere.name })}</span>
                  </label>
                )}
              </div>
            )}
            <div className="ps-actions">
              <button className="cf-btn" onClick={onClose}>
                {t("common.cancel")}
              </button>
              <button className="cf-btn primary" disabled={!otherName || sameName || !start} onClick={() => setStep("pick")}>
                {start || error ? t("faces.split.next") : t("faces.split.loading")}
              </button>
            </div>
          </div>
        )}

        {step === "pick" && start && (
          <div className="ps-body">
            <div className="ps-counts">
              <span className="ps-count a">{t("faces.split.examples", { name: here, count: a.length })}</span>
              <span className="ps-count b">
                {t("faces.split.examples", { name: otherName, count: bWithElsewhere.length })}
              </span>
              <span className="ps-note">{t("faces.split.pickHint")}</span>
            </div>
            {start.pairs.length > 0 && (
              <section className="ps-section">
                <h4 className="ps-h">{t("faces.split.pairs")}</h4>
                <p className="ps-note">{t("faces.split.pairsHint")}</p>
                <div className="ps-pairs">
                  {start.pairs.map((p) => {
                    const leftA = picks.get(p.left.faceId) === "a" && picks.get(p.right.faceId) === "b";
                    const leftB = picks.get(p.left.faceId) === "b" && picks.get(p.right.faceId) === "a";
                    // Two faces of one of them in one photo (a collage, a mirror, a photo of a photo).
                    const bothSide =
                      picks.get(p.left.faceId) && picks.get(p.left.faceId) === picks.get(p.right.faceId)
                        ? picks.get(p.left.faceId)!
                        : null;
                    const setBoth = (side: Side) =>
                      setPicks((before) => {
                        const next = new Map(before);
                        const was = before.get(p.left.faceId);
                        if (was && was === before.get(p.right.faceId) && was === side) {
                          next.delete(p.left.faceId);
                          next.delete(p.right.faceId);
                        } else {
                          next.set(p.left.faceId, side);
                          next.set(p.right.faceId, side);
                        }
                        return next;
                      });
                    const set = (l: Side | null) =>
                      setPicks((before) => {
                        const next = new Map(before);
                        if (l === null) {
                          next.delete(p.left.faceId);
                          next.delete(p.right.faceId);
                        } else {
                          next.set(p.left.faceId, l);
                          next.set(p.right.faceId, l === "a" ? "b" : "a");
                        }
                        return next;
                      });
                    return (
                      <div key={p.left.faceId} className={`ps-pair${leftA || leftB || bothSide ? " on" : ""}`}>
                        <span className="ps-pair-faces">
                          {face(p.left, leftA ? "a" : leftB ? "b" : (bothSide ?? undefined))}
                          {face(p.right, leftA ? "b" : leftB ? "a" : (bothSide ?? undefined))}
                        </span>
                        <button className="ps-pair-pick" aria-pressed={leftA || leftB} disabled={!otherName} onClick={() => set(leftA ? "b" : leftB ? null : "a")}>
                          {leftA
                            ? t("faces.split.leftRight", { left: here, right: otherName })
                            : leftB
                              ? t("faces.split.leftRight", { left: otherName, right: here })
                              : t("faces.split.whoIsWho")}
                        </button>
                        <span className="ps-pair-both">
                          <span>{t("faces.split.bothAre")}</span>
                          <button className={`ps-side a${bothSide === "a" ? " on" : ""}`} aria-pressed={bothSide === "a"} onClick={() => setBoth("a")}>
                            {here}
                          </button>
                          <button
                            className={`ps-side b${bothSide === "b" ? " on" : ""}`}
                            aria-pressed={bothSide === "b"}
                            disabled={!otherName}
                            onClick={() => setBoth("b")}
                          >
                            {otherName || "…"}
                          </button>
                        </span>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}
            <section className="ps-section">
              <h4 className="ps-h">{t(start.contrast.some((f) => f.year) ? "faces.split.contrastByYear" : "faces.split.contrast")}</h4>
              {start.contrast.some((f) => f.year) && <p className="ps-note">{t("faces.split.contrastByYearHint")}</p>}
              <div className="ps-grid">
                {start.contrast.map((f) => (
                  <div key={f.faceId} className={`ps-cell${picks.get(f.faceId) ? ` ${picks.get(f.faceId)}` : ""}`}>
                    {face(f)}
                    {f.year && <span className="ps-year">{f.year}</span>}
                    {sideButtons(f.faceId)}
                  </div>
                ))}
              </div>
            </section>
            <div className="ps-actions">
              <button className="cf-btn" onClick={() => setStep("name")}>
                {t("faces.split.back")}
              </button>
              <button className="cf-btn primary" disabled={a.length === 0 || bWithElsewhere.length === 0} onClick={() => setStep("preview")}>
                {t("faces.split.preview")}
              </button>
            </div>
          </div>
        )}

        {step === "preview" && (
          <div className="ps-body">
            {plan && working}
            {!plan ? (
              <p className="cf-msg">{t("faces.split.planning")}</p>
            ) : (
              <>
                <div className={`ps-bar${planning ? " busy" : ""}`} role="img" aria-label={`${here} ${plan.counts.a}, ${otherName} ${plan.counts.b}`}>
                  <span className="ps-bar-a" style={{ flexGrow: plan.counts.a }} />
                  <span className="ps-bar-b" style={{ flexGrow: plan.counts.b }} />
                  <span className="ps-bar-u" style={{ flexGrow: plan.counts.unsure }} />
                </div>
                <div className="ps-legend">
                  <span><strong className="a">{here}</strong> {plan.counts.a.toLocaleString()}</span>
                  <span><strong className="b">{otherName}</strong> {plan.counts.b.toLocaleString()}</span>
                  <span><strong>{t("faces.split.unsure")}</strong> {plan.counts.unsure.toLocaleString()}</span>
                </div>
                <div className={`ps-verdict ${plan.verdict}`}>
                  <strong>{t(`faces.split.verdict.${plan.verdict}`)}</strong>
                  <span>
                    {t(`faces.split.verdictHint.${plan.verdict}`, {
                      right: plan.checked.right,
                      tried: plan.checked.tried,
                      share: Math.round(plan.clearShare * 100),
                    })}
                  </span>
                </div>
                <p className="ps-note">{t("faces.split.unsureNote", { name: here })}</p>
                {plan.byYear.filter((r) => r.year !== null).length > 1 && (
                  <section className="ps-section">
                    <h4 className="ps-h">{t("faces.split.byYear")}</h4>
                    <div className="ps-years">
                      {plan.byYear.map((r) => (
                        <div key={r.year ?? "none"} className="ps-year-row">
                          <span className="ps-year-label">{r.year ?? t("faces.split.undated")}</span>
                          <span className="ps-bar small" role="img" aria-label={`${here} ${r.a}, ${otherName} ${r.b}, ${t("faces.split.unsure")} ${r.unsure}`}>
                            <span className="ps-bar-a" style={{ flexGrow: r.a }} />
                            <span className="ps-bar-b" style={{ flexGrow: r.b }} />
                            <span className="ps-bar-u" style={{ flexGrow: r.unsure }} />
                          </span>
                          <span className="ps-year-counts">
                            <strong className="a">{r.a}</strong> · <strong className="b">{r.b}</strong> · {r.unsure}
                          </span>
                        </div>
                      ))}
                    </div>
                  </section>
                )}
                {plan.waiting.length > 0 && (
                  <p className="ps-note">{t("faces.split.waiting", { years: yearsText(plan.waiting) })}</p>
                )}
                <div className="ps-columns">
                  <section className="ps-section">
                    <h4 className="ps-h a">{t("faces.split.leastSure", { name: here })}</h4>
                    <div className="ps-strip wrap">
                      {(strips?.a ?? []).map((f) => (
                        <button
                          key={f.faceId}
                          className="ps-move"
                          title={t("faces.split.moveTo", { name: otherName })}
                          aria-label={t("faces.split.moveTo", { name: otherName })}
                          disabled={planning && !stripsTouched.current}
                          onClick={() => {
                            stripsTouched.current = true;
                            choose(f.faceId, picks.get(f.faceId) === "b" ? null : "b");
                          }}
                        >
                          {face(f, picks.get(f.faceId) ?? "a")}
                        </button>
                      ))}
                    </div>
                  </section>
                  <section className="ps-section">
                    <h4 className="ps-h b">{t("faces.split.leastSure", { name: otherName })}</h4>
                    <div className="ps-strip wrap">
                      {(strips?.b ?? []).map((f) => (
                        <button
                          key={f.faceId}
                          className="ps-move"
                          title={t("faces.split.moveTo", { name: here })}
                          aria-label={t("faces.split.moveTo", { name: here })}
                          disabled={planning && !stripsTouched.current}
                          onClick={() => {
                            stripsTouched.current = true;
                            choose(f.faceId, picks.get(f.faceId) === "a" ? null : "a");
                          }}
                        >
                          {face(f, picks.get(f.faceId) ?? "b")}
                        </button>
                      ))}
                    </div>
                  </section>
                </div>
                <p className="ps-note">
                  {t("faces.split.wrongOne")}{" "}
                  <button
                    className="ps-skip"
                    disabled={planning}
                    onClick={() => {
                      stripsTouched.current = false;
                      setStrips({ a: plan.leastSureA, b: plan.leastSureB });
                    }}
                  >
                    {t("faces.split.otherFaces")}
                  </button>
                </p>
              </>
            )}
            <div className="ps-actions">
              <button className="cf-btn" onClick={() => setStep("pick")}>
                {t("faces.split.addExamples")}
              </button>
              {plan && plan.counts.unsure > 0 && (
                <button className="cf-btn" onClick={() => setStep("review")}>
                  {t("faces.split.reviewUnsure", { count: plan.counts.unsure.toLocaleString() })}
                </button>
              )}
              <button className="cf-btn primary" disabled={!plan || planning || busy} onClick={() => void apply()}>
                {t("faces.split.apply")}
              </button>
            </div>
          </div>
        )}

        {step === "review" && plan && (
          <div className="ps-body">
            <h4 className="ps-h">
              {t("faces.split.reviewTitle")} {working}
            </h4>
            <p className="ps-note">{t("faces.split.reviewHint")}</p>
            <div className="ps-grid">
              {(reviewPage ?? []).map((f) => (
                <div
                  key={f.faceId}
                  className={`ps-cell${picks.get(f.faceId) ? ` ${picks.get(f.faceId)}` : ""}${reviewed.has(f.faceId) ? " skipped" : ""}`}
                >
                  {face(f)}
                  {f.year && <span className="ps-year">{f.year}</span>}
                  {f.lean !== "none" && (
                    <span className="ps-lean">
                      {f.lean === "even" ? t("faces.split.even") : t("faces.split.leans", { name: f.lean === "a" ? here : otherName })}
                    </span>
                  )}
                  {sideButtons(f.faceId)}
                  <button
                    className="ps-skip"
                    aria-pressed={reviewed.has(f.faceId)}
                    onClick={() =>
                      setReviewed((r) => {
                        const next = new Set(r);
                        if (next.has(f.faceId)) next.delete(f.faceId);
                        else next.add(f.faceId);
                        return next;
                      })
                    }
                  >
                    {t(reviewed.has(f.faceId) ? "faces.split.skipped" : "faces.split.skip")}
                  </button>
                </div>
              ))}
            </div>
            {reviewPage !== null && pageAnswered && unsureLeft.length === 0 && !planning && (
              <p className="cf-msg">{t("faces.split.reviewDone")}</p>
            )}
            <div className="ps-actions">
              <button className="cf-btn" onClick={() => setStep("preview")}>
                {t("faces.split.back")}
              </button>
              <button
                className={`cf-btn${pageAnswered && nextReviewPage().length > 0 ? " primary" : ""}`}
                disabled={planning || nextReviewPage().length === 0}
                onClick={() => setReviewPage(nextReviewPage())}
              >
                {t("faces.split.nextFaces")}
              </button>
              <button className="cf-btn primary" disabled={planning || busy} onClick={() => void apply()}>
                {t("faces.split.apply")}
              </button>
            </div>
          </div>
        )}

        {step === "done" && applied && (
          <div className="ps-body">
            <p className="cf-msg">
              {t("faces.split.done", {
                name: here,
                other: otherName,
                stayed: applied.stayed.toLocaleString(),
                moved: applied.moved.toLocaleString(),
                unsure: applied.unsure.toLocaleString(),
              })}
            </p>
            <p className="ps-note">{t("faces.split.phoneNote", { name: here })}</p>
            <div className="ps-actions">
              <button className="cf-btn" disabled={busy} onClick={() => void undo()}>
                {t("faces.split.undo")}
              </button>
              <button className="cf-btn primary" onClick={onClose}>
                {t("faces.split.close")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
