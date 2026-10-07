import type { NextFunction, Request, Response } from "express";
import { createClient } from "@supabase/supabase-js";
import { config } from "../config.js";
import { db } from "../store/index.js";
import type { UserRole } from "../store/types.js";

// Separate client from store/supabaseStore.ts's -- used only to validate
// end-user access tokens (auth.getUser), never for table reads/writes. Only
// constructed when a real Supabase project is configured; see requireAuth.
const authClient = config.isDemoStore
  ? null
  : createClient(config.supabaseUrl, config.supabaseServiceRoleKey, { auth: { persistSession: false } });

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: { id: string; email: string | null };
    }
  }
}

/**
 * Enterprise hardening: every /api/* route (except /health) requires the
 * caller to present a valid Supabase-issued access token -- the exact same
 * login session the dashboard/inventory pages already gate behind Supabase
 * Auth (see frontend/middleware.ts). Verified against Supabase's auth
 * server (not just decoded locally), so a revoked or expired session is
 * rejected immediately rather than trusted until it expires.
 *
 * When no Supabase project is configured at all (config.isDemoStore, e.g. a
 * zero-config local run against the in-memory store) auth is skipped
 * entirely -- there's no real user/session system to check a token against,
 * matching the frontend's own demo-mode bypass in middleware.ts.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!authClient) {
    return next();
  }

  const header = req.header("authorization") ?? "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) {
    res.status(401).json({ error: "Missing or malformed Authorization header (expected 'Bearer <token>')" });
    return;
  }

  const { data, error } = await authClient.auth.getUser(token);
  if (error || !data?.user) {
    res.status(401).json({ error: "Invalid or expired session" });
    return;
  }

  req.user = { id: data.user.id, email: data.user.email ?? null };
  next();
}

/**
 * Persona-based authorization: requires the authenticated user's `profiles`
 * row (see supabase/migrations/0005_personas.sql) to have one of `roles`.
 * Must run after requireAuth (needs req.user). In demo-store mode
 * (config.isDemoStore — no real Supabase project) this is a no-op, same
 * convention as requireAuth, so the zero-config demo experience is
 * unaffected. A user with no `profiles` row yet defaults to "seller" (the
 * table's own default), matching pre-persona behavior for existing users.
 */
export function requireRole(...roles: UserRole[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (config.isDemoStore) {
      return next();
    }
    if (!req.user) {
      res.status(401).json({ error: "Missing or invalid session" });
      return;
    }

    const profile = await db.getProfile(req.user.id);
    const role: UserRole = profile?.role ?? "seller";

    if (!roles.includes(role)) {
      res.status(403).json({ error: `This action requires one of the following roles: ${roles.join(", ")}` });
      return;
    }

    next();
  };
}
