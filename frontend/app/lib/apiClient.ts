"use client";

import { API_BASE_URL, hasSupabase, supabaseBrowser } from "./supabaseClient";

/**
 * Thin wrapper around fetch() for every call to the backend API (as opposed
 * to /health, which is intentionally left unauthenticated -- see
 * useTopbarState.ts). Automatically:
 *   - prefixes API_BASE_URL, so callers just pass the "/api/..." path
 *   - attaches the signed-in user's Supabase access token as a Bearer
 *     token, which the backend's requireAuth middleware validates
 *     (backend/src/middleware/auth.ts)
 *
 * When no Supabase project is configured (hasSupabase is false -- the same
 * zero-config demo mode the login page and middleware.ts already bypass),
 * no Authorization header is sent, matching the backend's own demo-mode
 * bypass so local/demo runs keep working without any login step.
 */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);

  if (hasSupabase && supabaseBrowser) {
    const {
      data: { session },
    } = await supabaseBrowser.auth.getSession();
    if (session?.access_token) {
      headers.set("Authorization", `Bearer ${session.access_token}`);
    }
  }

  return fetch(`${API_BASE_URL}${path}`, { ...init, headers });
}
