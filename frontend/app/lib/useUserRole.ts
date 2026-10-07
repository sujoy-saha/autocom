"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "./apiClient";
import { hasSupabase } from "./supabaseClient";

export type UserRole = "buyer" | "seller" | "supplier";

/**
 * Fetches the signed-in user's persona role from the backend's /api/me
 * (see backend/src/routes/me.ts), so pages/components can branch on it
 * (NavBar links, dashboard read-only mode for buyers, page-level redirects
 * for pages restricted to a single role). Defaults to "seller" while
 * loading and in demo mode (no Supabase project configured) — matches the
 * backend's own zero-config fallback, so a bare local run keeps full
 * access unchanged from before personas existed.
 */
export function useUserRole(): { role: UserRole; loading: boolean } {
  const [role, setRole] = useState<UserRole>("seller");
  const [loading, setLoading] = useState<boolean>(hasSupabase);

  useEffect(() => {
    if (!hasSupabase) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    apiFetch("/api/me")
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled && (data.role === "buyer" || data.role === "seller" || data.role === "supplier")) {
          setRole(data.role);
        }
      })
      .catch(() => {
        // Fall back to the "seller" default set above.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return { role, loading };
}
