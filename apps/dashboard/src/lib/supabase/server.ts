import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// Anon key + the signed-in user's session cookie — this client is subject
// to RLS (authenticated_read policies etc.), unlike the worker's
// service-role client. That's deliberate: the dashboard is the untrusted,
// browser-facing side of the schema's security boundary.
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Called from a Server Component without a mutable cookie jar
            // (no active response to attach Set-Cookie to) — proxy.ts
            // refreshes the session on every request, so this is safe to
            // ignore rather than throw.
          }
        },
      },
    }
  );
}
