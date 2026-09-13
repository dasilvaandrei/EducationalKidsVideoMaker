// Curriculum rotation: picks a topic via weighted-LRU across every
// non-retired topic (single stage, not category-then-topic) and inserts a
// new `episodes` row for it. "Least-recently-used" treats a topic that has
// never been used (last_used_at is null) as older than anything else,
// full stop, regardless of weight — brand-new topics always go first.
// Otherwise, a topic's pick priority is how long it's been since it was
// last used, scaled by its category's weight (CATEGORY_WEIGHTS below): a
// weight-2 category becomes "due again" in half the elapsed time a
// weight-1 category needs, so it gets picked roughly twice as often over
// the long run — this is how animals/plants/counting_numbers get emphasis
// per the product ask, without needing more raw topics in those
// categories. Retired topics (see the `retired` column, added when shapes
// content was cut) are excluded from the query entirely.
//
// Usage:
//   npm run pick-topic -- --format long_form --air-slot tuesday_long_form
//   npm run pick-topic -- --format short --air-slot nightly_short [--target-date 2026-09-08]

import { supabase } from "../lib/supabase.js";

const FORMATS = ["long_form", "short"] as const;
const AIR_SLOTS = ["tuesday_long_form", "friday_long_form", "nightly_short"] as const;

type Format = (typeof FORMATS)[number];
type AirSlot = (typeof AIR_SLOTS)[number];

// Categories the product wants emphasized get picked roughly this many
// times more often than a weight-1 category; anything not listed defaults
// to 1 (see priorityOf below).
const CATEGORY_WEIGHTS: Record<string, number> = {
  animals: 2,
  plants: 2,
  counting_numbers: 2,
};
const DEFAULT_CATEGORY_WEIGHT = 1;

interface TopicRow {
  id: string;
  category: string;
  title: string;
  slug: string;
  last_used_at: string | null;
  use_count: number;
}

export interface PickTopicOptions {
  format: Format;
  airSlot: AirSlot;
  targetPublishDate?: string;
}

// Never-used always wins outright, regardless of category weight — a
// brand-new topic should always be introduced before anything repeats.
// Otherwise, priority is elapsed time since last use scaled by the
// topic's category weight, so a higher-weight category reaches the same
// priority sooner (see CATEGORY_WEIGHTS above) and gets picked more often.
function priorityOf(topic: TopicRow): number {
  if (!topic.last_used_at) return Infinity;
  const elapsedMs = Date.now() - new Date(topic.last_used_at).getTime();
  return elapsedMs * (CATEGORY_WEIGHTS[topic.category] ?? DEFAULT_CATEGORY_WEIGHT);
}

export async function pickTopic(options: PickTopicOptions): Promise<{ episodeId: string; topicId: string }> {
  const { data: topics, error } = await supabase
    .from("topics")
    .select("id, category, title, slug, last_used_at, use_count")
    .eq("retired", false)
    .returns<TopicRow[]>();
  if (error) throw error;
  if (!topics || topics.length === 0) {
    throw new Error("no rows in topics — seed the curriculum bank before running pick-topic");
  }

  const topic = topics.reduce((best, current) => (priorityOf(current) > priorityOf(best) ? current : best));

  const { data: episode, error: insertError } = await supabase
    .from("episodes")
    .insert({
      topic_id: topic.id,
      format: options.format,
      air_slot: options.airSlot,
      target_publish_date: options.targetPublishDate ?? null,
      status: "planned",
    })
    .select("id")
    .single();
  if (insertError) throw insertError;

  const { error: touchError } = await supabase
    .from("topics")
    .update({ last_used_at: new Date().toISOString(), use_count: topic.use_count + 1 })
    .eq("id", topic.id);
  if (touchError) throw touchError;

  console.log(
    `picked topic "${topic.title}" (${topic.category}) -> episode ${episode.id} [format=${options.format}, air_slot=${options.airSlot}]`
  );

  return { episodeId: episode.id as string, topicId: topic.id };
}

function parseArgs(argv: string[]): PickTopicOptions {
  let format: Format | undefined;
  let airSlot: AirSlot | undefined;
  let targetPublishDate: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--format") {
      const value = argv[++i];
      if (!FORMATS.includes(value as Format)) {
        throw new Error(`--format must be one of ${FORMATS.join(", ")}, got ${JSON.stringify(value)}`);
      }
      format = value as Format;
    } else if (arg === "--air-slot") {
      const value = argv[++i];
      if (!AIR_SLOTS.includes(value as AirSlot)) {
        throw new Error(`--air-slot must be one of ${AIR_SLOTS.join(", ")}, got ${JSON.stringify(value)}`);
      }
      airSlot = value as AirSlot;
    } else if (arg === "--target-date") {
      targetPublishDate = argv[++i];
    }
  }

  if (!format || !airSlot) {
    throw new Error("usage: pick-topic --format <long_form|short> --air-slot <tuesday_long_form|friday_long_form|nightly_short> [--target-date YYYY-MM-DD]");
  }

  return { format, airSlot, targetPublishDate };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  pickTopic(parseArgs(process.argv.slice(2)))
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
