// Pops a visual into the upper-right corner keyed to whatever's actually
// being spoken right now, using the same word-level Caption[] timing
// Mascot.tsx and Captions.tsx already key off of. Three content types,
// checked in this priority order per word:
//   1. Number words ("one".."ten") -> that many small mascot icons, so a
//      quantity is shown by *counting objects* (e.g. "5 pips") rather than
//      an abstract photo of the digit — real photos of "five" don't mean
//      anything to a pre-reader, but five of something does.
//   2. Color-name words ("red", "blue", ...) -> a solid swatch of that
//      exact color, so the video shows the color itself rather than a
//      photo of some red *object* (which was the previous, less direct
//      behavior).
//   3. Otherwise, a real-life photo, but ONLY for words in this episode's
//      own script vocabulary (render-episode.ts no longer falls back to
//      the topic's pre-seeded vocabulary list — see its comment).
// Formerly VocabularyFlashcard.tsx (images only); renamed since it now
// covers three content kinds under one shared "hold until the next
// genuinely different concept" transition system.

import React, { useMemo } from "react";
import { AbsoluteFill, Img, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import type { Caption } from "@remotion/captions";

export type TopicDisplayProps = {
  captions: Caption[];
  // Lowercased vocabulary word -> signed image URL. Only contains words
  // that actually have a cached image AND actually appear in this
  // episode's own script (render-episode.ts already filtered both).
  imagesByWord: Record<string, string>;
  // Used as the repeated "counter" icon for number words — reusing the
  // mascot's own idle pose costs no extra image generation and doubles as
  // a nice bit of brand consistency ("5 pips").
  mascotIconSrc: string;
};

const POP_IN_FRAMES = 8;
const CARD_SIZE = 260;
const CARD_STYLE_BASE: React.CSSProperties = {
  borderRadius: 24,
  border: "8px solid white",
  boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
};

// Common named colors a kids' color/rainbow script would actually say —
// matches the seeded curriculum's Primary Colors / Rainbow Colors /
// Mixing Colors topics.
const COLOR_WORDS: Record<string, string> = {
  red: "#E4483C",
  blue: "#4FB6E8",
  yellow: "#FFD966",
  green: "#6FCB6F",
  orange: "#F5A742",
  purple: "#9B7FD4",
  pink: "#F5A9C7",
  black: "#2B2B2B",
  white: "#FFFFFF",
  brown: "#A0714F",
  gray: "#9AA0A6",
  grey: "#9AA0A6",
};

// Abstract/meta words about the teaching activity itself, never a
// meaningful photo subject — excluded even if image_assets happens to
// have a cached (and inevitably nonsensical) image for one of them, e.g.
// "count" once resolved to an arbitrary photo of a ladybug. The script
// prompt is also told not to use these as key_vocabulary, but this is the
// backstop that holds regardless of what a script or the cache contains.
const EXCLUDED_WORDS = new Set(["count", "counting", "counted", "number", "numbers"]);

// Curriculum caps counting topics at ten ("Counting to 10"), so that's as
// high as this needs to go.
const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

type DisplayContent =
  | { kind: "image"; key: string; src: string }
  | { kind: "color"; key: string; hex: string }
  | { kind: "count"; key: string; n: number };

function normalize(word: string): string {
  return word.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Checks whether caption index `i` starts a number word, a color word, or
// a script-vocabulary entry (single word, or — for a two-word entry like
// "thank you" — that word plus the one before it). Priority matters: a
// script that says "five red balls" should show the count, not the color,
// since the quantity is the more central teaching point of a counting
// topic touching on color only in passing.
function matchContent(captions: Caption[], index: number, imagesByWord: Record<string, string>): DisplayContent | null {
  const word = normalize(captions[index].text);
  if (!word || EXCLUDED_WORDS.has(word)) return null;

  const count = NUMBER_WORDS[word];
  if (count !== undefined) return { kind: "count", key: `count:${count}`, n: count };

  const hex = COLOR_WORDS[word];
  if (hex) return { kind: "color", key: `color:${word}`, hex };

  if (index > 0) {
    const pair = `${normalize(captions[index - 1].text)} ${word}`;
    if (imagesByWord[pair]) return { kind: "image", key: `image:${pair}`, src: imagesByWord[pair] };
  }
  if (imagesByWord[word]) return { kind: "image", key: `image:${word}`, src: imagesByWord[word] };

  return null;
}

export const TopicDisplay: React.FC<TopicDisplayProps> = ({ captions, imagesByWord, mascotIconSrc }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const currentTimeMs = (frame / fps) * 1000;

  // Collapse the caption stream down to just the moments the on-screen
  // content actually *changes* (by content key, not raw word) — repeat
  // mentions of the same word/number/color produce no extra entries,
  // which is what keeps the display from flashing in/out on every
  // mention. Once something's up, it stays up until a genuinely
  // different concept is spoken later in the episode.
  const transitions = useMemo(() => {
    const result: { content: DisplayContent; startMs: number }[] = [];
    let lastKey: string | null = null;
    for (let i = 0; i < captions.length; i++) {
      const content = matchContent(captions, i, imagesByWord);
      if (!content || content.key === lastKey) continue;
      result.push({ content, startMs: captions[i].startMs });
      lastKey = content.key;
    }
    return result;
  }, [captions, imagesByWord]);

  let active: { content: DisplayContent; startMs: number } | null = null;
  for (const transition of transitions) {
    if (transition.startMs > currentTimeMs) break;
    active = transition;
  }

  if (!active) return null;

  const startFrame = Math.round((active.startMs / 1000) * fps);
  const framesIntoDisplay = frame - startFrame;
  const scale = interpolate(framesIntoDisplay, [0, POP_IN_FRAMES], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ justifyContent: "flex-start", alignItems: "flex-end", padding: 48 }}>
      <div style={{ transform: `scale(${scale})`, transformOrigin: "top right" }}>
        {active.content.kind === "image" && (
          <div style={{ ...CARD_STYLE_BASE, width: CARD_SIZE, height: CARD_SIZE, overflow: "hidden" }}>
            <Img src={active.content.src} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          </div>
        )}
        {active.content.kind === "color" && (
          <div style={{ ...CARD_STYLE_BASE, width: CARD_SIZE, height: CARD_SIZE, background: active.content.hex }} />
        )}
        {active.content.kind === "count" && (
          <div
            style={{
              ...CARD_STYLE_BASE,
              maxWidth: CARD_SIZE * 1.5,
              padding: 20,
              background: "rgba(255,255,255,0.92)",
              display: "flex",
              flexWrap: "wrap",
              gap: 10,
              justifyContent: "center",
              alignContent: "center",
            }}
          >
            {Array.from({ length: active.content.n }, (_, i) => (
              <Img key={i} src={mascotIconSrc} style={{ width: 56, height: 56, objectFit: "contain" }} />
            ))}
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
};
