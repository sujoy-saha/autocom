import { Router } from "express";
import { db } from "../store/index.js";
import { config } from "../config.js";
import type { UserRole } from "../store/types.js";

export const meRouter = Router();

// Reports the current user's persona role so the frontend can branch
// (NavBar links, dashboard read-only mode, page-level redirects — see
// frontend/app/lib/useUserRole.ts). In demo-store mode (no real Supabase
// project) there's no req.user/profiles table at all, so this reports a
// fixed "seller" role -- the existing zero-config demo keeps full access,
// unchanged from before personas existed.
meRouter.get("/", async (req, res) => {
  if (config.isDemoStore || !req.user) {
    res.json({ id: null, email: null, role: "seller" satisfies UserRole });
    return;
  }

  try {
    const profile = await db.getProfile(req.user.id);
    const role: UserRole = profile?.role ?? "seller";
    res.json({ id: req.user.id, email: req.user.email, role });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
