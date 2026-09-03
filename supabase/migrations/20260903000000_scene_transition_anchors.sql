-- Adds the two anchor columns write-script.ts now asks Claude to produce
-- alongside the script body: short verbatim quotes marking where the
-- render should cut from the living room to the topic scene, and back
-- again. Nullable — older script rows (and any future row where the LLM
-- output couldn't be matched) simply have no anchor, which
-- render-episode.ts's resolveSceneTransitions() already treats as "use
-- the 15%/85%-of-duration fallback" rather than an error.

alter table scripts add column topic_scene_anchor text;
alter table scripts add column home_scene_anchor text;
