"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// Realtime dashboard updates (and now login) only work when a real Supabase
// project is configured. Without it (e.g. running the backend in DEMO_MODE
// with no .env at all), the frontend falls back to polling and skips auth
// entirely — see hasSupabase below and middleware.ts.
export const hasSupabase = Boolean(url && anonKey);

// Uses the cookie-backed browser client (not plain createClient) so the
// session is readable by middleware.ts on the server for route protection.
export const supabaseBrowser: SupabaseClient | null = hasSupabase
  ? createBrowserClient(url!, anonKey!)
  : null;

export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";
