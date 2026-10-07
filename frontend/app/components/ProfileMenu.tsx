"use client";

import { useEffect, useRef, useState } from "react";
import { useTheme, type ThemePreference } from "./ThemeProvider";

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** Supabase-style profile avatar + dropdown: click the avatar to reveal the
 * signed-in user's identity and account actions (currently just sign out;
 * "Account"/"Preferences" are placeholders for when those pages exist). */
export function ProfileMenu({ email, onSignOut }: { email: string; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const { preference, setPreference } = useTheme();

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const initial = email.trim().charAt(0).toUpperCase() || "?";
  const name = email.split("@")[0];

  return (
    <div className="profile-menu" ref={rootRef}>
      <button type="button" className="profile-avatar" onClick={() => setOpen((v) => !v)} aria-label="Account menu">
        {initial}
      </button>

      {open && (
        <div className="profile-dropdown">
          <div className="profile-header">
            <div className="profile-name">{name}</div>
            <div className="profile-email">{email}</div>
          </div>

          <div className="profile-divider" />

          <button type="button" className="profile-item" disabled>
            Account
          </button>
          <button type="button" className="profile-item" disabled>
            Preferences
          </button>

          <div className="profile-divider" />

          <div className="profile-section-label">Theme</div>
          <div className="theme-options">
            {THEME_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className="theme-option"
                data-active={preference === opt.value}
                onClick={() => setPreference(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <div className="profile-divider" />

          <button
            type="button"
            className="profile-item profile-item-danger"
            onClick={() => {
              setOpen(false);
              onSignOut();
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
