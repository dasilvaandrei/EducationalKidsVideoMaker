// Three-act background sequencer — living room, then a topic-specific
// scene, then living room again — replacing the old always-on
// LivingRoomBackground.tsx now that the product ask is "always start in
// the living room, move to something related to the topic, then end back
// in the living room." Each of the three segments keeps the same
// code-driven Ken Burns pan/zoom LivingRoomBackground used (scoped to its
// own on-screen span rather than the whole video, so each scene's zoom
// starts fresh from START_SCALE the moment it becomes visible), with a
// short crossfade between segments so the cuts aren't jarring.
//
// The two transition timestamps are resolved upstream (see
// lib/sceneAnchors.ts + render-episode.ts) from the script's anchor text
// against the real voiceover captions, with a graceful duration-percentage
// fallback baked in there — this component just trusts whatever ms values
// it's given.

import React from "react";
import { AbsoluteFill, Img, interpolate, useCurrentFrame, useVideoConfig } from "remotion";

export type SceneBackgroundProps = {
  livingRoomSrc: string;
  topicSceneSrc: string;
  topicSceneStartMs: number;
  homeSceneStartMs: number;
};

const START_SCALE = 1.0;
const END_SCALE = 1.08;
// Small, so the pan never pushes the open middle/lower zone (reserved
// for the mascot/captions, see the background's generation prompt) out
// of frame.
const END_TRANSLATE_X_PERCENT = -2;
const END_TRANSLATE_Y_PERCENT = -1.5;

const CROSSFADE_FRAMES = 18;

function kenBurnsTransform(progress: number): string {
  const scale = START_SCALE + (END_SCALE - START_SCALE) * progress;
  const translateX = END_TRANSLATE_X_PERCENT * progress;
  const translateY = END_TRANSLATE_Y_PERCENT * progress;
  return `scale(${scale}) translate(${translateX}%, ${translateY}%)`;
}

// Ken Burns progress across just this segment's own on-screen span, not
// the whole video — so a scene's zoom always starts at START_SCALE the
// moment it fades in, rather than jumping in partway through a
// video-wide zoom.
function segmentProgress(frame: number, start: number, end: number): number {
  return interpolate(frame, [start, Math.max(start + 1, end)], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}

function fadeIn(frame: number, at: number): number {
  return interpolate(frame, [at, at + CROSSFADE_FRAMES], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
}

function fadeOut(frame: number, at: number): number {
  return interpolate(frame, [at, at + CROSSFADE_FRAMES], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
}

export const SceneBackground: React.FC<SceneBackgroundProps> = ({
  livingRoomSrc,
  topicSceneSrc,
  topicSceneStartMs,
  homeSceneStartMs,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const topicStartFrame = Math.round((topicSceneStartMs / 1000) * fps);
  const homeStartFrame = Math.round((homeSceneStartMs / 1000) * fps);

  // Each layer is mounted for the whole video and driven purely by
  // opacity — simpler than mounting/unmounting via <Sequence> and avoids
  // any pop at the crossfade boundary from a layer re-mounting mid-fade.
  const openingOpacity = fadeOut(frame, topicStartFrame);
  const topicOpacity = Math.min(fadeIn(frame, topicStartFrame), fadeOut(frame, homeStartFrame));
  const closingOpacity = fadeIn(frame, homeStartFrame);

  const openingProgress = segmentProgress(frame, 0, topicStartFrame);
  const topicProgress = segmentProgress(frame, topicStartFrame, homeStartFrame);
  const closingProgress = segmentProgress(frame, homeStartFrame, durationInFrames);

  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <AbsoluteFill style={{ opacity: openingOpacity }}>
        <Img
          src={livingRoomSrc}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            transform: kenBurnsTransform(openingProgress),
            transformOrigin: "center center",
          }}
        />
      </AbsoluteFill>
      <AbsoluteFill style={{ opacity: topicOpacity }}>
        <Img
          src={topicSceneSrc}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            transform: kenBurnsTransform(topicProgress),
            transformOrigin: "center center",
          }}
        />
      </AbsoluteFill>
      <AbsoluteFill style={{ opacity: closingOpacity }}>
        <Img
          src={livingRoomSrc}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            transform: kenBurnsTransform(closingProgress),
            transformOrigin: "center center",
          }}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
