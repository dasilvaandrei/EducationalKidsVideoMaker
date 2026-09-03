// The one composition every episode renders through, in both aspect
// ratios (see Root.tsx): the three-act scene background, the mascot, the
// topic-display pop-ins (photo/color-swatch/counted-items — see
// TopicDisplay.tsx), the voiceover audio, and word-synced captions on top.

import React from "react";
import { AbsoluteFill } from "remotion";
import { Audio } from "@remotion/media";
import type { Caption } from "@remotion/captions";
import { Mascot } from "./Mascot.js";
import { Captions } from "./Captions.js";
import { SceneBackground } from "./SceneBackground.js";
import { TopicDisplay } from "./TopicDisplay.js";

export type EpisodeCompositionProps = {
  // Must be real http(s) URLs — Remotion's server-side renderer only
  // fetches over HTTP(S), same constraint as audioSrc below.
  // render-episode.ts resolves every one of these from Storage
  // (image_assets/voiceovers) into signed URLs before calling into this
  // composition.
  audioSrc: string;
  captions: Caption[];
  mascotIdleSrc: string;
  mascotBlinkSrc: string;
  mascotMouthOpenSrc: string;
  mascotWaveSrc: string;
  mascotClapSrc: string;
  mascotPointSrc: string;
  mascotThinkSrc: string;
  // The always-cached, topic-agnostic home base (image_assets
  // kind='background', asset_key='living_room').
  livingRoomSrc: string;
  // This episode's topic-specific scene (image_assets kind='background',
  // asset_key=<topic slug>) — generated once per topic, reused forever.
  topicSceneSrc: string;
  // Resolved by render-episode.ts (see lib/sceneAnchors.ts) from the
  // script's topic_scene_anchor/home_scene_anchor against the real
  // voiceover captions, ms from the start of narration (frame 0).
  topicSceneStartMs: number;
  homeSceneStartMs: number;
  // Lowercased vocabulary word -> signed image URL, scoped to just this
  // episode's script/topic vocabulary (see render-episode.ts) — not the
  // full cross-topic image_assets table.
  vocabularyImages: Record<string, string>;
};

export const EpisodeComposition: React.FC<EpisodeCompositionProps> = ({
  audioSrc,
  captions,
  mascotIdleSrc,
  mascotBlinkSrc,
  mascotMouthOpenSrc,
  mascotWaveSrc,
  mascotClapSrc,
  mascotPointSrc,
  mascotThinkSrc,
  livingRoomSrc,
  topicSceneSrc,
  topicSceneStartMs,
  homeSceneStartMs,
  vocabularyImages,
}) => {
  return (
    <AbsoluteFill>
      <SceneBackground
        livingRoomSrc={livingRoomSrc}
        topicSceneSrc={topicSceneSrc}
        topicSceneStartMs={topicSceneStartMs}
        homeSceneStartMs={homeSceneStartMs}
      />
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
        <div style={{ width: "55%", maxWidth: 520 }}>
          <Mascot
            idleSrc={mascotIdleSrc}
            blinkSrc={mascotBlinkSrc}
            mouthOpenSrc={mascotMouthOpenSrc}
            waveSrc={mascotWaveSrc}
            clapSrc={mascotClapSrc}
            pointSrc={mascotPointSrc}
            thinkSrc={mascotThinkSrc}
            captions={captions}
          />
        </div>
      </AbsoluteFill>
      <TopicDisplay captions={captions} imagesByWord={vocabularyImages} mascotIconSrc={mascotIdleSrc} />
      <Captions captions={captions} />
      <Audio src={audioSrc} />
    </AbsoluteFill>
  );
};
