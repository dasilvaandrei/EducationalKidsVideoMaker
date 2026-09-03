-- Review dashboard support: the pending-review queue and storage read
-- access for previewing rendered episodes. Adapted from the sibling
-- videoMaker project's review_dashboard.sql.

-- ---------------------------------------------------------------------------
-- Pending review queue
-- ---------------------------------------------------------------------------
-- Ready renders that don't yet have a review_decisions row, restricted to
-- scripts whose *latest* safety check passed. A safety-flagged script must
-- never reach a human reviewer — that's enforced here, in the view's WHERE
-- clause, not just as a status label elsewhere. security_invoker makes the
-- view check RLS as the querying (dashboard) role rather than the view
-- owner.

create view pending_reviews with (security_invoker = true) as
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
  r.created_at
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

-- ---------------------------------------------------------------------------
-- Storage read access for the dashboard
-- ---------------------------------------------------------------------------

create policy authenticated_read_media_objects
on storage.objects for select
to authenticated
using (bucket_id = 'media');
