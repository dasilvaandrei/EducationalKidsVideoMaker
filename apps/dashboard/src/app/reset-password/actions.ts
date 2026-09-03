"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export interface ResetPasswordState {
  error?: string;
}

export async function updatePassword(
  _prevState: ResetPasswordState,
  formData: FormData
): Promise<ResetPasswordState> {
  const password = formData.get("password");
  const confirmPassword = formData.get("confirmPassword");

  if (typeof password !== "string" || password.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }
  if (password !== confirmPassword) {
    return { error: "Passwords don't match." };
  }

  const supabase = await createClient();

  // Only reachable with a valid session — /auth/confirm establishes one
  // from the emailed recovery token before ever redirecting here.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login?error=Your reset link expired, please request a new one");
  }

  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    return { error: error.message };
  }

  redirect("/review");
}
