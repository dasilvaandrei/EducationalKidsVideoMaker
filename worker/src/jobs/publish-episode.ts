// Publishes approved, ready renders to YouTube, and — for Shorts only —
// also to TikTok and Instagram Reels, whenever a platform_accounts row
// exists for that platform (none exist for tiktok/instagram until the
// real accounts + tokens are set up; see meta-oauth-bootstrap.ts /
// tiktok-oauth-bootstrap.ts). Long-form episodes stay YouTube-only — a
// ~5min 16:9 episode isn't what either platform's short-form discovery is
// built around. Adapted from the sibling project's publish-post.ts, with
// several deliberate departures:
//   - Eligibility is `decision = 'approved'` only, not
//     `in ['approved', 'edited']` — this schema's review_decisions has no
//     'edited' state at all (see the schema comment: a script edit
//     changes words already baked into TTS audio, so there's no cheap
//     in-place edit; a rejection routes back to script regeneration
//     instead).
//   - Title/description are friendly and plain, not the sibling's
//     virality style (ALL CAPS, emoji-spam, #shorts #viralshorts).
//     TikTok/Instagram get a separate, shorter social caption rather than
//     the full YouTube description template.
//   - selfDeclaredMadeForKids is always `true` (see lib/youtube.ts).
//   - A render can be "partially eligible" — already posted to YouTube but
//     not yet to TikTok/Instagram (e.g. those accounts didn't exist yet at
//     first publish) — so eligibility and posting are tracked per
//     render+platform, not per render.
//
// Usage:
//   npm run publish-episode                              -> every eligible episode
//   npm run publish-episode -- <render_id>                -> just one, by id
//   npm run publish-episode -- --air-slot nightly_short   -> eligible episodes in one slot
//   npm run publish-episode -- --air-slot tuesday_long_form --limit 1

import { uploadYoutubeVideo } from "../lib/youtube.js";
import { uploadTiktokVideo, type TiktokPrivacyLevel } from "../lib/tiktok.js";
import { uploadInstagramReel } from "../lib/instagram.js";
import { supabase } from "../lib/supabase.js";
import type { TopicCategory } from "../remotion/categories.js";

const MEDIA_BUCKET = "media";
const SIGNED_URL_TTL_SECONDS = 60 * 10;
// Instagram's container-based publish is async (Meta fetches and
// transcodes the video server-side, which can take minutes) — the signed
// URL needs to still be valid when that finishes, not just at request
// time. Always sign fresh right before use; reusing an earlier-signed URL
// across a batch is exactly the bug that broke render-episode.ts's batch
// renders this session.
const INSTAGRAM_SIGNED_URL_TTL_SECONDS = 60 * 30;
const CATEGORY_ID = "27"; // Education
// `|| undefined` first, not just `??`, because an env var can be an empty
// string rather than truly unset — a blank .env line, or a GitHub Actions
// secret that exists but was never given a value, both surface as "" here,
// and "" ?? "private" evaluates to "" (nullish coalescing doesn't catch
// empty string), which YouTube's API then rejects outright. Confirmed live
// against both cases.
const PRIVACY_STATUS =
  ((process.env.YOUTUBE_UPLOAD_PRIVACY_STATUS || undefined) as "private" | "unlisted" | "public" | undefined) ??
  "private";
// Defaults to the safe, always-available option: unaudited TikTok apps are
// forced to SELF_ONLY regardless of what's requested anyway (see
// lib/tiktok.ts), so there's no real footgun in defaulting here the way
// there was for YouTube — but keep the same explicit-env-var shape for
// consistency and so flipping to PUBLIC_TO_EVERYONE post-audit is a config
// change, not a code change.
const TIKTOK_PRIVACY_LEVEL =
  ((process.env.TIKTOK_UPLOAD_PRIVACY_LEVEL || undefined) as TiktokPrivacyLevel | undefined) ?? "SELF_ONLY";

const CURRICULUM_HASHTAGS = ["kidslearning", "preschool", "earlylearning"];
const FALLBACK_TITLE = "Let's Learn Together!";
const CHANNEL_NAME = "Paula the Penguin Learns";
const CHANNEL_HANDLE = "@paulathepenguinlearns";
const SOCIAL_PLATFORM_NAMES = ["youtube", "tiktok", "instagram"] as const;
type SocialPlatformName = (typeof SOCIAL_PLATFORM_NAMES)[number];

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

interface PlatformAccountRow {
  id: string;
  platformName: SocialPlatformName;
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
// Shorts-eligibility convention. YouTube-only — see buildSocialCaption for
// TikTok/Instagram's much shorter equivalent.
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

// TikTok/Instagram captions read much shorter and more hashtag-forward
// than a YouTube description — just the honest one-line hook plus
// curriculum hashtags, no schedule/subscribe CTA block.
function buildSocialCaption(
  scriptBody: string | null,
  editedDescription: string | null | undefined,
  topic: TopicJoin
): string {
  const hook = editedDescription?.trim() || plainSummary(scriptBody);
  const categoryHashtag = topic.category.replace(/_/g, "");
  const hashtags = [...CURRICULUM_HASHTAGS, categoryHashtag].map((h) => `#${h}`).join(" ");
  return `${hook}\n\n${hashtags}`;
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

async function signRenderUrl(storagePath: string, ttlSeconds: number): Promise<string> {
  const { data, error } = await supabase.storage.from(MEDIA_BUCKET).createSignedUrl(storagePath, ttlSeconds);
  if (error) throw error;
  return data.signedUrl;
}

async function fetchRenderBuffer(storagePath: string): Promise<Buffer> {
  const url = await signRenderUrl(storagePath, SIGNED_URL_TTL_SECONDS);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to fetch rendered episode: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function markPublished(postId: string, externalPostId: string): Promise<void> {
  const { error } = await supabase
    .from("posts")
    .update({ status: "published", external_post_id: externalPostId, published_at: new Date().toISOString() })
    .eq("id", postId);
  if (error) throw error;
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

  // Whichever of youtube/tiktok/instagram actually have a platform_account
  // row today — for a while that'll be youtube only, and tiktok/instagram
  // publishing turns on automatically the moment those rows are inserted
  // (see meta-oauth-bootstrap.ts / tiktok-oauth-bootstrap.ts), no code
  // change needed.
  const { data: accountsRaw, error: accountsError } = await supabase
    .from("platform_accounts")
    .select("id, platforms(name)")
    .returns<{ id: string; platforms: { name: string } | { name: string }[] | null }[]>();
  if (accountsError) throw accountsError;

  const accounts: PlatformAccountRow[] = (accountsRaw ?? []).flatMap((a) => {
    const platform = Array.isArray(a.platforms) ? a.platforms[0] : a.platforms;
    if (!platform || !(SOCIAL_PLATFORM_NAMES as readonly string[]).includes(platform.name)) return [];
    return [{ id: a.id, platformName: platform.name as SocialPlatformName }];
  });
  const accountsByPlatform = new Map(accounts.map((a) => [a.platformName, a] as const));
  if (!accountsByPlatform.has("youtube")) {
    throw new Error(
      "no platform_accounts row for youtube — insert one (see youtube-oauth-bootstrap.ts) before publishing"
    );
  }

  const { data: existingPosts, error: postsError } = await supabase
    .from("posts")
    .select("render_id, platform_account_id")
    .in(
      "platform_account_id",
      accounts.map((a) => a.id)
    )
    .eq("status", "published");
  if (postsError) throw postsError;
  const accountIdToPlatform = new Map(accounts.map((a) => [a.id, a.platformName] as const));
  // Only 'published' counts as done — a 'failed' row from a previous
  // attempt should be retried, not permanently skipped.
  const postedPlatformsByRender = new Map<string, Set<SocialPlatformName>>();
  for (const post of existingPosts ?? []) {
    const platformName = accountIdToPlatform.get(post.platform_account_id as string);
    if (!platformName) continue;
    const set = postedPlatformsByRender.get(post.render_id as string) ?? new Set<SocialPlatformName>();
    set.add(platformName);
    postedPlatformsByRender.set(post.render_id as string, set);
  }

  function remainingPlatforms(renderId: string, format: Format): PlatformAccountRow[] {
    const posted = postedPlatformsByRender.get(renderId) ?? new Set<SocialPlatformName>();
    const targets: readonly SocialPlatformName[] = format === "short" ? SOCIAL_PLATFORM_NAMES : (["youtube"] as const);
    return targets
      .filter((name) => !posted.has(name))
      .map((name) => accountsByPlatform.get(name))
      .filter((a): a is PlatformAccountRow => a != null);
  }

  const { data: renders, error: rendersError } = await supabase
    .from("renders")
    .select(
      "id, storage_path, episode_id, episodes(format, air_slot, topics(category, title, key_vocabulary)), scripts(title_suggestion, body)"
    )
    .eq("render_status", "ready")
    .returns<EligibleRender[]>();
  if (rendersError) throw rendersError;

  let eligible = (renders ?? []).filter((r) => {
    if (!approvedRenderIds.has(r.id) || !r.storage_path) return false;
    const format = episodeOf(r)?.format;
    if (!format) return false;
    return remainingPlatforms(r.id, format).length > 0;
  });

  // FIFO by approval time — the renders query above has no ORDER BY, so
  // without this a `--limit 1` cron run could pick an arbitrary approved
  // episode instead of the one that's been waiting longest in the queue.
  eligible.sort((a, b) => {
    const aTime = latestDecisionByRender.get(a.id)?.decided_at ?? "";
    const bTime = latestDecisionByRender.get(b.id)?.decided_at ?? "";
    return aTime.localeCompare(bTime);
  });

  if (onlyRenderId) {
    eligible = eligible.filter((r) => r.id === onlyRenderId);
    if (eligible.length === 0) {
      throw new Error(`render ${onlyRenderId} isn't eligible — not approved yet, already published everywhere it should be, or not render_status='ready'`);
    }
  } else {
    if (airSlot) {
      eligible = eligible.filter((r) => episodeOf(r)?.air_slot === airSlot);
    }
    if (limit != null) {
      eligible = eligible.slice(0, limit);
    }
  }

  console.log(
    `${eligible.length} episode(s) eligible for publish (platforms live: ${[...accountsByPlatform.keys()].join(", ")}; YOUTUBE_UPLOAD_PRIVACY_STATUS=${PRIVACY_STATUS}, TIKTOK_UPLOAD_PRIVACY_LEVEL=${TIKTOK_PRIVACY_LEVEL})`
  );

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
    const socialCaption = buildSocialCaption(script?.body ?? null, decision?.edited_description, topic);

    let videoBuffer: Buffer | null = null; // lazily fetched once, shared by youtube + tiktok (instagram signs its own fresh URL)
    let anySucceeded = false;

    for (const platformAccount of remainingPlatforms(render.id, episode.format)) {
      const { data: post, error: insertError } = await supabase
        .from("posts")
        .insert({
          render_id: render.id,
          platform_account_id: platformAccount.id,
          title,
          description: platformAccount.platformName === "youtube" ? description : socialCaption,
          made_for_kids: true,
          status: "publishing",
        })
        .select("id")
        .single();
      if (insertError) throw insertError;

      try {
        if (platformAccount.platformName === "youtube") {
          videoBuffer ??= await fetchRenderBuffer(render.storage_path!);
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
          await markPublished(post.id, videoId);
          console.log(
            `published ${render.id} -> youtube https://youtube.com/watch?v=${videoId} (actual privacyStatus=${actualPrivacyStatus})`
          );
          if (actualPrivacyStatus !== PRIVACY_STATUS) {
            console.warn(
              `requested privacyStatus=${PRIVACY_STATUS} but YouTube saved it as ${actualPrivacyStatus} — don't assume public uploads are honored, verify manually.`
            );
          }
        } else if (platformAccount.platformName === "tiktok") {
          videoBuffer ??= await fetchRenderBuffer(render.storage_path!);
          const { publishId, status } = await uploadTiktokVideo(videoBuffer, {
            title: socialCaption,
            privacyLevel: TIKTOK_PRIVACY_LEVEL,
          });
          await markPublished(post.id, publishId);
          console.log(`published ${render.id} -> tiktok publish_id=${publishId} (status=${status})`);
          if (TIKTOK_PRIVACY_LEVEL !== "PUBLIC_TO_EVERYONE") {
            console.warn(
              `tiktok post ${publishId} used privacyLevel=${TIKTOK_PRIVACY_LEVEL} — expected pre-audit (see lib/tiktok.ts), not a bug.`
            );
          }
        } else {
          const videoUrl = await signRenderUrl(render.storage_path!, INSTAGRAM_SIGNED_URL_TTL_SECONDS);
          const { mediaId } = await uploadInstagramReel({ videoUrl, caption: socialCaption });
          await markPublished(post.id, mediaId);
          console.log(`published ${render.id} -> instagram media_id=${mediaId}`);
        }
        anySucceeded = true;
      } catch (err) {
        // One platform's failure shouldn't take down the others for the
        // same render, or the rest of the batch.
        console.error(
          `publish ${render.id} to ${platformAccount.platformName} failed:`,
          err instanceof Error ? err.message : err
        );
        await supabase
          .from("posts")
          .update({ status: "failed", error_message: err instanceof Error ? err.message : String(err) })
          .eq("id", post.id);
      }
    }

    // 'published' as soon as any platform succeeds (in practice that's
    // almost always youtube) rather than requiring every platform to
    // succeed — a tiktok/instagram hiccup shouldn't leave the episode
    // stuck 'failed' when it's actually live on the main channel. Whatever
    // platform(s) failed just stay off `postedPlatformsByRender` and get
    // retried on the next run.
    const { error: episodeStatusError } = await supabase
      .from("episodes")
      .update({ status: anySucceeded ? "published" : "failed" })
      .eq("id", render.episode_id);
    if (episodeStatusError) console.error(episodeStatusError);
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
