// Splash the Penguin — a fixed set of Gemini-generated pose images
// (idle/blink/mouth_open plus four gesture poses: wave/clap/point/think,
// generated once and cached forever by jobs/generate-assets.ts, never
// per-episode) animated by frame-swapping <Img src>, plus code-driven
// bounce/scale. Replaces the old hand-coded SVG mascot: that component
// morphed SVG paths per frame, this one swaps between pre-rendered images
// using the exact same caption-word-boundary timing it used for its mouth
// viseme.
//
// Gestures: when a caption word matches a trigger (e.g. "wave"), the
// mascot swaps to that gesture's pose for a short window instead of
// staying in the idle/blink/talk cycle — the point of this file's
// existence per the product ask ("if it's going to say it's waving, it
// has to actually wave").

import React, { useMemo } from "react";
import { Img, useCurrentFrame, useVideoConfig } from "remotion";
import type { Caption } from "@remotion/captions";

export type GestureKind = "wave" | "clap" | "point" | "think";

export type MascotProps = {
  idleSrc: string;
  blinkSrc: string;
  mouthOpenSrc: string;
  waveSrc: string;
  clapSrc: string;
  pointSrc: string;
  thinkSrc: string;
  captions: Caption[];
};

// How often the mascot blinks, and how long the blink itself takes —
// same cadence as the old SVG version.
const BLINK_CYCLE_SECONDS = 3.2;
const BLINK_DURATION_FRAMES = 6;

// How long a triggered gesture stays displayed — long enough to read as a
// deliberate action, short enough not to freeze the normal cycle for long.
const GESTURE_WINDOW_MS = 2000;

// Cue words/phrases -> the gesture they trigger, matched against each
// caption word's own text (same per-word Caption[] timing
// VocabularyFlashcard.tsx keys off of) rather than the full sentence, so
// the gesture starts exactly when the word is actually spoken.
const GESTURE_TRIGGERS: Record<string, GestureKind> = {
  wave: "wave",
  waving: "wave",
  waves: "wave",
  clap: "clap",
  clapping: "clap",
  claps: "clap",
  point: "point",
  pointing: "point",
  look: "point",
  see: "point",
  think: "think",
  thinking: "think",
  wonder: "think",
  wondering: "think",
  hmm: "think",
};

function normalizeWord(word: string): string {
  return word.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSpeakingAt(captions: Caption[], timeMs: number): boolean {
  return captions.some((c) => timeMs >= c.startMs && timeMs <= c.endMs);
}

export const Mascot: React.FC<MascotProps> = ({
  idleSrc,
  blinkSrc,
  mouthOpenSrc,
  waveSrc,
  clapSrc,
  pointSrc,
  thinkSrc,
  captions,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Idle bounce: a gentle continuous up/down sway. All animation here MUST
  // be driven by useCurrentFrame() (CSS animations don't render correctly
  // in Remotion) — see the ecc:remotion-video-creation skill's animations
  // rule.
  const bounceCycleFrames = fps * 2;
  const bouncePhase = (frame % bounceCycleFrames) / bounceCycleFrames;
  const bounceY = Math.sin(bouncePhase * Math.PI * 2) * 10;

  // Blink: swap to the blink frame for a short recurring window,
  // independent of speech.
  const blinkCycleFrames = Math.max(1, Math.round(fps * BLINK_CYCLE_SECONDS));
  const isBlinking = frame % blinkCycleFrames < BLINK_DURATION_FRAMES;

  // Mouth: swap to the mouth_open frame while a caption word is active at
  // the current playback time, same word-boundary timing the old SVG
  // viseme used, just driving an image swap instead of a path morph.
  const currentTimeMs = (frame / fps) * 1000;
  const speaking = isSpeakingAt(captions, currentTimeMs);

  // Every caption word that matches a gesture trigger, in caption order
  // (captions are already time-ordered) — recomputed only when the
  // captions array changes, not every frame.
  const gestureEvents = useMemo(() => {
    const events: { gesture: GestureKind; startMs: number }[] = [];
    for (const c of captions) {
      const gesture = GESTURE_TRIGGERS[normalizeWord(c.text)];
      if (gesture) events.push({ gesture, startMs: c.startMs });
    }
    return events;
  }, [captions]);

  // The gesture whose trigger word most recently occurred at or before
  // now, as long as we're still inside its display window — walking
  // events in time order and letting each later one overwrite the running
  // answer naturally picks "most recent," and falling back to null once
  // its window has elapsed (rather than sticking forever) keeps a stray
  // early mention from pinning the pose for the rest of the video.
  let activeGesture: GestureKind | null = null;
  for (const event of gestureEvents) {
    if (event.startMs > currentTimeMs) break;
    activeGesture = currentTimeMs - event.startMs < GESTURE_WINDOW_MS ? event.gesture : null;
  }

  const gestureSrc: Record<GestureKind, string> = { wave: waveSrc, clap: clapSrc, point: pointSrc, think: thinkSrc };

  // A gesture in progress wins over everything else — it's a deliberate,
  // rare event, so letting mouth_open or a blink interrupt it mid-window
  // would flicker the pose right when it should read clearly. Absent a
  // gesture, fall back to the existing blink-over-mouth_open-over-idle
  // priority (a blink is brief and rare relative to a spoken word window,
  // so it wins over mouth_open on the odd frame both would apply, rather
  // than adding a fourth blink+mouth-open combo image).
  const src = activeGesture ? gestureSrc[activeGesture] : isBlinking ? blinkSrc : speaking ? mouthOpenSrc : idleSrc;

  return (
    <Img
      src={src}
      style={{
        width: "100%",
        height: "100%",
        objectFit: "contain",
        transform: `translateY(${bounceY}px)`,
      }}
    />
  );
};
