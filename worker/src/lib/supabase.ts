import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set for worker jobs");
}

// Workers always use the service role key and bypass RLS by design —
// RLS in the schema governs the dashboard's browser client, not this.
export const supabase = createClient(url, serviceRoleKey, {
  auth: { persistSession: false },
});
