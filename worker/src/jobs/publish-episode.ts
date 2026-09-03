// Publishes approved, ready renders to YouTube — the only platform in
// scope for this project (see the plan's "explicitly out of scope"
// section). Adapted from the sibling project's publish-post.ts, with
// three deliberate departures:
//   - Eligibility is `decision = 'approved'` only, not
//     `in ['approved', 'edited']` — this schema's review_decisions has no
//     'edited' state at all (see the schema comment: a script edit
//     changes words already baked into TTS audio, so there's no cheap
//     in-place edit; a rejection routes back to script regeneration
//     instead).
//   - Title/description are friendly and plain, not the sibling's
//     virality style (ALL CAPS, emoji-spam, #shorts #viralshorts).
//   - selfDeclaredMadeForKids is always `true` (see lib/youtube.ts).
//
// Usage:
//   npm run publish-episode                              -> every eligible episode
//   npm run publish-episode -- <render_id>                -> just one, by id
//   npm run publish-episode -- --air-slot nightly_short   -> eligible episodes in one slot
//   npm run publish-episode -- --air-slot tuesday_long_form --limit 1

import { uploadYoutubeVideo } from "../lib/youtube.js";
import { supabase } from "../lib/supabase.js";
import type { TopicCategory } from "../remotion/categories.js";

const MEDIA_BUCKET = "media";
const SIGNED_URL_TTL_SECONDS = 60 * 10;
const CATEGORY_ID = "27"; // Education
const PRIVACY_STATUS =
  (process.env.YOUTUBE_UPLOAD_PRIVACY_STATUS as "private" | "unlisted" | "public" | undefined) ?? "private";

const CURRICULUM_HASHTAGS = ["kidslearning", "preschool", "earlylearning"];
const FALLBACK_TITLE = "Let's Learn Together!";
const CHANNEL_NAME = "Paula the Penguin Learns";
const CHANNEL_HANDLE = "@paulathepenguinlearns";

type Format = "long_form" | "short";
type AirSlot = "tuesday_long_form" | "friday_long_form" | "nightly_short";

interface TopicJoin {
  category: TopicCategory;
  title: string;
  key_vocabulary: string[];
}

interface EpisodeJoin {
  format: Format;
  air_slot: AirSlot;
  topics: TopicJoin | TopicJoin[] | null;
}

interface ScriptJoin {
  title_suggestion: string | null;
  body: string;
}

interface EligibleRender {
  id: string;
  storage_path: string | null;
  episode_id: string;
  episodes: EpisodeJoin | EpisodeJoin[] | null;
  scripts: ScriptJoin | ScriptJoin[] | null;
}

interface ReviewDecisionRow {
  render_id: string;
  decision: "approved" | "rejected";
  edited_title: string | null;
  edited_description: string | null;
  decided_at: string;
}

function episodeOf(render: EligibleRender): EpisodeJoin | null {
  return Array.isArray(render.episodes) ? render.episodes[0] ?? null : render.episodes;
}

function scriptOf(render: EligibleRender): ScriptJoin | null {
  return Array.isArray(render.scripts) ? render.scripts[0] ?? null : render.scripts;
}

function topicOf(episode: EpisodeJoin): TopicJoin | null {
  return Array.isArray(episode.topics) ? episode.topics[0] ?? null : episode.topics;
}

// Sentence-case, plain titles — the sibling's ALL-CAPS-plus-emoji hook
// style is written for adult scroll-stopping on a sports/collectibles
// feed, which is exactly the wrong tone for a kids' educational channel.
function buildTitle(scriptTitle: string | null, editedTitle: string | null | undefined): string {
  const title = (editedTitle?.trim() || scriptTitle?.trim() || FALLBACK_TITLE).trim();
  return title.length > 100 ? `${title.slice(0, 97)}...` : title;
}

// A full description template modeled on how established creator channels
// structure theirs (hook, what-you'll-learn line, subscribe CTA, posting
// schedule, hashtags, channel blurb) — but keeping the hook itself an
// honest one-line summary rather than a clickbait line, and the CTAs
// warm/plain rather than the sibling project's ALL-CAPS/emoji-spam style.
// #Shorts is appended only for the Shorts format, per YouTube's own
// Shorts-eligibility convention.
function buildDescription(
  scriptBody: string | null,
  editedDescription: string | null | undefined,
  topic: TopicJoin,
  format: Format
): string {
  const hook = editedDescription?.trim() || plainSummary(scriptBody);
  const vocab = topic.key_vocabulary.slice(0, 5).join(", ");
  const learnLine = vocab
    ? `📚 Today's lesson: ${topic.title}. New words: ${vocab}`
    : `📚 Today's lesson: ${topic.title}`;
  const scheduleLine =
    "🐧 New adventures with Paula every Tuesday & Friday, plus a fun new Short every night!";
  const subscribeLine = `🔔 Subscribe for more: youtube.com/${CHANNEL_HANDLE}`;
  const categoryHashtag = topic.category.replace(/_/g, "");
  const hashtags = [...CURRICULUM_HASHTAGS, categoryHashtag].map((h) => `#${h}`);
  if (format === "short") hashtags.push("#Shorts");
  const aboutBlurb = `${CHANNEL_NAME} is a channel made just for kids, with gentle songs, simple words, and lots of encouragement to count along, wave back, and join in the fun!`;

  return [hook, learnLine, [scheduleLine, subscribeLine].join("\n"), hashtags.join(" "), aboutBlurb].join(
    "\n\n"
  );
}

function plainSummary(scriptBody: string | null): string {
  if (!scriptBody) return "Join us for a fun lesson made just for kids!";
  const clean = scriptBody
    .replace(/\[PAUSE FOR RESPONSE\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const firstTwoSentences = clean.split(/(?<=[.!?])\s+/).slice(0, 2).join(" ");
  return firstTwoSentences || clean;
}

export interface PublishOptions {
  onlyRenderId?: string;
  airSlot?: AirSlot;
  limit?: number;
}

export async function publishApprovedEpisodes(options: PublishOptions = {}): Promise<void> {
  const { onlyRenderId, airSlot, limit } = options;

  const { data: decisions, error: decisionsError } = await supabase
    .from("review_decisions")
    .select("render_id, decision, edited_title, edited_description, decided_at")
    .returns<ReviewDecisionRow[]>();
  if (decisionsError) throw decisionsError;

  // Keep only each render's most recent decision, in case of more than
  // one row (e.g. a re-review) — and only if that latest decision is
  // 'approved'. This schema has no 'edited' decision (see file header).
  const latestDecisionByRender = new Map<string, ReviewDecisionRow>();
  for (const decision of decisions ?? []) {
    const existing = latestDecisionByRender.get(decision.render_id);
    if (!existing || decision.decided_at > existing.decided_at) {
      latestDecisionByRender.set(decision.render_id, decision);
    }
  }
  const approvedRenderIds = new Set(
    [...latestDecisionByRender.values()].filter((d) => d.decision === "approved").map((d) => d.render_id)
  );

  const { data: platformRow, error: platformError } = await supabase
    .from("platforms")
    .select("id")
    .eq("name", "youtube")
    .single();
  if (platformError) throw platformError;

  // Single-channel project — take whichever platform_account row exists
  // for 'youtube' (set up once, manually, during the OAuth bootstrap
  // step; see jobs/youtube-oauth-bootstrap.ts). Unlike the sibling
  // project there's no per-partner fan-out to route between.
  const { data: account, error: accountError } = await supabase
    .from("platform_accounts")
    .select("id")
    .eq("platform_id", platformRow.id)
    .limit(1)
    .maybeSingle();
  if (accountError) throw accountError;
  if (!account) {
    throw new Error("no platform_accounts row for youtube — insert one (see youtube-oauth-bootstrap.ts) before publishing");
  }

  const { data: existingPosts, error: postsError } = await supabase
    .from("posts")
    .select("render_id")
    .eq("platform_account_id", account.id)
    .eq("status", "published");
  if (postsError) throw postsError;
  const postedRenderIds = new Set((existingPosts ?? []).map((p) => p.render_id as string));

  const { data: renders, error: rendersError } = await supabase
    .from("renders")
    .select(
      "id, storage_path, episode_id, episodes(format, air_slot, topics(category, title, key_vocabulary)), scripts(title_suggestion, body)"
    )
    .eq("render_status", "ready")
    .returns<EligibleRender[]>();
  if (rendersError) throw rendersError;

  let eligible = (renders ?? []).filter(
    (r) => approvedRenderIds.has(r.id) && !postedRenderIds.has(r.id) && r.storage_path
  );

  if (onlyRenderId) {
    eligible = eligible.filter((r) => r.id === onlyRenderId);
    if (eligible.length === 0) {
      throw new Error(`render ${onlyRenderId} isn't eligible — not approved yet, already published, or not render_status='ready'`);
    }
  } else {
    if (airSlot) {
      eligible = eligible.filter((r) => episodeOf(r)?.air_slot === airSlot);
    }
    if (limit != null) {
      eligible = eligible.slice(0, limit);
    }
  }

  console.log(`${eligible.length} episode(s) eligible for YouTube publish (privacyStatus=${PRIVACY_STATUS})`);

  for (const render of eligible) {
    const episode = episodeOf(render);
    const script = scriptOf(render);
    const topic = episode ? topicOf(episode) : null;
    if (!episode || !topic) {
      console.warn(`skip render ${render.id}: missing joined episode/topic`);
      continue;
    }

    const decision = latestDecisionByRender.get(render.id);
    const title = buildTitle(script?.title_suggestion ?? null, decision?.edited_title);
    const description = buildDescription(script?.body ?? null, decision?.edited_description, topic, episode.format);

    const { data: post, error: insertError } = await supabase
      .from("posts")
      .insert({
        render_id: render.id,
        platform_account_id: account.id,
        title,
        description,
        made_for_kids: true,
        status: "publishing",
      })
      .select("id")
      .single();
    if (insertError) throw insertError;

    try {
      const { data: signed, error: signError } = await supabase.storage
        .from(MEDIA_BUCKET)
        .createSignedUrl(render.storage_path!, SIGNED_URL_TTL_SECONDS);
      if (signError) throw signError;

      const videoRes = await fetch(signed.signedUrl);
      if (!videoRes.ok) throw new Error(`failed to fetch rendered episode: ${videoRes.status}`);
      const videoBuffer = Buffer.from(await videoRes.arrayBuffer());

      const categoryHashtag = topic.category.replace(/_/g, "");
      const { videoId, actualPrivacyStatus } = await uploadYoutubeVideo(videoBuffer, {
        title,
        description,
        tags: [...CURRICULUM_HASHTAGS, categoryHashtag],
        categoryId: CATEGORY_ID,
        privacyStatus: PRIVACY_STATUS,
        // Hard requirement for this channel, always true — see the
        // parameter's doc comment in lib/youtube.ts.
        selfDeclaredMadeForKids: true,
      });

      const { error: updateError } = await supabase
        .from("posts")
        .update({ status: "published", external_post_id: videoId, published_at: new Date().toISOString() })
        .eq("id", post.id);
      if (updateError) throw updateError;

      const { error: episodePublishedError } = await supabase
        .from("episodes")
        .update({ status: "published" })
        .eq("id", render.episode_id);
      if (episodePublishedError) throw episodePublishedError;

      console.log(`published ${render.id} -> https://youtube.com/watch?v=${videoId} (actual privacyStatus=${actualPrivacyStatus})`);
      if (actualPrivacyStatus !== PRIVACY_STATUS) {
        console.warn(
          `requested privacyStatus=${PRIVACY_STATUS} but YouTube saved it as ${actualPrivacyStatus} — this is a brand-new, unverified channel/OAuth app (unlike the sibling project's already-confirmed-working one), so don't assume public uploads are honored yet. Verify actualPrivacyStatus manually before trusting the scheduled workflows' public setting.`
        );
      }
    } catch (err) {
      // One bad upload shouldn't take down the rest of the batch.
      console.error(`publish ${render.id} failed:`, err instanceof Error ? err.message : err);
      await supabase
        .from("posts")
        .update({ status: "failed", error_message: err instanceof Error ? err.message : String(err) })
        .eq("id", post.id);
      const { error: episodeFailedError } = await supabase
        .from("episodes")
        .update({ status: "failed" })
        .eq("id", render.episode_id);
      if (episodeFailedError) console.error(episodeFailedError);
    }
  }
}

const AIR_SLOTS: AirSlot[] = ["tuesday_long_form", "friday_long_form", "nightly_short"];

function parseArgs(argv: string[]): PublishOptions {
  const options: PublishOptions = {};
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--air-slot") {
      const value = argv[++i];
      if (!AIR_SLOTS.includes(value as AirSlot)) {
        throw new Error(`--air-slot must be one of ${AIR_SLOTS.join(", ")}, got ${JSON.stringify(value)}`);
      }
      options.airSlot = value as AirSlot;
    } else if (arg === "--limit") {
      const limit = Number(argv[++i]);
      if (!Number.isFinite(limit) || limit <= 0) {
        throw new Error(`--limit requires a positive number`);
      }
      options.limit = limit;
    } else if (!arg.startsWith("--")) {
      options.onlyRenderId = arg;
    }
    i++;
  }
  return options;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  publishApprovedEpisodes(parseArgs(process.argv.slice(2)))
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
