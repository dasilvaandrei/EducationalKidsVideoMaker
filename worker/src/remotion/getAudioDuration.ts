// mediabunny audio-duration helper, per the ecc:remotion-video-creation
// skill's get-audio-duration rule — used by Root.tsx's calculateMetadata
// to size durationInFrames from the real voiceover audio rather than the
// scripts table's estimated_duration_seconds (that's a pre-TTS estimate
// from word count; the real render must match the actual synthesized
// audio, which can drift from the estimate by a second or more).

import { Input, ALL_FORMATS, UrlSource } from "mediabunny";

export async function getAudioDuration(src: string): Promise<number> {
  const input = new Input({
    formats: ALL_FORMATS,
    source: new UrlSource(src, { getRetryDelay: () => null }),
  });
  return input.computeDuration();
}
