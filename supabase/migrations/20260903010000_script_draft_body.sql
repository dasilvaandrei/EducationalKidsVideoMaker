-- Scripts now go through a two-stage pipeline: Claude drafts a
-- structurally-correct script, then Gemini rewrites it for stronger kid-
-- entertainment value (see worker/src/jobs/write-script.ts). `body` stays
-- the final (Gemini-rewritten) version every downstream job uses;
-- draft_body keeps Claude's pre-rewrite draft alongside it purely for
-- comparison/debugging.

alter table scripts add column draft_body text;
