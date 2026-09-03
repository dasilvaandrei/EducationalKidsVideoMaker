// Curriculum rotation: picks the least-recently-used category, then the
// least-recently-used topic within that category, and inserts a new
// `episodes` row for it. "Least-recently-used" treats a topic/category
// that has never been used (last_used_at is null) as older than any real
// timestamp, so the rotation always drains brand-new topics before
// repeating anything.
//
// Usage:
//   npm run pick-topic -- --format long_form --air-slot tuesday_long_form
//   npm run pick-topic -- --format short --air-slot nightly_short [--target-date 2026-09-08]

import { supabase } from "../lib/supabase.js";

const FORMATS = ["long_form", "short"] as const;
const AIR_SLOTS = ["tuesday_long_form", "friday_long_form", "nightly_short"] as const;

type Format = (typeof FORMATS)[number];
type AirSlot = (typeof AIR_SLOTS)[number];

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

// null sorts before every real timestamp — "never used" beats "used long
// ago" beats "used recently".
function lastUsedRank(lastUsedAt: string | null): number {
  return lastUsedAt ? new Date(lastUsedAt).getTime() : -Infinity;
}

export async function pickTopic(options: PickTopicOptions): Promise<{ episodeId: string; topicId: string }> {
  const { data: topics, error } = await supabase
    .from("topics")
    .select("id, category, title, slug, last_used_at, use_count")
    .returns<TopicRow[]>();
  if (error) throw error;
  if (!topics || topics.length === 0) {
    throw new Error("no rows in topics — seed the curriculum bank before running pick-topic");
  }

  const byCategory = new Map<string, TopicRow[]>();
  for (const topic of topics) {
    const list = byCategory.get(topic.category) ?? [];
    list.push(topic);
    byCategory.set(topic.category, list);
  }

  // Least-recently-used category = the category whose most-recently-used
  // topic is the oldest (i.e. this category as a whole hasn't been
  // touched in the longest time).
  let bestCategory: string | null = null;
  let bestCategoryRank = Infinity;
  for (const [category, categoryTopics] of byCategory) {
    const mostRecentRank = Math.max(...categoryTopics.map((t) => lastUsedRank(t.last_used_at)));
    if (mostRecentRank < bestCategoryRank) {
      bestCategoryRank = mostRecentRank;
      bestCategory = category;
    }
  }
  if (!bestCategory) throw new Error("failed to select a category — unreachable");

  const candidates = byCategory.get(bestCategory)!;
  const topic = candidates.reduce((oldest, current) =>
    lastUsedRank(current.last_used_at) < lastUsedRank(oldest.last_used_at) ? current : oldest
  );

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
