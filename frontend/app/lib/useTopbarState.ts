"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { API_BASE_URL, hasSupabase, supabaseBrowser } from "./supabaseClient";
import { useUserRole } from "./useUserRole";

/**
 * Shared topbar state (demo-mode banner flag, signed-in user's email, sign
 * out action, persona role) — used by every authenticated page (dashboard,
 * inventory, supplier, invoices, ...) so the <NavBar> and page-level access
 * checks look/behave identically everywhere instead of each page
 * re-implementing this bookkeeping.
 */
export function useTopbarState() {
  const router = useRouter();
  const [demoMode, setDemoMode] = useState<boolean | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const { role, loading: roleLoading } = useUserRole();

  useEffect(() => {
    fetch(`${API_BASE_URL}/health`)
      .then((r) => r.json())
      .then((data) => setDemoMode(Boolean(data.demoMode)))
      .catch(() => setDemoMode(null));
  }, []);

  // Who's signed in (shown in the topbar) — middleware.ts already enforces
  // that only authenticated requests reach protected routes when Supabase
  // Auth is configured, so this is just for display, not the actual gate.
  useEffect(() => {
    if (!hasSupabase || !supabaseBrowser) return;
    supabaseBrowser.auth.getUser().then(({ data }) => setUserEmail(data.user?.email ?? null));
  }, []);

  async function signOut() {
    if (!supabaseBrowser) return;
    await supabaseBrowser.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return { demoMode, userEmail, signOut, role, roleLoading };
}
