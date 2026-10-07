"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { hasSupabase } from "../lib/supabaseClient";
import type { UserRole } from "../lib/useUserRole";
import { ProfileMenu } from "./ProfileMenu";
import { BrandMark } from "./BrandMark";

/** Persona-scoped nav links (see backend/src/routes/me.ts's role source of
 * truth): Buyers can view orders but never Inventory; Suppliers only see
 * their own backfill/invoice screens, never the Buyer/Seller order screens;
 * Sellers keep every link, including the Invoices review queue. */
function navLinksForRole(role: UserRole): { href: string; label: string }[] {
  switch (role) {
    case "buyer":
      return [{ href: "/dashboard", label: "Orders" }];
    case "supplier":
      return [{ href: "/supplier", label: "Backfill Orders" }];
    case "seller":
    default:
      return [
        { href: "/dashboard", label: "Orders" },
        { href: "/inventory", label: "Inventory" },
        { href: "/replenishment", label: "Replenishment" },
        { href: "/invoices", label: "Invoices" },
      ];
  }
}

/** Shared topbar (brand mark + page nav + env pill + profile menu) used by
 * every authenticated page, so navigating between Orders and Inventory
 * doesn't require going back through the dashboard. */
export function NavBar({
  demoMode,
  userEmail,
  onSignOut,
  role = "seller",
}: {
  demoMode: boolean | null;
  userEmail: string | null;
  onSignOut: () => void;
  role?: UserRole;
}) {
  const pathname = usePathname();
  const navLinks = navLinksForRole(role);

  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark">
          <BrandMark />
        </div>
        <div className="brand-text">
          <h1>AutoCom</h1>
          <span>Orders on autopilot</span>
        </div>
      </div>

      <nav className="topbar-nav">
        {navLinks.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="topbar-nav-link"
            data-active={pathname?.startsWith(link.href) ?? false}
          >
            {link.label}
          </Link>
        ))}
      </nav>

      <div className="topbar-meta">
        <span className="env-pill">{demoMode ? "Demo mode" : "Live"}</span>
        {hasSupabase && userEmail && <ProfileMenu email={userEmail} onSignOut={onSignOut} />}
      </div>
    </header>
  );
}
