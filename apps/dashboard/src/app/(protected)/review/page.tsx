import { createClient } from "@/lib/supabase/server";
import { ReviewCard } from "./ReviewCard";

const MEDIA_BUCKET = "media";
const SIGNED_URL_TTL_SECONDS = 60 * 60;

// Mirrors the pending_reviews view exactly (see
// supabase/migrations/20260901010000_review_dashboard.sql) — a render only
// shows up here once its script's latest safety check passed and it has no
// review_decisions row yet.
interface PendingReview {
  render_id: string;
  episode_id: string;
  aspect_ratio: "16:9" | "9:16";
  storage_path: string | null;
  duration_seconds: number | null;
  script_id: string;
  script_body: string;
  title_suggestion: string | null;
  category: string;
  topic_title: string;
  safety_reasoning: string;
  safety_categories_flagged: string[];
  format: "long_form" | "short";
  air_slot: "tuesday_long_form" | "friday_long_form" | "nightly_short";
  created_at: string;
}

export default async function ReviewPage() {
  const supabase = await createClient();

  const { data: pending, error } = await supabase
    .from("pending_reviews")
    .select(
      "render_id, episode_id, aspect_ratio, storage_path, duration_seconds, script_id, script_body, title_suggestion, category, topic_title, safety_reasoning, safety_categories_flagged, format, air_slot, created_at"
    )
    .order("created_at", { ascending: true })
    .returns<PendingReview[]>();

  if (error) {
    return <p className="text-red-400">Failed to load pending reviews: {error.message}</p>;
  }

  const rows = pending ?? [];

  const withUrls = await Promise.all(
    rows.map(async (row) => {
      if (!row.storage_path) return { ...row, videoUrl: null };
      const { data } = await supabase.storage
        .from(MEDIA_BUCKET)
        .createSignedUrl(row.storage_path, SIGNED_URL_TTL_SECONDS);
      return { ...row, videoUrl: data?.signedUrl ?? null };
    })
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Review queue</h1>
        <p className="text-sm text-neutral-400">
          {rows.length} episode{rows.length === 1 ? "" : "s"} awaiting a decision
        </p>
      </div>

      {rows.length === 0 && (
        <p className="text-neutral-500">Nothing to review right now.</p>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {withUrls.map((row) => (
          <ReviewCard key={row.render_id} render={row} />
        ))}
      </div>
    </div>
  );
}
