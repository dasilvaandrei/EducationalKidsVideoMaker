// Must match the `topics.category` check constraint in
// supabase/migrations/20260901000000_init_schema.sql exactly — this is
// the join key between a topic's curriculum category and which background
// component an episode renders with.
export type TopicCategory =
  | "phonics_abcs"
  | "counting_numbers"
  | "colors_shapes"
  | "animals"
  | "science_how_things_work"
  | "emotions_manners";
