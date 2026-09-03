import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { logout } from "./actions";

// proxy.ts already redirects signed-out requests before they get here, but
// per Next's auth guidance a layout isn't re-run on client-side navigation
// between its own children — so a page fetching data itself still needs to
// check. Keeping a cheap check here too costs nothing and means this layout
// never renders authenticated-looking chrome for a signed-out request.
export default async function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <header className="flex items-center justify-between border-b border-neutral-800 px-6 py-4">
        <span className="text-sm font-semibold">KidsVideoMaker episode review</span>
        <form action={logout}>
          <button type="submit" className="text-sm text-neutral-400 hover:text-white">
            Sign out ({user.email})
          </button>
        </form>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
    </div>
  );
}
