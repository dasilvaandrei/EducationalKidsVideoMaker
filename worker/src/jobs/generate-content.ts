// Tops up a standing content buffer so the publish-*.yml workflows always
// have already-approved content to post — publish-episode.ts only pulls
// approved renders, so same-day generation would leave nothing eligible
// (a silent no-op). Runs early each day (see
// .github/workflows/generate-content.yml), well ahead of the evening
// publish crons, to give a human reviewer time in between.
//
// Buffer-check approach (deliberately simple, per the plan): count
// episodes per air_slot that are still "in flight" — any status other
// than the terminal published/rejected/failed — and top up to a fixed
// target per slot by running the pick-topic -> write-script ->
// safety-check pipeline once per episode still needed. generate-voiceover
// and render-episode then each run once at the end over everything now
// eligible, since those two jobs already operate in bulk across all
// pending scripts/renders rather than per-episode.

import { pickTopic } from "./pick-topic.js";
import { writeScript } from "./write-script.js";
import { runSafetyCheck } from "./safety-check.js";
import { generateVoiceovers } from "./generate-voiceover.js";
import { renderQueuedEpisodes } from "./render-episode.js";
import { supabase } from "../lib/supabase.js";

type AirSlot = "tuesday_long_form" | "friday_long_form" | "nightly_short";
type Format = "long_form" | "short";

const FORMAT_BY_AIR_SLOT: Record<AirSlot, Format> = {
  tuesday_long_form: "long_form",
  friday_long_form: "long_form",
  nightly_short: "short",
};

// The plan describes the target loosely ("always keep 2 long-form + 3
// Shorts sitting in pending_reviews") without saying whether the
// long-form count is per-slot or combined across tuesday/friday. Applied
// per-slot here — the simplest interpretation, and it keeps both
// long-form air slots independently stocked rather than letting one
// starve the other.
const BUFFER_TARGET_BY_AIR_SLOT: Record<AirSlot, number> = {
  tuesday_long_form: 2,
  friday_long_form: 2,
  nightly_short: 3,
};

const TERMINAL_STATUSES = new Set(["published", "rejected", "failed"]);

interface EpisodeStatusRow {
  air_slot: AirSlot;
  status: string;
}

export async function topUpContentBuffer(): Promise<void> {
  const { data: episodes, error } = await supabase
    .from("episodes")
    .select("air_slot, status")
    .returns<EpisodeStatusRow[]>();
  if (error) throw error;

  const inFlightCountByAirSlot = new Map<AirSlot, number>();
  for (const episode of episodes ?? []) {
    if (TERMINAL_STATUSES.has(episode.status)) continue;
    inFlightCountByAirSlot.set(episode.air_slot, (inFlightCountByAirSlot.get(episode.air_slot) ?? 0) + 1);
  }

  const newEpisodeIds: string[] = [];

  for (const airSlot of Object.keys(BUFFER_TARGET_BY_AIR_SLOT) as AirSlot[]) {
    const target = BUFFER_TARGET_BY_AIR_SLOT[airSlot];
    const current = inFlightCountByAirSlot.get(airSlot) ?? 0;
    const deficit = Math.max(0, target - current);

    if (deficit === 0) {
      console.log(`generate-content: ${airSlot} at target (${current}/${target})`);
      continue;
    }

    console.log(`generate-content: ${airSlot} needs ${deficit} more episode(s) (${current}/${target})`);
    for (let i = 0; i < deficit; i++) {
      const { episodeId } = await pickTopic({ format: FORMAT_BY_AIR_SLOT[airSlot], airSlot });
      await writeScript(episodeId);
      await runSafetyCheck(episodeId);
      newEpisodeIds.push(episodeId);
    }
  }

  if (newEpisodeIds.length === 0) {
    console.log("generate-content: buffer already full across all air slots — nothing to voice/render");
    return;
  }

  await generateVoiceovers();
  await renderQueuedEpisodes();

  console.log(`generate-content: topped up ${newEpisodeIds.length} episode(s)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  topUpContentBuffer()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
