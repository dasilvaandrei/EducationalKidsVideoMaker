-- Supports jobs/review-episode.ts, an automated LLM reviewer that stamps
-- review_decisions the same way a human clicking approve/reject in the
-- dashboard does (same table, same posts_require_approval trigger, no
-- trigger change needed). These columns only add an audit trail so a
-- decision's origin (auto vs. a real reviewer_id) and, for automated
-- ones, which model made the call, stay visible after the fact.
alter table review_decisions add column automated boolean not null default false;
alter table review_decisions add column model text;
