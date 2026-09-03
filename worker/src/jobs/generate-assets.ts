// Generates and caches the small, fixed set of image assets the visual
// layer reuses across every episode forever: the mascot's pose frames,
// the living-room background, and one photo per unique vocabulary word
// across all topics. This is NOT part of the per-episode render pipeline
// — it runs standalone, ahead of time, and each asset is generated at
// most once (see the `unique (kind, asset_key)` constraint on
// image_assets). Safe to re-run any time: every phase checks
// image_assets first and skips anything already cached, so an
// interrupted run (or a newly-added topic with new vocabulary) just
// picks up where it left off.
//
// Character consistency for the mascot's blink/mouth_open frames comes
// from passing the already-generated idle image back into Gemini as a
// reference (see lib/gemini.ts's generateImage) rather than three
// independent from-scratch generations, which is known to drift a
// character's appearance across calls.

import sharp from "sharp";
import { generateImage, MODEL } from "../lib/gemini.js";
import { supabase } from "../lib/supabase.js";

const MEDIA_BUCKET = "media";

type AssetKind = "mascot" | "background" | "vocabulary";

// Background is a chroma-key green rather than white: the penguin's belly
// is also white, so a plain-white background can't be safely color-keyed
// out with a naive global threshold (it would punch a hole through the
// belly too). removeChromaKeyBackground() below flood-fills from the
// border instead, which only works if the fill color is far from every
// color actually used in the character (blue body / white belly / orange
// beak+feet / black outlines) — hence a saturated green instead of white.
const CHROMA_KEY_HEX = "#00FF00";
const CHROMA_KEY_INSTRUCTION = `solid, flat, saturated chroma-key green background (${CHROMA_KEY_HEX}) — no gradient, no shadow, no texture, solid flat color fill covering the entire background, evenly lit`;

const MASCOT_IDLE_PROMPT =
  `A single children's-cartoon mascot character named "Paula the Penguin": a friendly baby emperor penguin, round and chubby body, bright sky-blue (#4FB6E8) feathers covering the back, head, and top of the wings, a soft white-and-pale-yellow belly patch, small rounded orange-yellow webbed feet, a small round orange-yellow beak, two big round black eyes each with a small white eye-shine highlight, small rounded flippers relaxed at its sides (no hands/fingers). Simple flat 2D vector illustration style, thick clean black outlines, minimal shading, solid flat color fills, no gradients, no textures, no background scenery — ${CHROMA_KEY_INSTRUCTION}, so the character can be color-keyed out cleanly. Centered in frame, standing upright, facing forward, a warm closed-beak smile, calm neutral "idle" pose suitable as a character reference sheet for a children's TV show. Keep the face and proportions clean and simple so this exact design can be redrawn consistently later.`;

const MASCOT_BLINK_PROMPT =
  `Same exact character, same exact art style, same pose, same colors, same proportions, same ${CHROMA_KEY_INSTRUCTION} as the reference image — the only change: the character's eyes are fully closed, drawn as two simple curved closed-eye lines (a relaxed, happy blink). Everything else must stay identical to the reference image.`;

const MASCOT_MOUTH_OPEN_PROMPT =
  `Same exact character, same exact art style, same pose, same colors, same proportions, same ${CHROMA_KEY_INSTRUCTION} as the reference image — the only change: the character's beak is open wide as if mid-speech. Everything else must stay identical to the reference image.`;

// Gesture poses — swapped in briefly by Mascot.tsx when a caption word
// like "wave" or "clap" is actually spoken, so the mascot visibly performs
// the action instead of just standing in its idle/talk cycle while
// narrating it. Same reference-image-conditioned generation as
// blink/mouth_open above, so these stay visually consistent with the
// established character.
const MASCOT_WAVE_PROMPT =
  `Same exact character, same exact art style, same colors, same proportions, same ${CHROMA_KEY_INSTRUCTION} as the reference image — the only change: one wing/flipper is raised up beside the head in a clear waving motion, the character leaning slightly into the wave, a big warm open-beak smile. Everything else must stay identical to the reference image.`;

const MASCOT_CLAP_PROMPT =
  `Same exact character, same exact art style, same colors, same proportions, same ${CHROMA_KEY_INSTRUCTION} as the reference image — the only change: both wings/flippers are brought together in front of the body as if clapping, a delighted open-beak smile. Everything else must stay identical to the reference image.`;

const MASCOT_POINT_PROMPT =
  `Same exact character, same exact art style, same colors, same proportions, same ${CHROMA_KEY_INSTRUCTION} as the reference image — the only change: one wing/flipper is extended outward and upward, clearly pointing off to the side, an interested/excited expression. Everything else must stay identical to the reference image.`;

const MASCOT_THINK_PROMPT =
  `Same exact character, same exact art style, same colors, same proportions, same ${CHROMA_KEY_INSTRUCTION} as the reference image — the only change: the head is tilted slightly to one side and one wing/flipper is raised near the chin/beak as if thinking, a curious, wondering expression, eyebrows slightly raised. Everything else must stay identical to the reference image.`;

const LIVING_ROOM_PROMPT =
  "A warm, cozy, kid-friendly cartoon living room scene for a children's educational TV show background: soft pastel colors, a comfy couch, a rug, a sunlit window, a bookshelf, a few scattered toys, simple flat 2D illustration style (not photorealistic), gentle rounded shapes, no people, no characters, no text or logos anywhere in the image. IMPORTANT COMPOSITION REQUIREMENT: leave the entire center and lower-center of the frame visually open and uncluttered — plain floor/wall, no large furniture or objects there — because an on-screen mascot character and word-highlighted captions will be placed on top of that area. Put the more detailed/decorative elements (bookshelf, window, framed pictures, toys) toward the edges and upper corners of the frame instead, away from that open middle/lower zone.";

interface TopicSceneRow {
  id: string;
  slug: string;
  category: string;
  title: string;
  key_vocabulary: string[];
}

const SCENE_STYLE_SUFFIX =
  "Simple flat 2D vector illustration style (matching a children's TV show's living-room background), thick clean black outlines, minimal shading, solid flat bright warm color fills, no gradients other than a soft sky if one is shown, no people, no characters, no text or logos anywhere in the image. IMPORTANT COMPOSITION REQUIREMENT: leave the entire center and lower-center of the frame visually open and uncluttered — plain ground/floor, no large objects there — because an on-screen mascot character and word-highlighted captions will be placed on top of that area. Put the more detailed/decorative elements toward the edges and upper corners of the frame instead.";

// Deterministic (no extra LLM call) per-category scene framing, filled in
// with the specific topic's own title/vocabulary so the scene is actually
// about this topic rather than a generic category stand-in — e.g. "Why
// Does It Rain?" (science_how_things_work, vocab rain/cloud/water) reads
// as a grassy field under clouds with rain falling, not a generic
// "science" backdrop. Covers all 6 topics.category values from the
// check constraint in init_schema.sql.
function buildTopicScenePrompt(topic: TopicSceneRow): string {
  const vocab = topic.key_vocabulary.slice(0, 4).join(", ");
  const heroWord = topic.key_vocabulary[0] ?? topic.title;

  let scene: string;
  switch (topic.category) {
    case "science_how_things_work":
      scene = `An outdoor scene setting up the phenomenon behind "${topic.title}" for young children: a bright grassy green field or open sky-facing view under a sky that visibly shows ${vocab} happening — e.g. fluffy white clouds, falling rain, sunshine, wind-blown leaves, or whatever ${heroWord} looks like in real life, drawn clearly and simply enough for a preschooler to recognize.`;
      break;
    case "animals":
      scene = `A cheerful natural habitat scene for the animal(s) in "${topic.title}" (${vocab}) — the specific kind of environment that animal actually lives in (jungle, savanna, ocean/reef, farm, arctic, forest, etc., chosen to match ${heroWord}), with open sky or background visible above.`;
      break;
    case "colors_shapes":
      scene = `A bright, playful outdoor scene built around the colors/shapes in "${topic.title}" (${vocab}) — those specific colors and shapes appearing naturally as balloons, blocks, kites, or painted playground markings scattered around the edges of the scene.`;
      break;
    case "counting_numbers":
      scene = `A cheerful outdoor scene built around counting for "${topic.title}" (${vocab}) — a small, clearly countable group of simple objects (balloons, stars, blocks, flowers) matching the topic, arranged around the edges of the scene so they're easy to count.`;
      break;
    case "phonics_abcs":
      scene = `A bright, playful scene themed around the letter and example objects in "${topic.title}" (${vocab}) — those specific objects appearing naturally in the scene, arranged around the edges.`;
      break;
    case "emotions_manners":
      scene = `A warm, relatable everyday scene (a sunny playground, a classroom, a park) that fits the theme of "${topic.title}" (${vocab}), inviting and calm.`;
      break;
    default:
      scene = `A bright, welcoming scene relevant to "${topic.title}" (${vocab}).`;
  }

  return `${scene} ${SCENE_STYLE_SUFFIX}`;
}

// Exported so a single missing topic-scene background (e.g. right after a
// new topic is added, or for a targeted live-verification run) can be
// generated without paying for the full 48-topic backfill — mirrors
// ensureMascotAssets() being exported for the same reason.
export async function ensureTopicSceneBackground(topic: TopicSceneRow): Promise<void> {
  if (await getExistingAsset("background", topic.slug)) {
    console.log(`generate-assets: topic-scene background "${topic.slug}" already cached, skipping`);
    return;
  }
  const prompt = buildTopicScenePrompt(topic);
  console.log(`generate-assets: generating topic-scene background "${topic.slug}"...`);
  const buffer = await generateImage(prompt);
  const storagePath = `assets/background/${topic.slug}.png`;
  await uploadImage(storagePath, buffer);
  await cacheImage({ kind: "background", assetKey: topic.slug, storagePath, prompt, referenceAssetId: null });
  console.log(`generate-assets: topic-scene background "${topic.slug}" cached -> ${storagePath}`);
}

// Full backfill across every topic — only generates what's missing (same
// pattern as ensureVocabularyAssets), one bad topic doesn't stop the rest.
// Expensive (up to 48 Gemini calls) so this only runs as part of the full
// generateAssets() sweep, not the targeted single-topic path above.
async function ensureAllTopicSceneBackgrounds(): Promise<void> {
  const { data: topics, error } = await supabase
    .from("topics")
    .select("id, slug, category, title, key_vocabulary")
    .returns<TopicSceneRow[]>();
  if (error) throw error;

  console.log(`generate-assets: checking topic-scene backgrounds for ${topics?.length ?? 0} topic(s)...`);
  for (const topic of topics ?? []) {
    try {
      await ensureTopicSceneBackground(topic);
    } catch (err) {
      console.error(
        `generate-assets: failed to generate topic-scene background for "${topic.slug}":`,
        err instanceof Error ? err.message : err
      );
    }
  }
}

function vocabularyPrompt(word: string): string {
  // A handful of topics.key_vocabulary entries are single letters (the
  // phonics_abcs category, e.g. "B") rather than nouns — a bare glyph
  // isn't a "real-life photograph" of anything, so route those to a
  // genuinely photographable object (an alphabet block) instead of
  // asking Gemini to photograph an abstract letter shape.
  if (/^[a-z]$/i.test(word)) {
    return `A real-life photograph of a colorful wooden alphabet block showing the single capital letter "${word.toUpperCase()}", photographed close-up on a plain white background, soft natural lighting, no other objects in frame, no additional text.`;
  }
  return `A real-life photograph of ${word}: a single clear subject centered in the frame, plain simple background, soft natural lighting, photorealistic (not illustrated, not a drawing, not a cartoon), no text overlays, suitable as a children's flashcard image.`;
}

interface CachedAsset {
  id: string;
  storage_path: string;
}

async function getExistingAsset(kind: AssetKind, assetKey: string): Promise<CachedAsset | null> {
  const { data, error } = await supabase
    .from("image_assets")
    .select("id, storage_path")
    .eq("kind", kind)
    .eq("asset_key", assetKey)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function downloadAsset(storagePath: string): Promise<Buffer> {
  const { data, error } = await supabase.storage.from(MEDIA_BUCKET).download(storagePath);
  if (error) throw error;
  return Buffer.from(await data.arrayBuffer());
}

async function uploadImage(storagePath: string, buffer: Buffer): Promise<void> {
  const { error } = await supabase.storage
    .from(MEDIA_BUCKET)
    .upload(storagePath, buffer, { contentType: "image/png", upsert: true });
  if (error) throw error;
}

// Euclidean RGB distance a pixel can be from the sampled key color and
// still count as "background" — needs to be loose enough to catch the soft
// anti-aliased fringe around the fill (empirically the fill color itself
// sampled ~150-170 away from the character's actual black outline/blue
// body/orange beak colors, even though the prompt asked for pure #00FF00),
// while staying comfortably below that outline distance so a flood fill can
// never punch through it into the belly.
const CHROMA_KEY_TOLERANCE = 180;

function colorDistance(r: number, g: number, b: number, keyR: number, keyG: number, keyB: number): number {
  const dr = r - keyR;
  const dg = g - keyG;
  const db = b - keyB;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

// Cuts the chroma-key background out of a mascot pose image, leaving a real
// alpha channel. Deliberately a flood fill from the border rather than a
// global "make every near-key-color pixel transparent" pass — the
// character has no green anywhere in it, but a global threshold would still
// be the wrong tool in principle, whereas a border-seeded flood fill only
// ever removes background pixels that are actually *connected* to the
// border through other near-key-color pixels; anything enclosed by the
// character's black outline (the belly, in particular) survives no matter
// how close its color happens to be to the key, because the outline itself
// is never near-key-colored and blocks the fill from tunneling through it.
//
// The key color is sampled from this image's own corner pixels rather than
// assumed to be a fixed RGB constant — Gemini doesn't reliably hit the
// exact hex asked for in the prompt (a muted olive-green came back instead
// of pure #00FF00 in practice), so "whatever color the corners actually
// are" is the only reliable reference.
async function removeChromaKeyBackground(buffer: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;

  const cornerIndices = [
    0,
    (width - 1) * channels,
    (height - 1) * width * channels,
    ((height - 1) * width + (width - 1)) * channels,
  ];
  let keyR = 0;
  let keyG = 0;
  let keyB = 0;
  for (const ci of cornerIndices) {
    keyR += data[ci];
    keyG += data[ci + 1];
    keyB += data[ci + 2];
  }
  keyR /= cornerIndices.length;
  keyG /= cornerIndices.length;
  keyB /= cornerIndices.length;

  const isNearKey = (r: number, g: number, b: number) => colorDistance(r, g, b, keyR, keyG, keyB) <= CHROMA_KEY_TOLERANCE;

  const visited = new Uint8Array(width * height);
  const stack: number[] = [];

  const seedIfChroma = (x: number, y: number) => {
    const pixelIndex = y * width + x;
    if (visited[pixelIndex]) return;
    const dataIndex = pixelIndex * channels;
    if (isNearKey(data[dataIndex], data[dataIndex + 1], data[dataIndex + 2])) {
      visited[pixelIndex] = 1;
      stack.push(pixelIndex);
    }
  };

  for (let x = 0; x < width; x++) {
    seedIfChroma(x, 0);
    seedIfChroma(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    seedIfChroma(0, y);
    seedIfChroma(width - 1, y);
  }

  while (stack.length > 0) {
    const pixelIndex = stack.pop()!;
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);
    data[pixelIndex * channels + 3] = 0;

    const neighbors: Array<[number, number]> = [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ];
    for (const [nx, ny] of neighbors) {
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const nIndex = ny * width + nx;
      if (visited[nIndex]) continue;
      const dataIndex = nIndex * channels;
      if (isNearKey(data[dataIndex], data[dataIndex + 1], data[dataIndex + 2])) {
        visited[nIndex] = 1;
        stack.push(nIndex);
      }
    }
  }

  return sharp(data, { raw: { width, height, channels } }).png().toBuffer();
}

// How many distinct fill colors to keep when building a reference palette
// — the character is flat-shaded vector art with a handful of solid
// regions (blue body, white belly, orange beak/feet, black outline, white
// eye-shine, black pupil), so this comfortably covers every real color
// with margin to spare.
const PALETTE_SIZE = 8;
// Below this alpha, a pixel is anti-aliased edge/outline blending rather
// than solid fill — skipped both when building the palette and when
// snapping to it, so outlines stay smooth instead of going jagged.
const OPAQUE_ALPHA_THRESHOLD = 250;
// Every Nth opaque pixel is used for palette extraction (k-means below is
// O(iterations * points * PALETTE_SIZE) — a 1024x1024 image has ~1M
// pixels, too many to cluster directly without this).
const KMEANS_SAMPLE_STRIDE = 4;
const KMEANS_ITERATIONS = 12;

// Builds a small representative color palette from an image's solid
// (fully-opaque) pixels, via k-means (k-means++ initialization) rather
// than picking the most *frequent* colors. Frequency-based selection was
// tried first and failed in practice: the orange beak/feet cover far
// fewer pixels than the blue body or white belly, so their color lost out
// to near-duplicate anti-aliased shades of the bigger regions and never
// made the cut — every pose's beak/feet then got palette-snapped to
// whatever *did* make the cut (visibly wrong). k-means++ initialization
// greedily picks each new centroid to be as far as possible (in RGB
// space) from the centroids already chosen, so a small-but-genuinely-
// distinct region like solid orange reliably claims its own centroid
// regardless of how little area it covers, as long as PALETTE_SIZE is
// large enough to cover the character's real color count (see above).
async function extractPalette(buffer: Buffer): Promise<Array<{ r: number; g: number; b: number }>> {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;

  const points: Array<[number, number, number]> = [];
  for (let i = 0; i < width * height; i += KMEANS_SAMPLE_STRIDE) {
    const idx = i * channels;
    if (data[idx + 3] < OPAQUE_ALPHA_THRESHOLD) continue;
    points.push([data[idx], data[idx + 1], data[idx + 2]]);
  }
  if (points.length === 0) return [];

  const k = Math.min(PALETTE_SIZE, points.length);
  const centroids: Array<[number, number, number]> = [points[Math.floor(Math.random() * points.length)]];
  while (centroids.length < k) {
    let farthestPoint = points[0];
    let farthestDist = -1;
    for (const p of points) {
      let nearestCentroidDist = Infinity;
      for (const c of centroids) {
        const d = colorDistance(p[0], p[1], p[2], c[0], c[1], c[2]);
        if (d < nearestCentroidDist) nearestCentroidDist = d;
      }
      if (nearestCentroidDist > farthestDist) {
        farthestDist = nearestCentroidDist;
        farthestPoint = p;
      }
    }
    centroids.push(farthestPoint);
  }

  const assignments = new Array<number>(points.length).fill(0);
  for (let iter = 0; iter < KMEANS_ITERATIONS; iter++) {
    for (let i = 0; i < points.length; i++) {
      let best = 0;
      let bestDist = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const d = colorDistance(points[i][0], points[i][1], points[i][2], centroids[c][0], centroids[c][1], centroids[c][2]);
        if (d < bestDist) {
          bestDist = d;
          best = c;
        }
      }
      assignments[i] = best;
    }

    const sums = centroids.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < points.length; i++) {
      const c = assignments[i];
      sums[c][0] += points[i][0];
      sums[c][1] += points[i][1];
      sums[c][2] += points[i][2];
      sums[c][3] += 1;
    }
    for (let c = 0; c < centroids.length; c++) {
      if (sums[c][3] > 0) {
        centroids[c] = [Math.round(sums[c][0] / sums[c][3]), Math.round(sums[c][1] / sums[c][3]), Math.round(sums[c][2] / sums[c][3])];
      }
    }
  }

  return centroids.map(([r, g, b]) => ({ r, g, b }));
}

// Forces every solidly-opaque pixel to the nearest color in `palette`,
// leaving alpha and anti-aliased edge pixels untouched. Necessary because
// Gemini's reference-image-conditioned generation keeps a character's
// *shape* consistent across separate calls but not its exact *color* — the
// idle/blink/wave/etc. prompts all ask for the same hex body color, but
// each call still lands on a slightly different shade in practice, which
// reads as a visible color flicker once poses are frame-swapped during
// playback (most noticeable on the idle<->mouth_open swap, since that
// alternates on every spoken syllable). Palette-snapping is a deterministic
// fix for that rather than relying on prompt wording to hold across calls.
async function snapToPalette(buffer: Buffer, palette: Array<{ r: number; g: number; b: number }>): Promise<Buffer> {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;

  for (let i = 0; i < width * height; i++) {
    const idx = i * channels;
    if (data[idx + 3] < OPAQUE_ALPHA_THRESHOLD) continue;
    const r = data[idx];
    const g = data[idx + 1];
    const b = data[idx + 2];
    let best = palette[0];
    let bestDist = Infinity;
    for (const c of palette) {
      const dist = colorDistance(r, g, b, c.r, c.g, c.b);
      if (dist < bestDist) {
        bestDist = dist;
        best = c;
      }
    }
    data[idx] = best.r;
    data[idx + 1] = best.g;
    data[idx + 2] = best.b;
  }

  return sharp(data, { raw: { width, height, channels } }).png().toBuffer();
}

async function cacheImage(params: {
  kind: AssetKind;
  assetKey: string;
  storagePath: string;
  prompt: string;
  referenceAssetId: string | null;
}): Promise<CachedAsset> {
  const { data, error } = await supabase
    .from("image_assets")
    .upsert(
      {
        kind: params.kind,
        asset_key: params.assetKey,
        storage_path: params.storagePath,
        prompt: params.prompt,
        reference_asset_id: params.referenceAssetId,
        model: MODEL,
      },
      { onConflict: "kind,asset_key" }
    )
    .select("id, storage_path")
    .single();
  if (error) throw error;
  return data;
}

// Exported so a targeted mascot-only regeneration (e.g. after a prompt/
// background-removal change) doesn't have to pay for a full
// generateAssets() run through the ~150-entry vocabulary phase too.
//
// mouth_open, not idle, is the canonical color reference every other pose
// gets palette-snapped to. That's a deliberate choice, not an arbitrary
// one: idle was the original reference, but once mouth_open existed
// alongside it, the belly's internal light/shadow gradient landed in a
// visibly different pattern between the two (same color *set*, different
// shading *shape*, since each was an independent Gemini generation) — the
// user watched the actual render and asked to standardize on the
// mouth-open version specifically, so that's the source of truth now.
export async function ensureMascotAssets(): Promise<void> {
  let idle = await getExistingAsset("mascot", "idle");
  // Kept as the reference image passed to Gemini for every delta pose
  // below — must still have its chroma-key green background (Gemini is
  // told "same green background as the reference image"), so this is the
  // pre-background-removal buffer, not the transparent one that gets
  // uploaded/cached. Only populated when idle is generated fresh in this
  // run; deltas regenerated against a pre-existing (already-transparent)
  // cached idle fall back to downloading the stored version below.
  let freshIdleRawBuffer: Buffer | null = null;
  if (!idle) {
    console.log("generate-assets: generating mascot idle pose...");
    const rawBuffer = await generateImage(MASCOT_IDLE_PROMPT);
    freshIdleRawBuffer = rawBuffer;
    const buffer = await removeChromaKeyBackground(rawBuffer);
    const storagePath = "assets/mascot/idle.png";
    // Uploaded once here so it exists as a real asset; re-uploaded below
    // (overwriting this content) once mouth_open's canonical palette is
    // known, since idle is no longer the color source of truth.
    await uploadImage(storagePath, buffer);
    idle = await cacheImage({ kind: "mascot", assetKey: "idle", storagePath, prompt: MASCOT_IDLE_PROMPT, referenceAssetId: null });
    console.log(`generate-assets: mascot idle cached -> ${storagePath}`);
  } else {
    console.log("generate-assets: mascot idle already cached, skipping");
  }
  const idleBuffer = freshIdleRawBuffer ?? (await downloadAsset(idle.storage_path));

  let mouthOpen = await getExistingAsset("mascot", "mouth_open");
  let canonicalPalette: Array<{ r: number; g: number; b: number }>;
  if (!mouthOpen) {
    console.log("generate-assets: generating mascot mouth_open (referencing idle; canonical color source)...");
    const rawBuffer = await generateImage(MASCOT_MOUTH_OPEN_PROMPT, idleBuffer);
    const keyed = await removeChromaKeyBackground(rawBuffer);
    canonicalPalette = await extractPalette(keyed);
    const storagePath = "assets/mascot/mouth_open.png";
    await uploadImage(storagePath, keyed);
    mouthOpen = await cacheImage({
      kind: "mascot",
      assetKey: "mouth_open",
      storagePath,
      prompt: MASCOT_MOUTH_OPEN_PROMPT,
      referenceAssetId: idle.id,
    });
    console.log(`generate-assets: mascot mouth_open cached -> ${storagePath}`);
  } else {
    canonicalPalette = await extractPalette(await downloadAsset(mouthOpen.storage_path));
  }

  if (freshIdleRawBuffer) {
    const idleKeyed = await removeChromaKeyBackground(freshIdleRawBuffer);
    const idleSnapped = await snapToPalette(idleKeyed, canonicalPalette);
    await uploadImage(idle.storage_path, idleSnapped);
  }

  const deltaSpecs = [
    { assetKey: "blink", prompt: MASCOT_BLINK_PROMPT },
    { assetKey: "wave", prompt: MASCOT_WAVE_PROMPT },
    { assetKey: "clap", prompt: MASCOT_CLAP_PROMPT },
    { assetKey: "point", prompt: MASCOT_POINT_PROMPT },
    { assetKey: "think", prompt: MASCOT_THINK_PROMPT },
  ];
  const missingDeltas = [];
  for (const spec of deltaSpecs) {
    if (!(await getExistingAsset("mascot", spec.assetKey))) missingDeltas.push(spec);
    else console.log(`generate-assets: mascot ${spec.assetKey} already cached, skipping`);
  }
  if (missingDeltas.length === 0) return;

  for (const spec of missingDeltas) {
    console.log(`generate-assets: generating mascot ${spec.assetKey} (referencing idle)...`);
    const rawBuffer = await generateImage(spec.prompt, idleBuffer);
    const keyed = await removeChromaKeyBackground(rawBuffer);
    const buffer = await snapToPalette(keyed, canonicalPalette);
    const storagePath = `assets/mascot/${spec.assetKey}.png`;
    await uploadImage(storagePath, buffer);
    await cacheImage({ kind: "mascot", assetKey: spec.assetKey, storagePath, prompt: spec.prompt, referenceAssetId: idle.id });
    console.log(`generate-assets: mascot ${spec.assetKey} cached -> ${storagePath}`);
  }
}

// One-off correction: re-snaps every OTHER mascot pose (idle included) to
// the mouth_open image's own color palette — mouth_open is the canonical
// reference (see ensureMascotAssets()'s comment), not idle. Re-downloads
// each from Storage, snaps it, re-uploads over the same storage_path. No
// Gemini calls, no image_assets changes (the path is identical).
export async function recolorAllMascotPosesToMouthOpenPalette(): Promise<void> {
  const mouthOpen = await getExistingAsset("mascot", "mouth_open");
  if (!mouthOpen) throw new Error("no cached mascot mouth_open pose — run generate-assets first");
  const canonicalPalette = await extractPalette(await downloadAsset(mouthOpen.storage_path));

  const otherPoseKeys = ["idle", "blink", "wave", "clap", "point", "think"];
  for (const assetKey of otherPoseKeys) {
    const existing = await getExistingAsset("mascot", assetKey);
    if (!existing) {
      console.log(`recolor-mascot: ${assetKey} not cached yet, skipping`);
      continue;
    }
    const buffer = await downloadAsset(existing.storage_path);
    const recolored = await snapToPalette(buffer, canonicalPalette);
    await uploadImage(existing.storage_path, recolored);
    console.log(`recolor-mascot: ${assetKey} recolored -> ${existing.storage_path}`);
  }
}

async function ensureBackgroundAsset(): Promise<void> {
  if (await getExistingAsset("background", "living_room")) {
    console.log("generate-assets: background living_room already cached, skipping");
    return;
  }
  console.log("generate-assets: generating living_room background...");
  const buffer = await generateImage(LIVING_ROOM_PROMPT);
  const storagePath = "assets/background/living_room.png";
  await uploadImage(storagePath, buffer);
  await cacheImage({ kind: "background", assetKey: "living_room", storagePath, prompt: LIVING_ROOM_PROMPT, referenceAssetId: null });
  console.log(`generate-assets: background living_room cached -> ${storagePath}`);
}

// Multi-word vocabulary entries (none in the seeded data today, but
// key_vocabulary is free text) get a slugified filename — asset_key
// stays the exact lowercased word so the (kind, asset_key) cache lookup
// matches what render-episode.ts looks up later.
function slugify(word: string): string {
  return word
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

interface TopicVocabRow {
  key_vocabulary: string[] | null;
}

async function ensureVocabularyAssets(): Promise<void> {
  const { data: topics, error } = await supabase.from("topics").select("key_vocabulary").returns<TopicVocabRow[]>();
  if (error) throw error;

  const allWords = new Set<string>();
  for (const topic of topics ?? []) {
    for (const word of topic.key_vocabulary ?? []) {
      const normalized = word.trim().toLowerCase();
      if (normalized) allWords.add(normalized);
    }
  }

  const { data: cached, error: cachedError } = await supabase
    .from("image_assets")
    .select("asset_key")
    .eq("kind", "vocabulary")
    .returns<{ asset_key: string }[]>();
  if (cachedError) throw cachedError;
  const cachedWords = new Set((cached ?? []).map((row) => row.asset_key));

  const pending = [...allWords].filter((word) => !cachedWords.has(word));
  console.log(
    `generate-assets: ${allWords.size} unique vocabulary word(s) across all topics, ${pending.length} need image(s)`
  );

  for (let i = 0; i < pending.length; i++) {
    const word = pending[i];
    try {
      console.log(`generate-assets: [${i + 1}/${pending.length}] generating vocabulary "${word}"...`);
      const prompt = vocabularyPrompt(word);
      const buffer = await generateImage(prompt);
      const storagePath = `assets/vocabulary/${slugify(word)}.png`;
      await uploadImage(storagePath, buffer);
      await cacheImage({ kind: "vocabulary", assetKey: word, storagePath, prompt, referenceAssetId: null });
      console.log(`generate-assets: [${i + 1}/${pending.length}] "${word}" cached -> ${storagePath}`);
    } catch (err) {
      // One bad word shouldn't stop the rest of a ~100+ item batch —
      // matches the rest of the pipeline's "one bad item doesn't kill the
      // batch" convention (render-episode.ts, generate-voiceover.ts).
      console.error(`generate-assets: failed to generate "${word}":`, err instanceof Error ? err.message : err);
    }
  }
}

export async function generateAssets(): Promise<void> {
  try {
    await ensureMascotAssets();
  } catch (err) {
    console.error("generate-assets: mascot phase failed:", err instanceof Error ? err.message : err);
  }

  try {
    await ensureBackgroundAsset();
  } catch (err) {
    console.error("generate-assets: background phase failed:", err instanceof Error ? err.message : err);
  }

  try {
    await ensureAllTopicSceneBackgrounds();
  } catch (err) {
    console.error("generate-assets: topic-scene background phase failed:", err instanceof Error ? err.message : err);
  }

  await ensureVocabularyAssets();

  console.log("generate-assets: done");
}

// `--topic-scene <slug>` generates just that one topic's scene background
// (skipping mascot/living-room/vocabulary phases entirely) — the cheap
// path for backfilling one missing topic, e.g. for live verification of a
// single episode, without paying for the full 48-topic sweep above.
async function runTopicSceneOnly(slug: string): Promise<void> {
  const { data: topic, error } = await supabase
    .from("topics")
    .select("id, slug, category, title, key_vocabulary")
    .eq("slug", slug)
    .single<TopicSceneRow>();
  if (error) throw error;
  await ensureTopicSceneBackground(topic);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const topicSceneFlagIndex = args.indexOf("--topic-scene");
  const run =
    topicSceneFlagIndex !== -1 && args[topicSceneFlagIndex + 1]
      ? runTopicSceneOnly(args[topicSceneFlagIndex + 1])
      : generateAssets();

  run
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
