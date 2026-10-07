"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { hasSupabase, supabaseBrowser } from "../lib/supabaseClient";
import { apiFetch } from "../lib/apiClient";
import { BrandMark } from "../components/BrandMark";

type Mode = "sign-in" | "sign-up";

/** Post-login destination based on persona role (see backend/src/routes/me.ts) —
 * Suppliers land on their own backfill-orders screen; everyone else lands on
 * the existing Orders dashboard. Falls back to /dashboard on any error so a
 * role lookup hiccup never blocks login itself. */
async function destinationForCurrentUser(): Promise<string> {
  try {
    const res = await apiFetch("/api/me");
    const data = await res.json();
    return data.role === "supplier" ? "/supplier" : "/dashboard";
  } catch {
    return "/dashboard";
  }
}

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!supabaseBrowser) return;
    setSubmitting(true);
    setError(null);
    setInfo(null);

    try {
      if (mode === "sign-in") {
        const { error: signInError } = await supabaseBrowser.auth.signInWithPassword({ email, password });
        if (signInError) throw signInError;
        router.push(await destinationForCurrentUser());
        router.refresh();
      } else {
        const { data, error: signUpError } = await supabaseBrowser.auth.signUp({ email, password });
        if (signUpError) throw signUpError;
        if (data.session) {
          router.push(await destinationForCurrentUser());
          router.refresh();
        } else {
          setInfo("Account created — check your email to confirm, then sign in.");
          setMode("sign-in");
        }
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  if (!hasSupabase) {
    return (
      <main className="auth-page">
        <div className="auth-card">
          <div className="auth-brand">
            <div className="brand-mark">
              <BrandMark />
            </div>
            <div className="brand-text">
              <h1>AutoCom</h1>
              <span>Orders on autopilot</span>
            </div>
          </div>
          <div className="auth-body">
            <p className="empty-state">
              No Supabase project is configured (demo mode) — login is disabled. Visit the dashboard directly.
            </p>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="auth-page">
      <form className="auth-card" onSubmit={handleSubmit}>
        <div className="auth-brand">
          <div className="brand-mark">
            <BrandMark />
          </div>
          <div className="brand-text">
            <h1>AutoCom</h1>
            <span>Orders on autopilot</span>
          </div>
        </div>

        <div className="auth-body">
          <div className="auth-tabs">
            <button type="button" data-active={mode === "sign-in"} onClick={() => setMode("sign-in")}>
              Sign in
            </button>
            <button type="button" data-active={mode === "sign-up"} onClick={() => setMode("sign-up")}>
              Create account
            </button>
          </div>

          <label>
            Work email
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
          </label>
          <label>
            Password
            <input
              type="password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
          </label>

          {error && <p className="auth-error">{error}</p>}
          {info && <p className="auth-info">{info}</p>}

          <button type="submit" disabled={submitting}>
            {submitting ? "Please wait…" : mode === "sign-in" ? "Sign in" : "Create account"}
          </button>
        </div>
      </form>
    </main>
  );
}
