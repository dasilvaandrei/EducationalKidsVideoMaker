// One-off manual script: publishes the most recently rendered episode as a
// real, LIVE Instagram Reel to the authorized account — unlike TikTok's
// inbox/draft path, Instagram's container flow (see lib/instagram.ts /
// lib/meta.ts) has no draft step, so this goes straight to the account's
// real feed the moment it succeeds. Not part of the daily pipeline; run
// deliberately, not casually.
//
// Requires META_ACCESS_TOKEN and META_INSTAGRAM_USER_ID in .env, set from
// meta-oauth-bootstrap.ts's output (or, as used this session, a verified
// dashboard-issued token — see lib/meta.ts's header comment on why the
// OAuth flow is normally preferred).

import { uploadInstagramReel } from "../lib/instagram.js";
import { supabase } from "../lib/supabase.js";

const MEDIA_BUCKET = "media";
const SIGNED_URL_TTL_SECONDS = 60 * 30; // Instagram's server-side processing is async, give it room

interface TopicJoin {
  title: string;
  key_vocabulary: string[];
}
interface EpisodeJoin {
  topics: TopicJoin | TopicJoin[] | null;
}
interface ScriptJoin {
  title_suggestion: string | null;
}
interface ReadyRender {
  id: string;
  storage_path: string | null;
  episodes: EpisodeJoin | EpisodeJoin[] | null;
  scripts: ScriptJoin | ScriptJoin[] | null;
  created_at: string;
}

function first<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? value[0] ?? null : value;
}

async function main() {
  const { data: render, error: renderError } = await supabase
    .from("renders")
    .select("id, storage_path, episodes(topics(title, key_vocabulary)), scripts(title_suggestion), created_at")
    .eq("render_status", "ready")
    .not("storage_path", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .single<ReadyRender>();
  if (renderError) throw renderError;

  const episode = first(render.episodes);
  const topic = episode ? first(episode.topics) : null;
  const script = first(render.scripts);

  const title = script?.title_suggestion?.trim() || "Let's Learn Together!";
  const vocab = topic?.key_vocabulary?.slice(0, 5).join(", ");
  const learnLine = topic ? `Today's lesson: ${topic.title}${vocab ? `. New words: ${vocab}` : ""}` : "";
  const hashtags = "#kidslearning #preschool #earlylearning";
  const caption = [title, learnLine, hashtags].filter(Boolean).join("\n\n");

  console.log(`publishing render ${render.id} to Instagram as a LIVE Reel...`);
  console.log(`caption:\n${caption}\n`);

  const { data: signed, error: signError } = await supabase.storage
    .from(MEDIA_BUCKET)
    .createSignedUrl(render.storage_path!, SIGNED_URL_TTL_SECONDS);
  if (signError) throw signError;

  const { mediaId } = await uploadInstagramReel({ videoUrl: signed.signedUrl, caption });
  console.log(`published render ${render.id} -> https://www.instagram.com/reel/${mediaId}/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
