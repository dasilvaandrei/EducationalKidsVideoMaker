-- Adds a place to record a custom-generated thumbnail image for a render,
-- consumed by publish-episode.ts's YouTube branch (calls
-- lib/youtube.ts's uploadYoutubeThumbnail once a render has one) and by
-- the new jobs/set-thumbnail.ts, which is how a thumbnail actually gets
-- attached (image generation itself happens out-of-band — see
-- set-thumbnail.ts's header comment for why).
alter table renders add column thumbnail_path text;
