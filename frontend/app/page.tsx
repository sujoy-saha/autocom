import { redirect } from "next/navigation";

// The dashboard itself lives at /dashboard (protected by middleware.ts,
// which gates it behind Supabase Auth and bounces unauthenticated visitors
// to /login). This root route just picks a default landing spot.
export default function Home() {
  redirect("/dashboard");
}
