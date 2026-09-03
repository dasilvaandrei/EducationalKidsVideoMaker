-- Widen `platforms` beyond YouTube-only, now that Paula is cross-posting
-- Shorts to TikTok and Instagram Reels too (see the multi-platform
-- publishing plan). `posts`/`platform_accounts` already key off
-- `platform_id`/`platform_account_id`, so no other schema change is
-- needed — just the allowed platform names.

alter table platforms drop constraint platforms_name_check;
alter table platforms add constraint platforms_name_check
  check (name in ('youtube', 'tiktok', 'instagram'));

insert into platforms (name) values ('tiktok'), ('instagram');

-- `platform_accounts` rows for tiktok/instagram are inserted manually once
-- the real accounts exist (external_account_id = the real handle) — same
-- as youtube's was, see youtube-oauth-bootstrap.ts's comment. Insert them
-- proactively as soon as the accounts are created, rather than waiting for
-- the first publish attempt to fail on a missing row (see memory: that
-- exact bug already happened once for youtube).
