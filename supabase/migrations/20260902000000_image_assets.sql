-- Cached image assets for the visual layer: mascot pose frames, the
-- living-room background, and per-vocabulary-word photos. All generated
-- once via worker/src/jobs/generate-assets.ts (Gemini image generation)
-- and reused across every episode/topic forever — this table is a cache
-- keyed by (kind, asset_key), never a per-episode/per-render record.

create table image_assets (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('mascot', 'background', 'vocabulary')),
  -- e.g. 'idle'/'blink'/'mouth_open' for mascot, 'living_room' for
  -- background, the lowercased (and slugified, for multi-word entries)
  -- vocabulary word for vocabulary.
  asset_key text not null,
  storage_path text not null,
  -- The prompt used to generate this image, kept for auditability and so
  -- a future regeneration can reuse/tweak it rather than reverse-engineer
  -- one from the image.
  prompt text not null,
  -- Which asset (if any) was passed back to Gemini as a reference image
  -- for visual consistency — e.g. 'blink' and 'mouth_open' both reference
  -- 'idle'. Null for the first generation in a set.
  reference_asset_id uuid references image_assets(id),
  model text not null,
  created_at timestamptz not null default now(),
  unique (kind, asset_key)
);

create index image_assets_kind_idx on image_assets(kind);
