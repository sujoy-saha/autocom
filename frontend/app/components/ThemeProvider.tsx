"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type ThemePreference = "system" | "light" | "dark";

interface ThemeContextValue {
  /** The user's saved preference (what the picker shows as selected). */
  preference: ThemePreference;
  /** The actually-applied theme after resolving "system" against the OS setting. */
  resolvedTheme: "light" | "dark";
  setPreference: (pref: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

// v2: bumped from "ac_theme" so any previously-saved light/system preference
// (from before dark became the default) doesn't stick around stale.
const STORAGE_KEY = "ac_theme_v2";

function resolveTheme(pref: ThemePreference): "light" | "dark" {
  if (pref === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return pref;
}

/** Supabase-style theme system: "System" / "Light" / "Dark", persisted to
 * localStorage and applied via a `data-theme` attribute on <html> (see
 * globals.css's `[data-theme="dark"]` variable overrides). A blocking
 * inline script in layout.tsx applies the saved preference before paint so
 * there's no flash of the wrong theme on load. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>("dark");
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">("dark");

  useEffect(() => {
    const saved = (window.localStorage.getItem(STORAGE_KEY) as ThemePreference | null) ?? "dark";
    setPreferenceState(saved);
    setResolvedTheme(resolveTheme(saved));
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", resolvedTheme);
  }, [resolvedTheme]);

  useEffect(() => {
    if (preference !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => setResolvedTheme(resolveTheme("system"));
    media.addEventListener("change", handler);
    return () => media.removeEventListener("change", handler);
  }, [preference]);

  function setPreference(pref: ThemePreference) {
    window.localStorage.setItem(STORAGE_KEY, pref);
    setPreferenceState(pref);
    setResolvedTheme(resolveTheme(pref));
  }

  const value = useMemo(() => ({ preference, resolvedTheme, setPreference }), [preference, resolvedTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}
