// ElevenLabs TTS provider. Called directly over fetch against the REST
// API rather than pulling in ElevenLabs' own SDK — this project only ever
// makes one kind of call (timestamped synthesis), so a full SDK dependency
// isn't worth it for that.
//
// GOTCHA, worth documenting clearly because it isn't obvious from
// ElevenLabs' API docs: the `/with-timestamps` endpoint returns
// CHARACTER-level alignment (one start/end time per character), but
// @remotion/captions' `Caption` type (and createTikTokStyleCaptions,
// which the Captions.tsx composition uses) expects WORD-level captions.
// aggregateCharacterTimestampsToWords() below does that conversion: split
// the source text on whitespace, and for each resulting word take the
// start time of its first character and the end time of its last
// character. Skipping this step and feeding raw character alignment into
// @remotion/captions produces "words" that are single characters.

import type { Caption } from "@remotion/captions";
import type { TtsProvider, TtsSynthesizeOptions, TtsSynthesizeResult } from "./types.js";

const API_BASE = "https://api.elevenlabs.io/v1";

interface ElevenLabsAlignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

interface ElevenLabsWithTimestampsResponse {
  audio_base64: string;
  alignment: ElevenLabsAlignment | null;
  normalized_alignment: ElevenLabsAlignment | null;
}

export function aggregateCharacterTimestampsToWords(alignment: ElevenLabsAlignment): Caption[] {
  const { characters, character_start_times_seconds: startTimes, character_end_times_seconds: endTimes } = alignment;
  const captions: Caption[] = [];

  let wordChars: string[] = [];
  let wordStartIndex: number | null = null;

  const flushWord = (lastCharIndex: number) => {
    if (wordChars.length === 0 || wordStartIndex === null) return;
    const text = wordChars.join("");
    const startMs = startTimes[wordStartIndex] * 1000;
    const endMs = endTimes[lastCharIndex] * 1000;
    captions.push({
      text,
      startMs,
      endMs,
      timestampMs: (startMs + endMs) / 2,
      confidence: null,
    });
    wordChars = [];
    wordStartIndex = null;
  };

  for (let i = 0; i < characters.length; i++) {
    const char = characters[i];
    if (/\s/.test(char)) {
      flushWord(i - 1);
      continue;
    }
    if (wordStartIndex === null) wordStartIndex = i;
    wordChars.push(char);
  }
  // The text doesn't end in whitespace, so the final word needs an
  // explicit flush after the loop.
  flushWord(characters.length - 1);

  // @remotion/captions' createTikTokStyleCaptions() only starts a new page
  // when it sees a token whose `text` starts with a literal space — that's
  // its ONLY word-boundary signal (combineTokensWithinMilliseconds just
  // bounds how long a page can span once that check has fired). Without a
  // leading space on every word, the whole transcript collapses into one
  // page. Match the Whisper-style convention @remotion/captions expects:
  // every word gets a leading space except the very first.
  for (let i = 1; i < captions.length; i++) {
    captions[i] = { ...captions[i], text: ` ${captions[i].text}` };
  }

  return captions;
}

async function synthesize(text: string, options: TtsSynthesizeOptions): Promise<TtsSynthesizeResult> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY must be set");

  const res = await fetch(`${API_BASE}/text-to-speech/${options.voiceId}/with-timestamps`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2",
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ElevenLabs TTS failed: ${res.status} ${body}`);
  }

  const body = (await res.json()) as ElevenLabsWithTimestampsResponse;
  if (!body.alignment) {
    // Kept as a fallback path only in the type, not implemented here — a
    // Whisper re-transcription fallback would introduce audio/script
    // drift risk (see plan), so for now a missing alignment is a hard
    // failure rather than a silent degrade.
    throw new Error("ElevenLabs response is missing character alignment — cannot build word-level captions");
  }

  const audioBuffer = Buffer.from(body.audio_base64, "base64");
  const captions = aggregateCharacterTimestampsToWords(body.alignment);
  const lastEnd = body.alignment.character_end_times_seconds.at(-1);
  const durationSeconds = lastEnd ?? 0;

  return { audioBuffer, durationSeconds, captions };
}

export const elevenLabsProvider: TtsProvider = { synthesize };
