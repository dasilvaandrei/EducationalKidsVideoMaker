# KidsVideoMaker

Autonomous pipeline for a children's educational YouTube channel (under-8
audience). Unlike the sibling `videoMaker` clip-farm repo, everything here is
**100% original content**: a rotating early-learning curriculum drives an LLM
script writer, a separate LLM safety-check gate screens every script before
a human ever sees it, ElevenLabs TTS voices it, and Remotion renders a
code-driven 2D mascot + captions around the voiceover. Every render still
goes through mandatory human review before it can publish. Every YouTube
upload is declared `selfDeclaredMadeForKids: true` — this is a hard COPPA
requirement for this channel, not a togglable setting; see the comment above
`uploadYoutubeVideo()` in `worker/src/lib/youtube.ts` before touching it.

Full architecture, schema rationale, and every operational gotcha (OAuth
token expiry, made-for-kids platform restrictions, DST-safe cron, etc.) is
recorded in the build plan this repo was implemented from — ask Claude Code
to pull it up from `/Users/andreidasilva/.claude/plans/floofy-coalescing-orbit.md`
if you're picking this back up later.

## Status

- **Database**: live on its own Supabase project (`supabase/migrations/`) —
  curriculum (`topics`), episodes, versioned scripts, the automated safety
  gate, voiceovers, renders, human review, and YouTube publishing. Seeded
  with a 48-topic curriculum bank (`supabase/seed.sql`), 8 per category
  across phonics/ABCs, counting, colors/shapes, animals, science, and
  emotions/manners.
- **Worker** (`worker/`): the full content-generation pipeline is built —
  topic rotation, script writing, safety-check gate, ElevenLabs
  voiceover + word-level captions, Remotion render (mascot + 6 category
  backgrounds, 16:9 and 9:16), and YouTube publish. `pick-topic.ts` has been
  run once against the live database and confirmed working end-to-end.
  `write-script.ts`/`safety-check.ts` (need `ANTHROPIC_API_KEY`),
  `generate-voiceover.ts` (needs `ELEVENLABS_API_KEY`/`ELEVENLABS_VOICE_ID`),
  and `publish-episode.ts` (needs a YouTube OAuth app + channel) are built
  and typecheck clean but not yet exercised live — see `.env.example` for
  the full credential list still needed.
- **Dashboard** (`apps/dashboard/`): Next.js review app is built —
  `/review` shows the video, full script, and the safety-check reasoning
  (even on a pass) for every pending render, with approve/reject against
  `review_decisions`. `npm run build` and eslint both pass clean; not yet
  exercised against real reviewer data.
- **Scheduling**: three GitHub Actions publish crons
  (`.github/workflows/publish-long-form-tuesday.yml`,
  `-friday.yml`, `-short-nightly.yml`) plus a daily
  `generate-content.yml` that tops up a standing content buffer ahead of
  each publish slot. Not yet enabled — wire up repo secrets and confirm a
  manual `workflow_dispatch` run first.

## Setup

```bash
npm install
cp .env.example .env   # fill in real values, see comments in the file
```

Needs Node 18+.

### Worker

```bash
cd worker
npm run pick-topic -- --format long_form --air-slot tuesday_long_form
npm run write-script -- <episode_id>
npm run safety-check -- <episode_id>
npm run generate-voiceover
npm run render-episode
npm run remotion:studio   # preview compositions with real/dummy data
```

### Database migrations

```bash
npx supabase link --project-ref <this-project-ref>
npx supabase db push
```
