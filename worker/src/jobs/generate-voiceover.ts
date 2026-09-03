// Synthesizes voiceover audio for every script that's ready_for_voice and
// doesn't already have a ready voiceover — one script can end up with more
// than one voiceovers row across retries (a 'failed' row is left in place
// rather than deleted, for debugging), so "doesn't have a ready one yet"
// is the actual eligibility check, not "has none at all".
//
// This job also queues the render: nothing upstream creates a `renders`
// row (the schema's render_status state machine has to start somewhere,
// and generate-voiceover is the first point where episode_id, script_id,
// and a ready voiceover_id are all known together), so once a voiceover
// is ready this inserts the corresponding renders row (aspect_ratio
// derived from the episode's format — long_form -> 16:9, short -> 9:16)
// with render_status='queued' and advances episodes.status to
// 'rendering', matching the schema's planned -> scripting -> voicing ->
// rendering -> ready progression.

import { getTtsProvider } from "../lib/tts/index.js";
import { supabase } from "../lib/supabase.js";

const MEDIA_BUCKET = "media";
const TTS_PROVIDER_NAME = process.env.TTS_PROVIDER ?? "elevenlabs";

type Format = "long_form" | "short";

const ASPECT_RATIO_BY_FORMAT: Record<Format, "16:9" | "9:16"> = {
  long_form: "16:9",
  short: "9:16",
};

interface ReadyScript {
  id: string;
  episode_id: string;
  version: number;
  body: string;
  episodes: { format: Format } | { format: Format }[] | null;
}

function formatOf(script: ReadyScript): Format {
  const episode = Array.isArray(script.episodes) ? script.episodes[0] : script.episodes;
  if (!episode) throw new Error(`script ${script.id} has no joined episode`);
  return episode.format;
}

interface ExistingVoiceover {
  script_id: string;
  status: string;
}

export async function generateVoiceovers(): Promise<void> {
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  if (!voiceId) throw new Error("ELEVENLABS_VOICE_ID must be set");

  const { data: scripts, error: scriptsError } = await supabase
    .from("scripts")
    .select("id, episode_id, version, body, episodes(format)")
    .eq("status", "ready_for_voice")
    .returns<ReadyScript[]>();
  if (scriptsError) throw scriptsError;
  if (!scripts || scripts.length === 0) {
    console.log("no ready_for_voice scripts");
    return;
  }

  const { data: voiceovers, error: voiceoversError } = await supabase
    .from("voiceovers")
    .select("script_id, status")
    .in(
      "script_id",
      scripts.map((s) => s.id)
    )
    .returns<ExistingVoiceover[]>();
  if (voiceoversError) throw voiceoversError;

  const readyScriptIds = new Set((voiceovers ?? []).filter((v) => v.status === "ready").map((v) => v.script_id));
  const pending = scripts.filter((s) => !readyScriptIds.has(s.id));

  console.log(`${pending.length} script(s) need a voiceover`);

  const provider = getTtsProvider();

  for (const script of pending) {
    try {
      // "[PAUSE FOR RESPONSE]" is a stage direction for the scriptwriter
      // (marks the call-and-response beat), not something to actually
      // speak or caption — the sentence's own punctuation already creates
      // a natural pause there. Strip it before TTS so it can't end up
      // spoken aloud or rendered as literal on-screen caption text (caught
      // live: it was showing up as a caption line).
      const ttsText = script.body.replace(/\[PAUSE FOR RESPONSE\]/g, "").replace(/[ \t]+/g, " ").trim();
      const { audioBuffer, durationSeconds, captions } = await provider.synthesize(ttsText, { voiceId });

      const objectPath = `voiceovers/${script.episode_id}-v${script.version}.mp3`;
      const { error: uploadError } = await supabase.storage
        .from(MEDIA_BUCKET)
        .upload(objectPath, audioBuffer, { contentType: "audio/mpeg", upsert: true });
      if (uploadError) throw uploadError;

      const { data: voiceover, error: insertError } = await supabase
        .from("voiceovers")
        .insert({
          script_id: script.id,
          provider: TTS_PROVIDER_NAME,
          voice_id: voiceId,
          storage_path: objectPath,
          duration_seconds: durationSeconds,
          captions,
          status: "ready",
        })
        .select("id")
        .single();
      if (insertError) throw insertError;

      const { error: renderInsertError } = await supabase.from("renders").insert({
        episode_id: script.episode_id,
        script_id: script.id,
        voiceover_id: voiceover.id,
        aspect_ratio: ASPECT_RATIO_BY_FORMAT[formatOf(script)],
        render_status: "queued",
      });
      if (renderInsertError) throw renderInsertError;

      const { error: episodeStatusError } = await supabase
        .from("episodes")
        .update({ status: "rendering" })
        .eq("id", script.episode_id);
      if (episodeStatusError) throw episodeStatusError;

      console.log(`voiceover ready for script ${script.id} (episode ${script.episode_id}) -> ${objectPath}, render queued`);
    } catch (err) {
      // One bad synthesis/upload shouldn't take down the rest of the
      // batch — mirrors render-clips.ts / render-episode.ts.
      console.error(`voiceover generation failed for script ${script.id}:`, err instanceof Error ? err.message : err);
      await supabase.from("voiceovers").insert({
        script_id: script.id,
        provider: TTS_PROVIDER_NAME,
        voice_id: voiceId,
        status: "failed",
      });
    }
  }
}

function parseArgs(_argv: string[]): void {
  // No arguments today — always processes every eligible script. Kept as
  // a named function (mirroring the other jobs' CLI shape) so a future
  // --episode-id filter has an obvious place to land.
}

if (import.meta.url === `file://${process.argv[1]}`) {
  parseArgs(process.argv.slice(2));
  generateVoiceovers()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
