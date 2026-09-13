// Must match the `topics.category` check constraint in
// supabase/migrations/20260901000000_init_schema.sql as amended by
// 20260913000000_retire_shapes_add_plants.sql exactly — this is the join
// key between a topic's curriculum category and which background
// component an episode renders with. 'colors_shapes' was split into
// 'colors' (shapes content retired) and a new 'plants' category added.
export type TopicCategory =
  | "phonics_abcs"
  | "counting_numbers"
  | "colors"
  | "animals"
  | "plants"
  | "science_how_things_work"
  | "emotions_manners";
