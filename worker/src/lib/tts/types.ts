import type { Caption } from "@remotion/captions";

export interface TtsSynthesizeOptions {
  voiceId: string;
}

export interface TtsSynthesizeResult {
  audioBuffer: Buffer;
  durationSeconds: number;
  // Word-level captions, already aggregated from whatever granularity the
  // underlying provider returns — @remotion/captions' Caption type is the
  // contract every provider implementation must produce.
  captions: Caption[];
}

// Provider-agnostic TTS interface so a second provider (or a Whisper
// re-transcription fallback) can be swapped in via getTtsProvider()
// without touching generate-voiceover.ts.
export interface TtsProvider {
  synthesize(text: string, options: TtsSynthesizeOptions): Promise<TtsSynthesizeResult>;
}
