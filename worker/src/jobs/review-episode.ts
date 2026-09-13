// Automated stand-in for the human reviewer in the deployed dashboard
// (apps/dashboard/src/app/(protected)/review) — an independent LLM call,
// with vision, that watches a rendered episode the same way a person
// would (sampled frames + full script + the safety-check's already-passed
// reasoning) and stamps a review_decisions row itself. Because
// posts_require_approval only checks for *any* approved review_decisions
// row (see the trigger in supabase/migrations/20260901000000_init_schema.sql),
// an automated approval here satisfies the exact same publish gate a
// human click would — no trigger or publish-episode.ts change needed.
//
// Deliberately does NOT re-render the actual uploaded mp4 or shell out to
// ffmpeg to sample it: render.ts's renderEpisodeFrames() re-runs the same
// deterministic Remotion composition (same props, same frame index) that
// produced the real render, which is pixel-accurate to what got uploaded
// without downloading/decoding a video file.
//
// A 'rejected' verdict with a CONFIRMED issue (survived the propose/
// verify pipeline below) triggers a real fix loop, unlike a human
// rejection in the dashboard (see apps/dashboard's actions.ts, which
// still has no auto-regeneration): reviewRenderWithRetries inserts a
// fresh renders row for the same episode/script/voiceover, re-renders it
// via render-episode.ts's renderSingleRender, and reviews THAT — up to
// MAX_REVIEW_ATTEMPTS total attempts, mirroring safety-check.ts's
// regenerate-and-recheck loop. This is deliberately a re-RENDER, not a
// re-write of the script: every confirmed issue this reviewer can
// actually act on is a rendering-side problem (something about how the
// existing script+voiceover got turned into pixels), not a content
// problem — content already has its own independent gate and its own
// regeneration loop in safety-check.ts. If every attempt is still
// rejected, the last render is left rejected for a human to look at,
// same as today.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { Caption } from "@remotion/captions";
import { renderEpisodeFrames, type AspectRatio, type RenderProps } from "../remotion/render.js";
import { renderSingleRender } from "./render-episode.js";
import { resolveSceneTransitions } from "../lib/sceneAnchors.js";
import { supabase } from "../lib/supabase.js";

const MEDIA_BUCKET = "media";
const SIGNED_URL_TTL_SECONDS = 60 * 30;
// Deliberately Sonnet, not Opus, despite safety-check.ts's "don't
// cost-optimize the safety backstop down" precedent — that's about model
// *tier* for a pure-text judgment call, not about which model is actually
// better at THIS task. Head-to-head testing on a real render frame found
// claude-opus-5 confidently and repeatedly hallucinated a "rotated 90°,
// distorted" mascot on a frame that was completely normal — reproduced
// even with a fully blind, unleading description prompt, so it wasn't a
// prompting artifact. claude-sonnet-5 given the exact same image, same
// prompt, described it correctly in detail on the first try. Opus being
// the "smarter" model doesn't make it the more reliable vision model for
// this specific illustration style — cheaper here also happens to be
// more accurate.
const MODEL = "claude-sonnet-5";
// One frame per ~15-20s of a long-form episode would be excessive cost
// for little extra signal; a fixed 6 samples spread across the whole
// runtime (see render.ts's fraction spacing) catches intro/body/outro
// for both long-form and Shorts without scaling spend by duration.
const SAMPLE_FRAME_COUNT = 6;
// One initial render's review + up to two re-render-and-recheck cycles
// (3 render attempts total) before giving up and leaving it rejected for
// a human — same shape and same number as safety-check.ts's MAX_ATTEMPTS.
const MAX_REVIEW_ATTEMPTS = 3;

// frame_observations comes first in the schema on purpose: an object's
// fields are filled in order, so making the model write a neutral,
// factual description of every frame before it's allowed to reach
// issues_found/decision forces it to actually look before judging —
// the same reason a code reviewer writing findings before a verdict
// catches more real bugs than jumping straight to approve/reject. This
// alone doesn't eliminate hallucination (see reviewEpisodeFrames' second
// verification pass, which is the real backstop), but it measurably cuts
// down on confident-but-wrong claims compared to a bare decision+notes
// schema.
const SUBMIT_REVIEW_TOOL = {
  name: "submit_review_verdict",
  description:
    "Submit your analysis of a rendered children's video episode, replacing what a human reviewer would do in the review dashboard. Describe each frame factually first, then list only concrete, verifiable issues.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      frame_observations: {
        type: "array",
        description:
          "One neutral, factual description per sampled frame, in the order shown (Frame 1 first) — what's actually visible (mascot pose/position, background, any inset image, caption text). Required for every frame shown, including ones that look completely normal.",
        items: {
          type: "object",
          properties: {
            frame_number: { type: "integer", description: "1-based, matching the 'Frame N:' label the image was shown under." },
            description: { type: "string" },
          },
          required: ["frame_number", "description"],
          additionalProperties: false,
        },
      },
      issues_found: {
        type: "array",
        description:
          "Concrete, specific defects only — empty array if nothing looks wrong. Each one must be precise enough that someone looking at only that single frame, with no other context, could independently confirm or refute it. A second independent pass WILL re-check each one against that exact frame before anything is rejected, so include anything that looks even possibly wrong here rather than silently deciding not to mention it — but don't pad this with subjective or trivial items just to have something to list.",
        items: {
          type: "object",
          properties: {
            frame_number: { type: "integer" },
            issue: {
              type: "string",
              description: "Exactly what's wrong in this frame, described concretely enough to verify against the image alone.",
            },
          },
          required: ["frame_number", "issue"],
          additionalProperties: false,
        },
      },
      decision: {
        type: "string",
        enum: ["approved", "rejected"],
        description: "Your overall read — note this is advisory; the final decision is computed from which issues_found survive independent verification.",
      },
      notes: { type: "string", description: "A brief overall summary of your review." },
    },
    required: ["frame_observations", "issues_found", "decision", "notes"],
    additionalProperties: false,
  },
} as const;

const VERIFY_ISSUE_TOOL = {
  name: "submit_issue_verification",
  description: "Confirm or refute one specific claimed visual defect by examining the exact frame it was claimed about.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["confirmed", "false_positive"] },
      reasoning: { type: "string", description: "What you actually see in this frame, and whether it does or doesn't support the claim." },
    },
    required: ["verdict", "reasoning"],
    additionalProperties: false,
  },
} as const;

function buildSystemPrompt(): string {
  return `You are the final automated reviewer for "Paula the Penguin Learns," a children's educational YouTube channel for kids under 8. You stand in for the human who normally watches each finished episode in a review dashboard before it's allowed to publish — you are the last check, not a duplicate of the earlier text-only safety-check gate (which the script has already passed).

You're shown several frames sampled evenly across the actual rendered video, labeled Frame 1 through Frame N in chronological order, plus the full script, title, topic, and the safety-check gate's own verdict/reasoning for context.

First describe each frame factually (frame_observations) — what's actually on screen, not what you'd expect to be there. Only after that, decide what (if anything) is actually wrong (issues_found). Look carefully at each image before writing about it; do not describe a frame from assumption or pattern-matching against what a "normal" frame should look like.

IMPORTANT — the top-right inset box has THREE different correct appearances by design, keyed to whatever word is being spoken at that exact moment (read the caption text burned into the frame to tell which one applies):
1. A real photo — when the spoken word is a concrete vocabulary noun.
2. A FLAT, PLAIN SOLID-COLOR SQUARE with nothing else drawn inside it (no shape, no pattern, no photo) — this is the deliberate, correct rendering whenever the spoken word is a color name (red, blue, yellow, green, orange, purple, pink, black, white, brown, gray/grey). A plain colored square is NOT a broken or missing image in this case, even though a flat color with no content can look at a glance like a placeholder — it is working exactly as intended. Only flag it if the box's color doesn't match any color word actually in the caption text at that moment, or if it renders as an actual broken-image icon/transparent hole rather than a filled color.
3. A cluster of several small round mascot-icons — when the spoken word is a number (one through ten), roughly that many icons.
Before ever flagging this inset box as broken/placeholder/missing, check what word the caption text in that same frame is naming — if it's a color word and the box is simply that flat color, that is correct behavior, not a defect.

Check for:
1. Visual correctness: missing/broken images (per the inset rules above), cut-off or overlapping captions or text, the mascot or background looking genuinely broken (not just mid-animation — a running video interpolates between poses, so a frame caught between two keyframes can look slightly different from a resting pose without being a defect; only flag the mascot if something looks actually wrong, like a limb in an anatomically impossible position, duplicated/ghosted geometry, or missing parts).
2. Caption/text readability: legible, correctly cased, not garbled.
3. Content appropriateness as a final defense-in-depth pass — only flag something here if the actual rendered frames show a problem the text-only safety check could not have caught.
4. Overall polish: would a parent be comfortable letting their kid watch this, and does it look like a genuinely finished episode rather than a broken or partial render.

A false rejection is expensive: it wastes a full render cycle and creates work for a human to sort out. A missed truly minor issue is not: this channel publishes real episodes daily, and a working, on-brand episode is the expected common case, not the exception. So hold a high bar for what counts as an issue — but don't suppress a genuine concern just to avoid flagging it, since every issue you list gets independently re-verified against that exact frame before it can cause a rejection. Never invent or assume a defect; only report what the image actually shows.

Call submit_review_verdict exactly once.`;
}

interface PendingReviewRow {
  render_id: string;
  episode_id: string;
  aspect_ratio: AspectRatio;
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
  air_slot: string;
  key_vocabulary: string[] | null;
}

interface TopicJoin {
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

interface RenderJoinRow {
  id: string;
  episode_id: string;
  script_id: string;
  voiceover_id: string;
  aspect_ratio: AspectRatio;
  episodes: EpisodeJoin | EpisodeJoin[] | null;
  scripts: ScriptJoin | ScriptJoin[] | null;
  voiceovers: VoiceoverJoin | VoiceoverJoin[] | null;
}

function voiceoverOf(render: RenderJoinRow): VoiceoverJoin | null {
  return Array.isArray(render.voiceovers) ? render.voiceovers[0] ?? null : render.voiceovers;
}

function scriptOf(render: RenderJoinRow): ScriptJoin | null {
  return Array.isArray(render.scripts) ? render.scripts[0] ?? null : render.scripts;
}

function topicOf(render: RenderJoinRow): TopicJoin | null {
  const episode = Array.isArray(render.episodes) ? render.episodes[0] : render.episodes;
  const topic = Array.isArray(episode?.topics) ? episode?.topics[0] : episode?.topics;
  return topic ?? null;
}

async function resolveSignedUrl(storagePath: string): Promise<string> {
  const { data, error } = await supabase.storage.from(MEDIA_BUCKET).createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
  if (error) throw error;
  return data.signedUrl;
}

async function lookupFixedAssetPath(kind: "mascot" | "background", assetKey: string): Promise<string> {
  const { data, error } = await supabase
    .from("image_assets")
    .select("storage_path")
    .eq("kind", kind)
    .eq("asset_key", assetKey)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`image_assets has no (${kind}, ${assetKey}) row`);
  return data.storage_path;
}

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

// Rebuilds the exact RenderProps render-episode.ts used to produce the
// real render (same source images, same scene-transition timestamps), so
// the sampled frames below are faithful to what actually got uploaded —
// not a placeholder reconstruction.
async function buildRenderProps(render: RenderJoinRow): Promise<RenderProps> {
  const voiceover = voiceoverOf(render);
  const script = scriptOf(render);
  const topic = topicOf(render);
  if (!voiceover?.storage_path) throw new Error(`render ${render.id}: no voiceover storage_path`);
  if (!topic) throw new Error(`render ${render.id}: episode has no joined topic`);

  const words = [...new Set((script?.key_vocabulary ?? []).map((w) => w.trim().toLowerCase()).filter(Boolean))];

  const [
    audioSrc,
    vocabularyImages,
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
    resolveSignedUrl(voiceover.storage_path),
    resolveVocabularyImages(words),
    lookupFixedAssetPath("mascot", "idle").then(resolveSignedUrl),
    lookupFixedAssetPath("mascot", "blink").then(resolveSignedUrl),
    lookupFixedAssetPath("mascot", "mouth_open").then(resolveSignedUrl),
    lookupFixedAssetPath("mascot", "wave").then(resolveSignedUrl),
    lookupFixedAssetPath("mascot", "clap").then(resolveSignedUrl),
    lookupFixedAssetPath("mascot", "point").then(resolveSignedUrl),
    lookupFixedAssetPath("mascot", "think").then(resolveSignedUrl),
    lookupFixedAssetPath("background", "living_room").then(resolveSignedUrl),
    lookupFixedAssetPath("background", topic.slug).then(resolveSignedUrl),
  ]);

  const totalDurationMs = (voiceover.duration_seconds ?? 0) * 1000;
  const { topicSceneMs, homeSceneMs } = resolveSceneTransitions(
    voiceover.captions,
    script?.topic_scene_anchor ?? null,
    script?.home_scene_anchor ?? null,
    totalDurationMs
  );

  return {
    audioSrc,
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
    heroWord: words[0] ?? "",
    topicCategory: topic.category,
  };
}

function pngToImageBlock(buffer: Buffer): Anthropic.Messages.ImageBlockParam {
  return {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: buffer.toString("base64") },
  };
}

interface AnthropicClientLike {
  messages: {
    create: (params: any) => Promise<any>;
  };
}

export interface ReviewVerdict {
  decision: "approved" | "rejected";
  notes: string;
  model: string;
}

interface ProposedIssue {
  frame_number: number;
  issue: string;
}

interface IssueVerification {
  verdict: "confirmed" | "false_positive";
  reasoning: string;
}

// First half of verifyIssue: describe the frame in detail with NO
// mention of the claim being checked. This is the step that actually
// matters for cutting hallucination — testing on a real render showed
// that telling the verifier the claim upfront ("eyes stacked vertically,
// oversized white belly...") reliably made it "find" that exact
// description even when the frame was genuinely fine, because vivid,
// specific wording in the prompt primes a vision model to go looking for
// matching evidence (a leading-question effect) — it reproduced the
// identical false claim on a same-image, fresh-context re-ask, which
// ruled out simple sampling noise/anchoring as the explanation. Deciding
// from an independently-generated description instead — written before
// the claim is ever revealed — removes that channel entirely.
async function describeFrameBlind(frameBuffer: Buffer, client: AnthropicClientLike): Promise<string> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system:
      "You are looking at a single frame from a children's animated video. Describe, in plain factual detail, EVERY element visible, covering all of the following for each one before moving on — do not stop early or summarize:\n" +
      "1. Each character: pose and position, anatomy (heads, eyes, limbs — are they attached where you'd expect, none missing, none duplicated).\n" +
      "2. Any inset, overlay, or panel box anywhere in the frame (e.g. a small square/rounded-corner box in a corner): state exactly what is shown inside it — a specific photo (describe its subject), a single flat solid color with nothing else drawn inside it (name the color), a cluster of small icons, or a genuinely empty/transparent/broken-image-icon area. Report the literal pixel content neutrally; do not characterize it as 'a placeholder' or 'broken' yourself — that judgment happens in a later step.\n" +
      "3. Any on-screen text or captions: what they say and whether they render cleanly.\n" +
      "4. The background/setting.\n" +
      "Describe only what the pixels actually show, as precisely and literally as you can — not what a normal, working frame would be expected to look like. Be thorough and complete; do not truncate your answer before covering every element listed above.",
    messages: [
      { role: "user", content: [pngToImageBlock(frameBuffer), { type: "text", text: "Describe this frame in full detail, covering every point above." }] },
    ],
  });
  const textBlock = response.content.find((block: any) => block.type === "text");
  return textBlock?.text ?? "";
}

// Second half: judge the claim purely against that blind description —
// a text-only comparison, so there's no image left for a leading claim
// to bias a second look at.
async function verifyIssue(frameBuffer: Buffer, claimedIssue: string, client: AnthropicClientLike): Promise<IssueVerification> {
  const blindDescription = await describeFrameBlind(frameBuffer, client);

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system:
      "You are fact-checking a specific claimed visual defect using an independent, blind description of the frame — written by someone who was never told what to look for, so it can't be biased toward finding the claimed problem. Decide confirmed only if that blind description clearly, concretely describes the same problem the claim describes. If the blind description doesn't mention it, contradicts it, or only vaguely overlaps, it's a false_positive — the blind description is the ground truth here, not the claim.\n\n" +
      "One specific known false-positive pattern to watch for: this show's top-right inset box is, by design, sometimes rendered as a single flat solid color with nothing else drawn inside it — that's the correct appearance whenever the episode is naming a color (red, blue, gray, etc.), not a broken or missing image. If the blind description just describes a plain colored square and the claim calls that 'broken/missing/placeholder,' that is a false_positive, not a confirmed defect — only confirm an inset-box claim if the description indicates an actual broken-image icon, transparent hole, or a color that doesn't match anything being taught.",
    messages: [
      {
        role: "user",
        content: `Independent blind description of the frame:\n${blindDescription}\n\nClaimed issue: "${claimedIssue}"\n\nDoes the blind description actually support this specific claim?`,
      },
    ],
    tools: [VERIFY_ISSUE_TOOL],
    tool_choice: { type: "tool", name: "submit_issue_verification" },
  });

  const toolUse = response.content.find((block: any) => block.type === "tool_use");
  if (!toolUse) throw new Error("Claude did not return a submit_issue_verification tool call");
  return toolUse.input as IssueVerification;
}

// Two-stage propose-then-verify review, to cut down on vision-model
// hallucination without just trusting a single pass's confident-sounding
// claims: stage 1 (submit_review_verdict) is deliberately asked to
// describe every frame factually before judging, and to flag anything
// even possibly wrong rather than self-censor (high recall). Stage 2
// (verifyIssue) then independently re-checks each claimed issue against
// only its exact frame (high precision) — the final decision is REJECTED
// only if at least one issue survives that independent re-check, no
// matter what stage 1's own "decision" field said. This mirrors the
// propose/verify split used for code-review findings elsewhere in this
// toolchain, applied to visual QC instead of code.
export async function reviewEpisodeFrames(
  frames: Buffer[],
  context: {
    scriptBody: string;
    titleSuggestion: string | null;
    topicTitle: string;
    category: string;
    format: string;
    durationSeconds: number | null;
    safetyReasoning: string;
  },
  options: { anthropicClient?: AnthropicClientLike } = {}
): Promise<ReviewVerdict> {
  const client: AnthropicClientLike = options.anthropicClient ?? new Anthropic();

  const textContext = [
    `Format: ${context.format}`,
    `Topic: ${context.topicTitle} (${context.category})`,
    `Title suggestion: ${context.titleSuggestion ?? "(none)"}`,
    `Duration: ${context.durationSeconds ? `${Math.round(context.durationSeconds)}s` : "unknown"}`,
    `Safety-check gate already passed with reasoning: ${context.safetyReasoning}`,
    "",
    "Full script:",
    context.scriptBody,
  ].join("\n");

  const frameContent: any[] = [
    { type: "text", text: "Frames sampled evenly across the rendered episode, shown in chronological order, each explicitly labeled:" },
  ];
  frames.forEach((buffer, i) => {
    frameContent.push({ type: "text", text: `Frame ${i + 1}:` });
    frameContent.push(pngToImageBlock(buffer));
  });
  frameContent.push({ type: "text", text: textContext });

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: buildSystemPrompt(),
    messages: [{ role: "user", content: frameContent }],
    tools: [SUBMIT_REVIEW_TOOL],
    tool_choice: { type: "tool", name: "submit_review_verdict" },
  });

  const toolUse = response.content.find((block: any) => block.type === "tool_use");
  if (!toolUse) throw new Error("Claude did not return a submit_review_verdict tool call");

  const input = toolUse.input as {
    frame_observations: { frame_number: number; description: string }[];
    issues_found: ProposedIssue[];
    decision: "approved" | "rejected";
    notes: string;
  };

  if (input.issues_found.length === 0) {
    // No concrete, verifiable issue was raised — approve regardless of
    // the model's own decision field. A reject with nothing structured
    // to back it up is exactly the vague, unverifiable kind of claim
    // this whole design exists to filter out.
    return { decision: "approved", notes: input.notes, model: MODEL };
  }

  const verifications = await Promise.all(
    input.issues_found.map((issue) => {
      const frame = frames[issue.frame_number - 1];
      if (!frame) {
        // Stage 1 referenced a frame number outside the range actually
        // shown — treat as unverifiable rather than trusting it blind.
        return Promise.resolve<IssueVerification>({
          verdict: "false_positive",
          reasoning: `Claimed frame_number ${issue.frame_number} is out of range for the ${frames.length} frames shown.`,
        });
      }
      return verifyIssue(frame, issue.issue, client);
    })
  );

  const confirmed = input.issues_found.filter((_, i) => verifications[i].verdict === "confirmed");
  const dismissed = input.issues_found
    .map((issue, i) => ({ issue, verification: verifications[i] }))
    .filter(({ verification }) => verification.verdict === "false_positive");

  if (confirmed.length === 0) {
    const dismissedSummary = dismissed
      .map(({ issue, verification }) => `Frame ${issue.frame_number} ("${issue.issue}") — false positive on re-check: ${verification.reasoning}`)
      .join(" ");
    return {
      decision: "approved",
      notes: `Initial pass flagged ${dismissed.length} potential issue(s), but independent re-verification found none held up. ${dismissedSummary}`,
      model: MODEL,
    };
  }

  const confirmedSummary = confirmed.map((issue) => `Frame ${issue.frame_number}: ${issue.issue}`).join(" | ");
  return {
    decision: "rejected",
    notes: `Confirmed on independent re-check: ${confirmedSummary}`,
    model: MODEL,
  };
}

export interface ReviewResult {
  renderId: string;
  decision: "approved" | "rejected";
  attempts: number;
}

const RENDER_JOIN_SELECT =
  "id, episode_id, script_id, voiceover_id, aspect_ratio, episodes(topics(slug, category)), scripts(title_suggestion, key_vocabulary, topic_scene_anchor, home_scene_anchor), voiceovers(storage_path, duration_seconds, captions)";

async function fetchRenderJoin(renderId: string): Promise<RenderJoinRow> {
  const { data, error } = await supabase.from("renders").select(RENDER_JOIN_SELECT).eq("id", renderId).single<RenderJoinRow>();
  if (error) throw error;
  return data;
}

async function reviewOneRender(
  renderId: string,
  aspectRatio: AspectRatio,
  context: {
    scriptBody: string;
    titleSuggestion: string | null;
    topicTitle: string;
    category: string;
    format: string;
    durationSeconds: number | null;
    safetyReasoning: string;
  }
): Promise<ReviewVerdict> {
  const renderJoin = await fetchRenderJoin(renderId);
  const dir = await mkdtemp(join(tmpdir(), "review-"));
  try {
    const props = await buildRenderProps(renderJoin);
    const captures = await renderEpisodeFrames(aspectRatio, props, dir, SAMPLE_FRAME_COUNT);
    const frameBuffers = await Promise.all(captures.map((c) => readFile(c.path)));
    return await reviewEpisodeFrames(frameBuffers, context);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Reviews `renderId`; on a confirmed rejection, re-renders the same
// episode from its existing script+voiceover into a brand new renders
// row (no unique constraint on episode_id/aspect_ratio blocks this — see
// the schema) and reviews that instead, up to MAX_REVIEW_ATTEMPTS times.
// Every attempt gets its own review_decisions row (mirrors safety_checks
// recording every attempt in safety-check.ts, flagged ones included) —
// so the audit trail shows the full retry history, not just the final
// outcome. The old rejected render row is left as-is (its own
// review_decisions row permanently excludes it from pending_reviews via
// that view's NOT EXISTS clause) rather than deleted, same "mark and
// move on" pattern scripts.status='superseded' uses.
async function reviewRenderWithRetries(
  initialRenderId: string,
  episodeId: string,
  scriptId: string,
  voiceoverId: string,
  aspectRatio: AspectRatio,
  context: {
    scriptBody: string;
    titleSuggestion: string | null;
    topicTitle: string;
    category: string;
    format: string;
    durationSeconds: number | null;
    safetyReasoning: string;
  }
): Promise<ReviewResult> {
  let currentRenderId = initialRenderId;

  for (let attempt = 1; attempt <= MAX_REVIEW_ATTEMPTS; attempt++) {
    const verdict = await reviewOneRender(currentRenderId, aspectRatio, context);

    const { error: insertError } = await supabase.from("review_decisions").insert({
      render_id: currentRenderId,
      reviewer_id: null,
      decision: verdict.decision,
      notes: verdict.notes,
      automated: true,
      model: verdict.model,
    });
    if (insertError) throw insertError;

    console.log(`review-episode: ${currentRenderId} (attempt ${attempt}/${MAX_REVIEW_ATTEMPTS}) -> ${verdict.decision} (${verdict.notes})`);

    if (verdict.decision === "approved") {
      return { renderId: currentRenderId, decision: "approved", attempts: attempt };
    }

    if (attempt === MAX_REVIEW_ATTEMPTS) {
      console.error(
        `review-episode: episode ${episodeId} exhausted ${MAX_REVIEW_ATTEMPTS} attempts — leaving render ${currentRenderId} rejected for manual review. Last issue: ${verdict.notes}`
      );
      return { renderId: currentRenderId, decision: "rejected", attempts: attempt };
    }

    // Re-render and try again — every issue this reviewer can confirm is
    // by definition a rendering-side problem (see this file's header
    // comment), so a fresh render of the same script+voiceover is the
    // right first thing to try before giving up to a human.
    const { data: newRender, error: insertRenderError } = await supabase
      .from("renders")
      .insert({ episode_id: episodeId, script_id: scriptId, voiceover_id: voiceoverId, aspect_ratio: aspectRatio, render_status: "queued" })
      .select("id")
      .single();
    if (insertRenderError) throw insertRenderError;

    const rendered = await renderSingleRender(newRender.id);
    if (!rendered) {
      console.error(`review-episode: retry render ${newRender.id} for episode ${episodeId} itself failed — stopping retry loop`);
      return { renderId: currentRenderId, decision: "rejected", attempts: attempt };
    }

    currentRenderId = newRender.id;
  }

  // Unreachable — the loop above always returns by MAX_REVIEW_ATTEMPTS.
  throw new Error(`review-episode: episode ${episodeId} retry loop exited without a result — unreachable`);
}

export async function reviewPendingEpisodes(): Promise<ReviewResult[]> {
  const { data: pending, error: pendingError } = await supabase
    .from("pending_reviews")
    .select(
      "render_id, episode_id, aspect_ratio, storage_path, duration_seconds, script_id, script_body, title_suggestion, category, topic_title, safety_reasoning, safety_categories_flagged, format, air_slot, key_vocabulary"
    )
    .returns<PendingReviewRow[]>();
  if (pendingError) throw pendingError;

  console.log(`review-episode: ${pending?.length ?? 0} render(s) pending review`);
  if (!pending || pending.length === 0) return [];

  const renderIds = pending.map((p) => p.render_id);
  const { data: renderJoins, error: renderJoinError } = await supabase
    .from("renders")
    .select(RENDER_JOIN_SELECT)
    .in("id", renderIds)
    .returns<RenderJoinRow[]>();
  if (renderJoinError) throw renderJoinError;

  const renderJoinById = new Map((renderJoins ?? []).map((r) => [r.id, r]));
  const results: ReviewResult[] = [];

  for (const row of pending) {
    const renderJoin = renderJoinById.get(row.render_id);
    if (!renderJoin) {
      console.warn(`review-episode: skip ${row.render_id} — no matching renders join row`);
      continue;
    }

    try {
      const result = await reviewRenderWithRetries(row.render_id, row.episode_id, renderJoin.script_id, renderJoin.voiceover_id, row.aspect_ratio, {
        scriptBody: row.script_body,
        titleSuggestion: row.title_suggestion,
        topicTitle: row.topic_title,
        category: row.category,
        format: row.format,
        durationSeconds: row.duration_seconds,
        safetyReasoning: row.safety_reasoning,
      });
      results.push(result);
    } catch (err) {
      // One bad review shouldn't block the rest of the queue — it just
      // stays in pending_reviews for the next run (or a human).
      console.error(`review-episode: ${row.render_id} failed:`, err instanceof Error ? err.message : err);
    }
  }

  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  reviewPendingEpisodes()
    .then((results) => {
      const rejected = results.filter((r) => r.decision === "rejected").length;
      console.log(`review-episode: done — ${results.length - rejected} approved, ${rejected} rejected`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
