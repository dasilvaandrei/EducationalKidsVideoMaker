"use server";

import { createClient } from "@/lib/supabase/server";

export interface ForgotPasswordState {
  error?: string;
  sent?: boolean;
}

// Where the app is actually reachable from — set to the deployed domain in
// production (Vercel env var), falls back to localhost for local dev.
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export async function requestPasswordReset(
  _prevState: ForgotPasswordState,
  formData: FormData
): Promise<ForgotPasswordState> {
  const email = formData.get("email");

  if (typeof email !== "string" || !email) {
    return { error: "Email is required." };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${SITE_URL}/auth/confirm?next=/reset-password`,
  });

  // Always report success regardless of whether the email exists, so this
  // form can't be used to enumerate reviewer accounts.
  if (error) {
    console.error("resetPasswordForEmail failed:", error.message);
  }
  return { sent: true };
}
