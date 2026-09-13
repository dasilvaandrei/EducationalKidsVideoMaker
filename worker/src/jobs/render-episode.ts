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
import { renderEpisode, renderEpisodeThumbnail, type AspectRatio, type RenderProps } from "../remotion/render.js";
import { FPS, TRAILING_HOLD_FRAMES } from "../remotion/timing.js";
import { resolveSceneTransitions } from "../lib/sceneAnchors.js";
import { supabase } from "../lib/supabase.js";

const MEDIA_BUCKET = "media";
const SIGNED_URL_TTL_SECONDS = 60 * 30;
// 1.5s into the render — safely inside ThumbnailCard's fully-opaque hold
// window (0 to HOLD_SECONDS=3.2s, see ThumbnailCard.tsx) and before its
// fade starts, so this always captures the clean, fully-formed card. Same
// offset lib/instagram.ts defaults to for its cover-frame timestamp, for
// consistency across platforms.
const THUMBNAIL_FRAME = Math.round(1.5 * FPS);

interface TopicJoin {
  // Doubles as the topic-scene background's image_assets asset_key (kind
  // 'background') — see generate-assets.ts's ensureTopicSceneBackground.
  slug: string;
  category: string;
}

interface EpisodeJoin {
  topics: TopicJoin | TopicJoin[] | null;
}

interface ScriptJoin {
  title_suggestion: string | null;
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
// produces them, this just looks up the cached row's storage path.
// Deliberately does NOT sign the URL here: the caller signs it fresh
// right before each render (see the batch-vs-per-render TTL note below).
async function lookupFixedAssetPath(kind: "mascot" | "background", assetKey: string): Promise<string> {
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
  return data.storage_path;
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
      "id, episode_id, aspect_ratio, episodes(topics(slug, category)), scripts(title_suggestion, key_vocabulary, topic_scene_anchor, home_scene_anchor), voiceovers(storage_path, duration_seconds, captions)"
    )
    .eq("render_status", "queued")
    .returns<QueuedRender[]>();
  if (error) throw error;

  console.log(`${renders?.length ?? 0} renders queued`);
  if (!renders || renders.length === 0) return;

  // Storage paths are fixed for every render this run, looked up once up
  // front — if any are missing, no render in this batch can succeed, so
  // bail out without touching any renders row (they stay 'queued' for the
  // next run, once generate-assets has been run). The signed URLs
  // themselves are NOT resolved here, though: a batch can contain several
  // long-form renders and run well past a signed URL's TTL before it
  // reaches the later items, so each render below signs these paths
  // fresh right before it runs instead of reusing one signed up front
  // (which previously caused later renders in a long batch to fetch an
  // expired URL and fail with an image-decode error). The topic-scene
  // background is NOT fixed across renders (it's per-topic) and was
  // already resolved inside the per-render loop.
  let mascotIdlePath: string;
  let mascotBlinkPath: string;
  let mascotMouthOpenPath: string;
  let mascotWavePath: string;
  let mascotClapPath: string;
  let mascotPointPath: string;
  let mascotThinkPath: string;
  let livingRoomPath: string;
  try {
    [mascotIdlePath, mascotBlinkPath, mascotMouthOpenPath, mascotWavePath, mascotClapPath, mascotPointPath, mascotThinkPath, livingRoomPath] =
      await Promise.all([
        lookupFixedAssetPath("mascot", "idle"),
        lookupFixedAssetPath("mascot", "blink"),
        lookupFixedAssetPath("mascot", "mouth_open"),
        lookupFixedAssetPath("mascot", "wave"),
        lookupFixedAssetPath("mascot", "clap"),
        lookupFixedAssetPath("mascot", "point"),
        lookupFixedAssetPath("mascot", "think"),
        lookupFixedAssetPath("background", "living_room"),
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

      // Signed fresh per render (see the note above the batch-start
      // lookupFixedAssetPath calls) rather than reusing the batch-start
      // URLs, which can outlive the TTL in a long batch.
      const [
        mascotIdleSrc,
        mascotBlinkSrc,
        mascotMouthOpenSrc,
        mascotWaveSrc,
        mascotClapSrc,
        mascotPointSrc,
        mascotThinkSrc,
        livingRoomSrc,
        topicSceneSrc,
      ] = await Promise.all([
        resolveSignedUrl(mascotIdlePath),
        resolveSignedUrl(mascotBlinkPath),
        resolveSignedUrl(mascotMouthOpenPath),
        resolveSignedUrl(mascotWavePath),
        resolveSignedUrl(mascotClapPath),
        resolveSignedUrl(mascotPointPath),
        resolveSignedUrl(mascotThinkPath),
        resolveSignedUrl(livingRoomPath),
        lookupFixedAssetPath("background", topic.slug).then(resolveSignedUrl),
      ]);

      const script = scriptOf(render);
      const totalDurationMs = (voiceover.duration_seconds ?? 0) * 1000;
      const { topicSceneMs, homeSceneMs } = resolveSceneTransitions(
        voiceover.captions,
        script?.topic_scene_anchor ?? null,
        script?.home_scene_anchor ?? null,
        totalDurationMs
      );

      const props: RenderProps = {
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
        title: script?.title_suggestion ?? "",
        heroWord: scriptVocabOf(render)[0] ?? "",
        topicCategory: topic.category,
      };

      await renderEpisode(render.aspect_ratio, props, outputPath);

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

      // $0 thumbnail: capture a frame of the ThumbnailCard overlay every
      // render already composites (see render.ts's renderEpisodeThumbnail)
      // instead of generating separate custom art. 16:9 only — Shorts
      // don't support YouTube's thumbnails.set, and TikTok/Instagram pick
      // their cover by timestamp directly from the uploaded video, not a
      // separate image (see lib/meta.ts / lib/tiktok.ts).
      let thumbnailPath: string | null = null;
      if (render.aspect_ratio === "16:9") {
        const thumbnailOutputPath = join(dir, "thumbnail.png");
        await renderEpisodeThumbnail(props, thumbnailOutputPath, THUMBNAIL_FRAME);
        const thumbnailBuffer = await readFile(thumbnailOutputPath);
        thumbnailPath = `thumbnails/${render.id}.png`;
        const { error: thumbnailUploadError } = await supabase.storage
          .from(MEDIA_BUCKET)
          .upload(thumbnailPath, thumbnailBuffer, { contentType: "image/png", upsert: true });
        if (thumbnailUploadError) throw thumbnailUploadError;
      }

      const { error: readyError } = await supabase
        .from("renders")
        .update({
          storage_path: objectPath,
          duration_seconds: durationSeconds,
          render_status: "ready",
          ...(thumbnailPath ? { thumbnail_path: thumbnailPath } : {}),
        })
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

// One-off catch-up for renders that finished before thumbnail_path
// existed: `ready`, 16:9, and still missing a thumbnail. Reuses the same
// $0 ThumbnailCard-frame-capture approach as the main loop above, just
// with placeholder values (real mascotIdleSrc reused as a stand-in) for
// every field ThumbnailCard doesn't actually read — see
// renderEpisodeThumbnail's comment in render.ts for why that's safe: the
// card is fully opaque for the whole frame it's captured at.
//
// Usage: npm run render-episode -- --backfill-thumbnails
export async function backfillMissingThumbnails(): Promise<void> {
  const { data: renders, error } = await supabase
    .from("renders")
    .select(
      "id, episode_id, aspect_ratio, episodes(topics(category)), scripts(title_suggestion, key_vocabulary), voiceovers(storage_path, captions)"
    )
    .eq("render_status", "ready")
    .eq("aspect_ratio", "16:9")
    .is("thumbnail_path", null)
    .returns<QueuedRender[]>();
  if (error) throw error;

  console.log(`${renders?.length ?? 0} ready 16:9 render(s) missing a thumbnail`);
  if (!renders || renders.length === 0) return;

  const [mascotIdlePath, mascotWavePath] = await Promise.all([
    lookupFixedAssetPath("mascot", "idle"),
    lookupFixedAssetPath("mascot", "wave"),
  ]);

  for (const render of renders) {
    const voiceover = voiceoverOf(render);
    const topic = topicOf(render);
    const script = scriptOf(render);
    if (!voiceover?.storage_path || !topic) {
      console.warn(`skip ${render.id}: missing voiceover or topic`);
      continue;
    }

    const dir = await mkdtemp(join(tmpdir(), "thumb-"));
    try {
      const [audioSrc, mascotIdleSrc, mascotWaveSrc] = await Promise.all([
        resolveSignedUrl(voiceover.storage_path),
        resolveSignedUrl(mascotIdlePath),
        resolveSignedUrl(mascotWavePath),
      ]);

      const props: RenderProps = {
        audioSrc,
        captions: voiceover.captions,
        mascotIdleSrc,
        mascotBlinkSrc: mascotIdleSrc,
        mascotMouthOpenSrc: mascotIdleSrc,
        mascotWaveSrc,
        mascotClapSrc: mascotIdleSrc,
        mascotPointSrc: mascotIdleSrc,
        mascotThinkSrc: mascotIdleSrc,
        livingRoomSrc: mascotIdleSrc,
        topicSceneSrc: mascotIdleSrc,
        topicSceneStartMs: 0,
        homeSceneStartMs: 0,
        vocabularyImages: {},
        title: script?.title_suggestion ?? "",
        heroWord: scriptVocabOf(render)[0] ?? "",
        topicCategory: topic.category,
      };

      const outputPath = join(dir, "thumbnail.png");
      await renderEpisodeThumbnail(props, outputPath, THUMBNAIL_FRAME);
      const buffer = await readFile(outputPath);
      const thumbnailPath = `thumbnails/${render.id}.png`;
      const { error: uploadError } = await supabase.storage
        .from(MEDIA_BUCKET)
        .upload(thumbnailPath, buffer, { contentType: "image/png", upsert: true });
      if (uploadError) throw uploadError;

      const { error: updateError } = await supabase.from("renders").update({ thumbnail_path: thumbnailPath }).eq("id", render.id);
      if (updateError) throw updateError;

      console.log(`backfilled thumbnail for ${render.id} -> ${thumbnailPath}`);
    } catch (err) {
      console.error(`backfill thumbnail for ${render.id} failed:`, err instanceof Error ? err.message : err);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const run = process.argv[2] === "--backfill-thumbnails" ? backfillMissingThumbnails : renderQueuedEpisodes;
  run()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
