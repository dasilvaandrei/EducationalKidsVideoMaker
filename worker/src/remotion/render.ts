// Programmatic Remotion render, invoked by jobs/render-episode.ts. Copies
// the sibling project's bundle-once-per-process pattern and NodeNext
// webpack extension fix verbatim (see render.ts in videoMaker/worker) —
// only the composition IDs and default bitrate differ.

import { fileURLToPath } from "node:url";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import type { EpisodeCompositionProps } from "./EpisodeComposition.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const COMPOSITION_IDS = {
  "16:9": "Episode-16x9",
  "9:16": "Episode-9x16",
} as const;

export type AspectRatio = keyof typeof COMPOSITION_IDS;

export type RenderProps = EpisodeCompositionProps;

// Bundling (webpack) is the slow part (~seconds) — do it once per worker
// process and reuse across every render in a batch.
let bundleLocationPromise: Promise<string> | null = null;

function getBundleLocation(): Promise<string> {
  if (!bundleLocationPromise) {
    bundleLocationPromise = bundle({
      entryPoint: path.join(__dirname, "index.ts"),
      // The rest of the worker uses TS NodeNext's "import './x.js' resolves
      // to x.tsx" convention (required for tsc/tsx, not understood by
      // Remotion's own webpack build) — teach webpack the same mapping
      // instead of special-casing import style inside src/remotion.
      webpackOverride: (config) => ({
        ...config,
        resolve: {
          ...config.resolve,
          extensionAlias: {
            ".js": [".js", ".ts", ".tsx"],
          },
        },
      }),
    });
  }
  return bundleLocationPromise;
}

export async function renderEpisode(
  aspectRatio: AspectRatio,
  props: RenderProps,
  outputPath: string
): Promise<void> {
  const serveUrl = await getBundleLocation();
  const compositionId = COMPOSITION_IDS[aspectRatio];

  // props.audioSrc must be a real http(s) URL for the same reason the
  // sibling's videoSrc must be — Remotion's server-side compositor only
  // downloads over HTTP(S), not from a bare local path or file:// URL.
  // jobs/render-episode.ts resolves the voiceover's storage_path into a
  // Supabase signed URL before calling this.
  const inputProps: Record<string, unknown> = { ...props };

  const composition = await selectComposition({
    serveUrl,
    id: compositionId,
    inputProps,
  });

  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    outputLocation: outputPath,
    inputProps,
    // Default is 30s per frame — seen two real timeouts at that default
    // once the composition grew to background-crossfade + mascot +
    // topic-display + captions all layered together, each pulling its own
    // signed-URL image fetch. This is a background batch job, not
    // interactive, so a generous ceiling costs nothing but catches a
    // genuinely stuck render instead of a normal-but-slow frame.
    timeoutInMilliseconds: 120000,
    // Lower than the sibling's 4M default — this is vector/SVG-driven
    // content (flat backgrounds, a simple animated mascot, text captions),
    // which compresses far better than real footage, so a much lower
    // bitrate should still look clean. Tuned down from an initial 2M: a
    // real ~178s long-form episode at 2M came out to ~49.5MB, right at the
    // edge of Supabase Storage's per-project object size cap, and adding
    // the three-act scene background's busier topic scenes (rain/wind/leaf
    // motion, vs. the flat living room alone) pushed a real render over
    // that cap and failed the upload. 1M leaves real headroom.
    videoBitrate: "1M",
  });
}

// Captures a single frame as a YouTube-ready thumbnail image, at $0
// marginal cost: every episode already opens with ThumbnailCard.tsx's
// title-card overlay (giant Paula + title + emoji, built from the same
// mascot images generate-assets.ts generated once via Gemini and caches
// forever), held fully opaque from frame 0 through HOLD_SECONDS (3.2s)
// before crossfading out — any frame inside that window is a clean,
// designed thumbnail with nothing else in the composition visible behind
// it. 16:9 only: YouTube's thumbnails.set is what this feeds (see
// lib/youtube.ts), and Shorts (9:16) don't support custom thumbnails.
export async function renderEpisodeThumbnail(props: RenderProps, outputPath: string, frame: number): Promise<void> {
  const serveUrl = await getBundleLocation();
  const inputProps: Record<string, unknown> = { ...props };

  const composition = await selectComposition({
    serveUrl,
    id: COMPOSITION_IDS["16:9"],
    inputProps,
  });

  await renderStill({ composition, serveUrl, output: outputPath, inputProps, frame });
}
