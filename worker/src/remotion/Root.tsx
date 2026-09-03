// Registers the two aspect-ratio compositions every episode renders
// through — 16:9 for long-form Tuesday/Friday episodes, 9:16 for the
// nightly Short. Both share EpisodeComposition; only width/height differ.
// Duration comes from calculateMetadata + mediabunny's real audio-length
// probe (see getAudioDuration.ts), not a stored estimate — mirrors the
// sibling project's dynamic-duration pattern in its own Root.tsx.

import type { CalculateMetadataFunction } from "remotion";
import { Composition, Folder } from "remotion";
import { EpisodeComposition, type EpisodeCompositionProps } from "./EpisodeComposition.js";
import { getAudioDuration } from "./getAudioDuration.js";
import { FPS, TRAILING_HOLD_FRAMES } from "./timing.js";

type Props = EpisodeCompositionProps;

const calculateMetadata: CalculateMetadataFunction<Props> = async ({ props }) => {
  const durationInSeconds = await getAudioDuration(props.audioSrc);
  return {
    durationInFrames: Math.max(1, Math.round(durationInSeconds * FPS)) + TRAILING_HOLD_FRAMES,
  };
};

const defaultProps: Props = {
  audioSrc: "",
  captions: [],
  mascotIdleSrc: "",
  mascotBlinkSrc: "",
  mascotMouthOpenSrc: "",
  mascotWaveSrc: "",
  mascotClapSrc: "",
  mascotPointSrc: "",
  mascotThinkSrc: "",
  livingRoomSrc: "",
  topicSceneSrc: "",
  topicSceneStartMs: 0,
  homeSceneStartMs: 0,
  vocabularyImages: {},
};

export const RemotionRoot: React.FC = () => {
  return (
    <Folder name="Episode">
      <Composition
        id="Episode-16x9"
        component={EpisodeComposition}
        fps={FPS}
        width={1920}
        height={1080}
        durationInFrames={FPS * 60}
        defaultProps={defaultProps}
        calculateMetadata={calculateMetadata}
      />
      <Composition
        id="Episode-9x16"
        component={EpisodeComposition}
        fps={FPS}
        width={1080}
        height={1920}
        durationInFrames={FPS * 60}
        defaultProps={defaultProps}
        calculateMetadata={calculateMetadata}
      />
    </Folder>
  );
};
