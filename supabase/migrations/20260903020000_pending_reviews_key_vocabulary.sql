-- Adds scripts.key_vocabulary to pending_reviews so the review dashboard
-- can preview the actual auto-generated YouTube description (built from
-- topic title + this episode's own script vocabulary, see
-- worker/src/jobs/publish-episode.ts's buildDescription) instead of
-- showing reviewers a blank "Edited description" field with no way to
-- see what will really get published.
create or replace view pending_reviews with (security_invoker = true) as
select
  r.id as render_id,
  r.episode_id,
  r.aspect_ratio,
  r.storage_path,
  r.duration_seconds,
  s.id as script_id,
  s.body as script_body,
  s.title_suggestion,
  t.category,
  t.title as topic_title,
  sc.reasoning as safety_reasoning,
  sc.categories_flagged as safety_categories_flagged,
  e.format,
  e.air_slot,
  r.created_at,
  s.key_vocabulary
from renders r
join scripts s on s.id = r.script_id
join episodes e on e.id = r.episode_id
join topics t on t.id = e.topic_id
join lateral (
  select *
  from safety_checks
  where script_id = s.id
  order by created_at desc
  limit 1
) sc on sc.verdict = 'pass'
where r.render_status = 'ready'
  and not exists (
    select 1 from review_decisions rd where rd.render_id = r.id
  );
