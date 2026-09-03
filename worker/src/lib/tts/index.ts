import type { TtsProvider } from "./types.js";
import { elevenLabsProvider } from "./elevenlabs.js";

export type { TtsProvider, TtsSynthesizeOptions, TtsSynthesizeResult } from "./types.js";

// Reads TTS_PROVIDER so a second provider can be swapped in later without
// touching generate-voiceover.ts — only ElevenLabs is implemented today.
export function getTtsProvider(): TtsProvider {
  const provider = process.env.TTS_PROVIDER ?? "elevenlabs";
  switch (provider) {
    case "elevenlabs":
      return elevenLabsProvider;
    default:
      throw new Error(`Unknown TTS_PROVIDER: ${JSON.stringify(provider)} (only "elevenlabs" is implemented)`);
  }
}
