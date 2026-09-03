// Resolves the two anchor phrases write-script.ts stores on a script
// (topic_scene_anchor, home_scene_anchor — short verbatim quotes marking
// where the render should cut to/from the topic scene) into real
// millisecond timestamps, by matching them against the actual spoken
// words in a voiceover's word-level Caption[] timing. Used by
// render-episode.ts before it builds the scene-sequenced background.
//
// Deliberately tolerant: an anchor is LLM output reproduced verbatim into
// a tool call, and TTS/caption tokenization can still drift from it
// slightly, so a miss here must never fail a render — it falls back to a
// fixed percentage of the episode's total duration and logs a warning.

import type { Caption } from "@remotion/captions";

export interface SceneTransitions {
  topicSceneMs: number;
  homeSceneMs: number;
}

// Same normalization VocabularyFlashcard.tsx uses for word matching:
// lowercase, strip everything but letters/digits, so punctuation and
// case differences between the anchor text and the spoken-word captions
// never break the match.
function normalizeToken(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

interface TimedWord {
  normalized: string;
  startMs: number;
}

// Sliding window: finds the first run of consecutive caption words whose
// normalized text exactly matches the anchor's normalized words, and
// returns that run's first word's startMs.
function findAnchorStartMs(words: TimedWord[], anchorWords: string[]): number | null {
  if (anchorWords.length === 0) return null;
  for (let i = 0; i <= words.length - anchorWords.length; i++) {
    let matched = true;
    for (let j = 0; j < anchorWords.length; j++) {
      if (words[i + j].normalized !== anchorWords[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return words[i].startMs;
  }
  return null;
}

function resolveOneAnchor(
  words: TimedWord[],
  anchor: string | null,
  fallbackMs: number,
  label: "topic_scene_anchor" | "home_scene_anchor"
): number {
  if (!anchor) return fallbackMs;

  const anchorWords = anchor
    .trim()
    .split(/\s+/)
    .map(normalizeToken)
    .filter(Boolean);
  const found = findAnchorStartMs(words, anchorWords);
  if (found !== null) return found;

  console.warn(`sceneAnchors: could not match ${label} "${anchor}" against captions — falling back to duration-percentage timing`);
  return fallbackMs;
}

export function resolveSceneTransitions(
  captions: Caption[],
  topicSceneAnchor: string | null,
  homeSceneAnchor: string | null,
  totalDurationMs: number
): SceneTransitions {
  const words: TimedWord[] = captions
    .map((c) => ({ normalized: normalizeToken(c.text), startMs: c.startMs }))
    .filter((w) => w.normalized.length > 0);

  const defaultTopicMs = totalDurationMs * 0.15;
  const defaultHomeMs = totalDurationMs * 0.85;

  const topicSceneMs = resolveOneAnchor(words, topicSceneAnchor, defaultTopicMs, "topic_scene_anchor");
  let homeSceneMs = resolveOneAnchor(words, homeSceneAnchor, defaultHomeMs, "home_scene_anchor");

  // Guard against a nonsensical ordering (both anchors matched to the
  // same spot, or the home anchor landing before the topic one) — keep
  // the three-act structure sane rather than rendering a zero/negative
  // length middle act.
  if (homeSceneMs <= topicSceneMs) {
    console.warn("sceneAnchors: home_scene transition is not after topic_scene transition — falling back to duration-percentage timing for home_scene");
    homeSceneMs = Math.max(topicSceneMs + 1000, defaultHomeMs);
  }

  return { topicSceneMs, homeSceneMs };
}
