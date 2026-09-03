"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

async function currentUserId(): Promise<string> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("not authenticated");
  return user.id;
}

// Approving only ever inserts a review_decisions row — it never touches the
// script or the render. edited_title/edited_description (if provided) are
// publish-time metadata overrides only; there is no "edit the script" path
// here, because the video already has the current script's words baked into
// the narration audio and burned-in captions (see the plan's
// review_decisions comment).
export async function approveRender(
  renderId: string,
  editedTitle: string | null,
  editedDescription: string | null
) {
  const supabase = await createClient();
  const reviewerId = await currentUserId();

  const { error } = await supabase.from("review_decisions").insert({
    render_id: renderId,
    reviewer_id: reviewerId,
    decision: "approved",
    edited_title: editedTitle || null,
    edited_description: editedDescription || null,
  });
  if (error) throw error;

  revalidatePath("/review");
}

// Rejection notes are required (unlike the sibling's optional notes) because
// a reject here always routes the episode back to write-script.ts for a new
// script version — the notes are the only signal the regeneration prompt
// gets about what was wrong.
export async function rejectRender(renderId: string, notes: string) {
  const trimmed = notes.trim();
  if (!trimmed) {
    throw new Error("Rejection notes are required.");
  }

  const supabase = await createClient();
  const reviewerId = await currentUserId();

  const { error } = await supabase.from("review_decisions").insert({
    render_id: renderId,
    reviewer_id: reviewerId,
    decision: "rejected",
    notes: trimmed,
  });
  if (error) throw error;

  revalidatePath("/review");
}
