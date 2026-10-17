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

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";

import { en } from "./locales/en";
import { hu } from "./locales/hu";
import { de } from "./locales/de";
import { es } from "./locales/es";
import { fr } from "./locales/fr";
import { it } from "./locales/it";
import { nl } from "./locales/nl";
import { pl } from "./locales/pl";
import { cs } from "./locales/cs";
import { sk } from "./locales/sk";
import { sl } from "./locales/sl";

/**
 * Runtime internationalization. Strings are keyed by short stable ids and looked
 * up in the active dictionary, falling back to English, then to the key itself.
 * Each language lives in its own file under `locales/`; English is the source of
 * truth for the key set. The chosen language rides inside the same persisted
 * `settings` object as the theme, so it restores with everything else.
 */
export type Lang = "en" | "hu" | "de" | "es" | "fr" | "it" | "nl" | "pl" | "cs" | "sk" | "sl";

const DICTS: Record<Lang, Record<string, string>> = { en, hu, de, es, fr, it, nl, pl, cs, sk, sl };

/**
 * The languages offered in Settings, each labelled in its own tongue (so they are
 * not run through `t`). English leads because it is also the fallback; the rest
 * follow alphabetically by native name. Mirrors the locales the Android app ships.
 */
export const LANGS: { value: Lang; label: string }[] = [
  { value: "en", label: "English" },
  { value: "cs", label: "Čeština" },
  { value: "de", label: "Deutsch" },
  { value: "es", label: "Español" },
  { value: "fr", label: "Français" },
  { value: "it", label: "Italiano" },
  { value: "hu", label: "Magyar" },
  { value: "nl", label: "Nederlands" },
  { value: "pl", label: "Polski" },
  { value: "sk", label: "Slovenčina" },
  { value: "sl", label: "Slovenščina" },
];

/** The default before any choice is saved: the OS language if it is one we speak. */
export const BROWSER_LANG: Lang = (() => {
  const base = navigator.language.slice(0, 2).toLowerCase();
  return (LANGS.some((l) => l.value === base) ? base : "en") as Lang;
})();

export type TFunc = (key: string, vars?: Record<string, string | number>) => string;

type LangCtx = { lang: Lang; setLang: (l: Lang) => void };

const LangContext = createContext<LangCtx>({ lang: "en", setLang: () => {} });

/** Merge a single field into the persisted `settings` object without dropping the rest. */
async function persistLang(l: Lang): Promise<void> {
  try {
    const raw = await invoke<string | null>("store_get", { name: "settings" });
    const obj = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    obj.lang = l;
    await invoke("store_set", { name: "settings", value: JSON.stringify(obj) });
  } catch {
    /* persistence is best-effort */
  }
}

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(BROWSER_LANG);

  // Restore the saved choice, if any. Until it lands, the browser default shows.
  useEffect(() => {
    (async () => {
      try {
        const raw = await invoke<string | null>("store_get", { name: "settings" });
        if (!raw) return;
        const stored = JSON.parse(raw).lang;
        if (LANGS.some((l) => l.value === stored)) setLangState(stored as Lang);
      } catch {
        /* keep the browser default */
      }
    })();
  }, []);

  // Cross-window sync: a change made in one window (e.g. Settings in the main
  // window) is broadcast so every other window switches too — notably the always-
  // open tray popup, which otherwise keeps the language it read once at startup.
  useEffect(() => {
    const un = listen<Lang>("lang-changed", (e) => {
      if (e.payload) setLangState(e.payload);
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    void persistLang(l);
    void emit("lang-changed", l); // tell the other windows (tray popup, main)
  }, []);

  const value = useMemo<LangCtx>(() => ({ lang, setLang }), [lang, setLang]);
  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

export function useLang(): LangCtx {
  return useContext(LangContext);
}

/** Returns `t(key, vars?)`: active dictionary, then English, then the key itself. */
export function useT(): TFunc {
  const { lang } = useContext(LangContext);
  return useCallback<TFunc>(
    (key, vars) => {
      let s = DICTS[lang][key] ?? en[key] ?? key;
      if (vars) {
        for (const k in vars) s = s.split(`{${k}}`).join(String(vars[k]));
      }
      return s;
    },
    [lang],
  );
}
