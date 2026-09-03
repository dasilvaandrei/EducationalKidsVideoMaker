// Polls `renders` for queued rows, resolves the episode's voiceover and
// the visual-layer image assets (mascot poses, living-room background,
// this episode's vocabulary photos) into fetchable signed URLs, renders
// through EpisodeComposition, and uploads the result back to Supabase
// Storage. Mirrors the sibling project's render-clips.ts structure
// (queue -> optimistic lock -> render -> upload -> mark ready, one bad
// item doesn't kill the batch) — adapted for episodes/voiceovers instead
// of clips/source_videos.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Caption } from "@remotion/captions";
import { renderEpisode, type AspectRatio } from "../remotion/render.js";
import { FPS, TRAILING_HOLD_FRAMES } from "../remotion/timing.js";
import { resolveSceneTransitions } from "../lib/sceneAnchors.js";
import { supabase } from "../lib/supabase.js";

const MEDIA_BUCKET = "media";
const SIGNED_URL_TTL_SECONDS = 60 * 30;

interface TopicJoin {
  // Doubles as the topic-scene background's image_assets asset_key (kind
  // 'background') — see generate-assets.ts's ensureTopicSceneBackground.
  slug: string;
}

interface EpisodeJoin {
  topics: TopicJoin | TopicJoin[] | null;
}

interface ScriptJoin {
  key_vocabulary: string[] | null;
  topic_scene_anchor: string | null;
  home_scene_anchor: string | null;
}

interface VoiceoverJoin {
  storage_path: string | null;
  duration_seconds: number | null;
  captions: Caption[];
}

interface QueuedRender {
  id: string;
  episode_id: string;
  aspect_ratio: AspectRatio;
  episodes: EpisodeJoin | EpisodeJoin[] | null;
  scripts: ScriptJoin | ScriptJoin[] | null;
  voiceovers: VoiceoverJoin | VoiceoverJoin[] | null;
}

function voiceoverOf(render: QueuedRender): VoiceoverJoin | null {
  return Array.isArray(render.voiceovers) ? render.voiceovers[0] ?? null : render.voiceovers;
}

function scriptOf(render: QueuedRender): ScriptJoin | null {
  return Array.isArray(render.scripts) ? render.scripts[0] ?? null : render.scripts;
}

function scriptVocabOf(render: QueuedRender): string[] {
  return scriptOf(render)?.key_vocabulary ?? [];
}

function topicOf(render: QueuedRender): TopicJoin | null {
  const episode = Array.isArray(render.episodes) ? render.episodes[0] : render.episodes;
  const topic = Array.isArray(episode?.topics) ? episode?.topics[0] : episode?.topics;
  return topic ?? null;
}

async function resolveSignedUrl(storagePath: string): Promise<string> {
  const { data, error } = await supabase.storage.from(MEDIA_BUCKET).createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
  if (error) throw error;
  return data.signedUrl;
}

// Mascot poses and the background are fixed (kind, asset_key) rows,
// identical for every render — generate-assets.ts is what actually
// produces them, this just looks up the cached row.
async function resolveFixedAsset(kind: "mascot" | "background", assetKey: string): Promise<string> {
  const { data, error } = await supabase
    .from("image_assets")
    .select("storage_path")
    .eq("kind", kind)
    .eq("asset_key", assetKey)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new Error(`image_assets has no (${kind}, ${assetKey}) row — run \`npm run generate-assets\` first`);
  }
  return resolveSignedUrl(data.storage_path);
}

// Resolves this render's specific vocabulary words to signed image URLs,
// skipping any word without a cached image rather than failing the whole
// render — a script's LLM-extracted vocabulary won't always exactly
// match the pre-seeded topic list, so partial coverage is expected, not
// an error.
async function resolveVocabularyImages(words: string[]): Promise<Record<string, string>> {
  if (words.length === 0) return {};

  const { data: rows, error } = await supabase
    .from("image_assets")
    .select("asset_key, storage_path")
    .eq("kind", "vocabulary")
    .in("asset_key", words)
    .returns<{ asset_key: string; storage_path: string }[]>();
  if (error) throw error;

  const images: Record<string, string> = {};
  for (const row of rows ?? []) {
    images[row.asset_key] = await resolveSignedUrl(row.storage_path);
  }
  return images;
}

export async function renderQueuedEpisodes(): Promise<void> {
  const { data: renders, error } = await supabase
    .from("renders")
    .select(
      "id, episode_id, aspect_ratio, episodes(topics(slug)), scripts(key_vocabulary, topic_scene_anchor, home_scene_anchor), voiceovers(storage_path, duration_seconds, captions)"
    )
    .eq("render_status", "queued")
    .returns<QueuedRender[]>();
  if (error) throw error;

  console.log(`${renders?.length ?? 0} renders queued`);
  if (!renders || renders.length === 0) return;

  // Fixed for every render this run — resolved once up front rather than
  // per-render. If they're missing, no render in this batch can succeed,
  // so bail out without touching any renders row (they stay 'queued' for
  // the next run, once generate-assets has been run). The topic-scene
  // background is NOT fixed across renders (it's per-topic), so it's
  // resolved inside the per-render loop below instead.
  let mascotIdleSrc: string;
  let mascotBlinkSrc: string;
  let mascotMouthOpenSrc: string;
  let mascotWaveSrc: string;
  let mascotClapSrc: string;
  let mascotPointSrc: string;
  let mascotThinkSrc: string;
  let livingRoomSrc: string;
  try {
    [mascotIdleSrc, mascotBlinkSrc, mascotMouthOpenSrc, mascotWaveSrc, mascotClapSrc, mascotPointSrc, mascotThinkSrc, livingRoomSrc] =
      await Promise.all([
        resolveFixedAsset("mascot", "idle"),
        resolveFixedAsset("mascot", "blink"),
        resolveFixedAsset("mascot", "mouth_open"),
        resolveFixedAsset("mascot", "wave"),
        resolveFixedAsset("mascot", "clap"),
        resolveFixedAsset("mascot", "point"),
        resolveFixedAsset("mascot", "think"),
        resolveFixedAsset("background", "living_room"),
      ]);
  } catch (err) {
    console.error("render-episode: required image assets not ready:", err instanceof Error ? err.message : err);
    return;
  }

  for (const render of renders) {
    const voiceover = voiceoverOf(render);
    if (!voiceover || !voiceover.storage_path) {
      console.warn(`skip render ${render.id}: no ready voiceover`);
      continue;
    }

    // Optimistic lock: only proceed if still queued (guards against a
    // second concurrent worker process picking up the same row).
    await supabase.from("renders").update({ render_status: "rendering" }).eq("id", render.id).eq("render_status", "queued");

    const dir = await mkdtemp(join(tmpdir(), "render-"));
    const outputPath = join(dir, "output.mp4");

    try {
      const { data: signed, error: signError } = await supabase.storage
        .from(MEDIA_BUCKET)
        .createSignedUrl(voiceover.storage_path, SIGNED_URL_TTL_SECONDS);
      if (signError) throw signError;

      // Script-only on purpose — no fallback to the topic's pre-seeded
      // vocabulary list, so a pop-up only ever appears for a word this
      // episode's actual script uses.
      const words = [...new Set(scriptVocabOf(render).map((w) => w.trim().toLowerCase()).filter(Boolean))];
      const vocabularyImages = await resolveVocabularyImages(words);

      const topic = topicOf(render);
      if (!topic) throw new Error(`render ${render.id}: episode has no joined topic`);
      const topicSceneSrc = await resolveFixedAsset("background", topic.slug);

      const script = scriptOf(render);
      const totalDurationMs = (voiceover.duration_seconds ?? 0) * 1000;
      const { topicSceneMs, homeSceneMs } = resolveSceneTransitions(
        voiceover.captions,
        script?.topic_scene_anchor ?? null,
        script?.home_scene_anchor ?? null,
        totalDurationMs
      );

      await renderEpisode(
        render.aspect_ratio,
        {
          audioSrc: signed.signedUrl,
          captions: voiceover.captions,
          mascotIdleSrc,
          mascotBlinkSrc,
          mascotMouthOpenSrc,
          mascotWaveSrc,
          mascotClapSrc,
          mascotPointSrc,
          mascotThinkSrc,
          livingRoomSrc,
          topicSceneSrc,
          topicSceneStartMs: topicSceneMs,
          homeSceneStartMs: homeSceneMs,
          vocabularyImages,
        },
        outputPath
      );

      const objectPath = `renders/${render.id}.mp4`;
      const fileBuffer = await readFile(outputPath);
      const { error: uploadError } = await supabase.storage
        .from(MEDIA_BUCKET)
        .upload(objectPath, fileBuffer, { contentType: "video/mp4", upsert: true });
      if (uploadError) throw uploadError;

      // Derived the same way Root.tsx's calculateMetadata sizes the
      // render, rather than re-probing the output mp4 — avoids pulling
      // mediabunny's file-reading path into this job for a number we can
      // already compute exactly from the voiceover's own known duration.
      const durationSeconds = (voiceover.duration_seconds ?? 0) + TRAILING_HOLD_FRAMES / FPS;

      const { error: readyError } = await supabase
        .from("renders")
        .update({ storage_path: objectPath, duration_seconds: durationSeconds, render_status: "ready" })
        .eq("id", render.id);
      if (readyError) throw readyError;

      // Advances episodes.status: rendering -> ready, i.e. eligible for
      // the pending_reviews view once its safety check has also passed.
      const { error: episodeReadyError } = await supabase
        .from("episodes")
        .update({ status: "ready" })
        .eq("id", render.episode_id);
      if (episodeReadyError) throw episodeReadyError;

      console.log(`rendered ${render.id} -> ${objectPath} (${Object.keys(vocabularyImages).length}/${words.length} vocab images)`);
    } catch (err) {
      // One bad render shouldn't take down the rest of the batch.
      console.error(`render ${render.id} failed:`, err instanceof Error ? err.message : err);
      await supabase.from("renders").update({ render_status: "failed" }).eq("id", render.id);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  renderQueuedEpisodes()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
