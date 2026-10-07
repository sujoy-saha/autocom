import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

// Gates /dashboard behind Supabase Auth. Reads the session from cookies
// (set by the cookie-backed browser client in app/lib/supabaseClient.ts)
// so the redirect happens before the protected page ever renders, unlike a
// client-side-only check.
export async function middleware(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Demo mode (no Supabase project configured): skip auth entirely rather
  // than lock the app out — matches the frontend's existing hasSupabase
  // fallback behavior.
  if (!url || !anonKey) {
    return NextResponse.next();
  }

  let response = NextResponse.next({ request: { headers: request.headers } });

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request: { headers: request.headers } });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user && (request.nextUrl.pathname.startsWith("/dashboard") || request.nextUrl.pathname.startsWith("/inventory") || request.nextUrl.pathname.startsWith("/supplier") || request.nextUrl.pathname.startsWith("/invoices") || request.nextUrl.pathname.startsWith("/replenishment"))) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/login";
    return NextResponse.redirect(redirectUrl);
  }

  if (user && request.nextUrl.pathname === "/login") {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/dashboard";
    return NextResponse.redirect(redirectUrl);
  }

  return response;
}

export const config = {
  matcher: ["/dashboard/:path*", "/inventory/:path*", "/supplier/:path*", "/invoices/:path*", "/replenishment/:path*", "/login"],
};
