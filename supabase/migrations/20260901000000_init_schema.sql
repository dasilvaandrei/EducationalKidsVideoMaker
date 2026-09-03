-- KidsVideoMaker core schema.
-- Original-content generation pipeline for a children's educational YouTube
-- channel: curriculum rotation, versioned scripts, an automated
-- content-safety gate (separate from human review), provider-agnostic TTS,
-- renders, human review, and publishing. See the sibling videoMaker
-- project's init_schema.sql for the pattern this is adapted from — that
-- project licenses/clips existing footage, this one generates 100%
-- original content, so the sourcing tables differ but the review/publish
-- shape is intentionally kept close.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Curriculum / topic rotation
-- ---------------------------------------------------------------------------

create table topics (
  id uuid primary key default gen_random_uuid(),
  category text not null check (category in
    ('phonics_abcs', 'counting_numbers', 'colors_shapes', 'animals',
     'science_how_things_work', 'emotions_manners')),
  title text not null,
  slug text not null unique,
  key_vocabulary text[] not null default '{}',
  target_age_min int not null default 3,
  target_age_max int not null default 7,
  last_used_at timestamptz,
  use_count int not null default 0,
  created_at timestamptz not null default now()
);

create index topics_category_idx on topics(category);
create index topics_last_used_at_idx on topics(last_used_at nulls first);

-- ---------------------------------------------------------------------------
-- Episodes (the scheduling unit — one per air slot)
-- ---------------------------------------------------------------------------

create table episodes (
  id uuid primary key default gen_random_uuid(),
  topic_id uuid not null references topics(id) on delete restrict,
  format text not null check (format in ('long_form', 'short')),
  air_slot text not null check (air_slot in
    ('tuesday_long_form', 'friday_long_form', 'nightly_short')),
  target_publish_date date,
  status text not null default 'planned' check (status in
    ('planned', 'scripting', 'safety_flagged', 'voicing', 'rendering',
     'ready', 'approved', 'rejected', 'published', 'failed')),
  created_at timestamptz not null default now()
);

create index episodes_status_idx on episodes(status);
create index episodes_air_slot_idx on episodes(air_slot);
create index episodes_topic_id_idx on episodes(topic_id);

-- ---------------------------------------------------------------------------
-- Scripts (versioned per episode — a rejection produces a new version,
-- never an in-place edit, since a script edit changes words already baked
-- into TTS audio + burned-in captions once a render exists)
-- ---------------------------------------------------------------------------

create table scripts (
  id uuid primary key default gen_random_uuid(),
  episode_id uuid not null references episodes(id) on delete cascade,
  version int not null default 1,
  title_suggestion text,
  body text not null,
  key_vocabulary text[] not null default '{}',
  call_and_response_moments text[] not null default '{}',
  word_count int,
  estimated_duration_seconds numeric(8,2),
  model text,
  prompt_version text,
  status text not null default 'draft' check (status in
    ('draft', 'ready_for_voice', 'superseded')),
  created_at timestamptz not null default now(),
  unique (episode_id, version)
);

create index scripts_episode_id_idx on scripts(episode_id);
create index scripts_status_idx on scripts(status);

-- ---------------------------------------------------------------------------
-- Automated content-safety verdict — a separate gate from human review.
-- A 'flag' verdict must keep a script out of the review queue entirely
-- (enforced in the pending_reviews view, not here).
-- ---------------------------------------------------------------------------

create table safety_checks (
  id uuid primary key default gen_random_uuid(),
  script_id uuid not null references scripts(id) on delete cascade,
  verdict text not null check (verdict in ('pass', 'flag')),
  categories_flagged text[] not null default '{}',
  reasoning text not null,
  model text,
  created_at timestamptz not null default now()
);

create index safety_checks_script_id_idx on safety_checks(script_id);

-- ---------------------------------------------------------------------------
-- Voiceovers (TTS output — provider-agnostic, see worker/src/lib/tts/)
-- ---------------------------------------------------------------------------

create table voiceovers (
  id uuid primary key default gen_random_uuid(),
  script_id uuid not null references scripts(id) on delete cascade,
  provider text not null,
  voice_id text not null,
  storage_path text,
  duration_seconds numeric(8,2),
  -- word-level @remotion/captions Caption[] JSON, precomputed here so the
  -- render job never has to re-derive audio/text alignment.
  captions jsonb not null default '[]'::jsonb,
  status text not null default 'queued' check (status in
    ('queued', 'generating', 'ready', 'failed')),
  created_at timestamptz not null default now()
);

create index voiceovers_script_id_idx on voiceovers(script_id);

-- ---------------------------------------------------------------------------
-- Renders (mirrors the sibling's clip_renders state machine)
-- ---------------------------------------------------------------------------

create table renders (
  id uuid primary key default gen_random_uuid(),
  episode_id uuid not null references episodes(id) on delete cascade,
  script_id uuid not null references scripts(id) on delete restrict,
  voiceover_id uuid not null references voiceovers(id) on delete restrict,
  aspect_ratio text not null check (aspect_ratio in ('16:9', '9:16')),
  storage_path text,
  duration_seconds numeric(8,2),
  render_status text not null default 'queued' check (render_status in
    ('queued', 'rendering', 'ready', 'failed')),
  created_at timestamptz not null default now()
);

create index renders_episode_id_idx on renders(episode_id);
create index renders_render_status_idx on renders(render_status);

-- ---------------------------------------------------------------------------
-- Human review. Narrower than the sibling's review_decisions on purpose:
-- only approved/rejected, no 'edited' — there is no cheap in-place edit
-- here (see scripts comment above). A rejection routes back to script
-- regeneration, not a text patch.
-- ---------------------------------------------------------------------------

create table review_decisions (
  id uuid primary key default gen_random_uuid(),
  render_id uuid not null references renders(id) on delete cascade,
  reviewer_id uuid references auth.users(id) on delete set null,
  decision text not null check (decision in ('approved', 'rejected')),
  notes text,
  -- Publish-time metadata tweaks only — these never touch the rendered
  -- video itself.
  edited_title text,
  edited_description text,
  decided_at timestamptz not null default now()
);

create index review_decisions_render_id_idx on review_decisions(render_id);
create index review_decisions_decision_idx on review_decisions(decision);

-- ---------------------------------------------------------------------------
-- Publishing — YouTube only for now (TikTok/Instagram out of scope, see
-- the plan's "explicitly out of scope" section)
-- ---------------------------------------------------------------------------

create table platforms (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (name in ('youtube'))
);

insert into platforms (name) values ('youtube');

create table platform_accounts (
  id uuid primary key default gen_random_uuid(),
  platform_id uuid not null references platforms(id) on delete restrict,
  external_account_id text not null,
  display_name text,
  created_at timestamptz not null default now(),
  unique (platform_id, external_account_id)
);

create table posts (
  id uuid primary key default gen_random_uuid(),
  render_id uuid not null references renders(id) on delete cascade,
  platform_account_id uuid not null references platform_accounts(id) on delete restrict,
  external_post_id text,
  title text,
  description text,
  -- Always true. This column exists for auditability, not as a toggle —
  -- COPPA requires this to be an accurate declaration for child-directed
  -- content, not a lever to pull for reach/CPM. Do not add a code path
  -- that sets this false for episodes published to this channel.
  made_for_kids boolean not null default true,
  status text not null default 'scheduled' check (status in
    ('scheduled', 'publishing', 'published', 'failed')),
  error_message text,
  published_at timestamptz,
  created_at timestamptz not null default now()
);

create index posts_render_id_idx on posts(render_id);
create index posts_platform_account_id_idx on posts(platform_account_id);
create index posts_status_idx on posts(status);

create table post_metrics (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references posts(id) on delete cascade,
  captured_at timestamptz not null default now(),
  views bigint,
  likes bigint,
  -- Expect null/0 forever — comments are disabled by YouTube on
  -- made-for-kids videos.
  comments bigint,
  avg_watch_seconds numeric(8,2),
  raw jsonb not null default '{}'::jsonb
);

create index post_metrics_post_id_idx on post_metrics(post_id);
create index post_metrics_captured_at_idx on post_metrics(captured_at);

-- ---------------------------------------------------------------------------
-- Post-gate: only an approved render can become a post. Correct from the
-- start (only 'approved' recognized) — the sibling project needed a
-- follow-up migration to fix an equivalent trigger that didn't recognize
-- its 'edited' decision; this schema doesn't have that state to omit.
-- ---------------------------------------------------------------------------

create or replace function enforce_render_approved()
returns trigger
language plpgsql
as $$
begin
  if not exists (
    select 1 from review_decisions
    where render_id = new.render_id and decision = 'approved'
  ) then
    raise exception 'render % has no approved review_decisions row', new.render_id;
  end if;
  return new;
end;
$$;

create trigger posts_require_approval
before insert on posts
for each row execute function enforce_render_approved();
