# KidsVideoMaker

Autonomous pipeline for **Paula the Penguin Learns** (`@paulathepenguinlearns`),
a children's educational YouTube channel (under-8 audience). Unlike the
sibling `videoMaker` clip-farm repo, everything here is **100% original
content**: a rotating early-learning curriculum drives a two-stage LLM
script writer, a separate LLM safety-check gate screens every script
before a human ever sees it, ElevenLabs TTS voices it, and Remotion
renders a code-generated 2D mascot + captions around the voiceover.
Every render still goes through mandatory human review in a deployed
web dashboard before it can publish. Every YouTube upload is declared
`selfDeclaredMadeForKids: true` — this is a hard COPPA requirement for
this channel, not a togglable setting; see the comment above
`uploadYoutubeVideo()` in `worker/src/lib/youtube.ts` before touching it.

**This is live**, not a prototype: the channel has published real videos
(both a private test and a genuine public upload), the review dashboard
is deployed and reachable from anywhere, and the GitHub Actions
automation has been proven working in CI, not just locally.

## How an episode actually gets made

1. **`pick-topic`** rotates through a 48-topic curriculum bank (8 topics
   each across phonics/ABCs, counting, colors/shapes, animals, science,
   and emotions/manners), picking the least-recently-used topic in
   whichever category needs one next.
2. **`write-script`** is a two-stage pipeline: Claude drafts a
   structurally-correct script first (hard word-count/sentence-length
   constraints, a "visual grounding" rule that bans narration referencing
   anything not actually shown on screen, mandatory counting-with-the-
   mascot framing), then Gemini rewrites it for stronger kid-entertainment
   value while preserving every constraint. Gemini's rewrite is what
   ships; Claude's draft is kept in `scripts.draft_body` for comparison.
   Both stages are instructed to never use em/en dashes, and a
   `stripDashes()` backstop guarantees it even if a prompt is ignored —
   the dash character doesn't caption well for a pre-reader.
3. **`safety-check`** is an independent LLM call — a second gate, not the
   same one that wrote the script — screening for scary/violent content,
   unsafe imitable behavior, product pitches, sad themes, and dangerously
   misreadable content. A script that fails never reaches a human
   reviewer at all (enforced by the `pending_reviews` view itself).
4. **`generate-voiceover`** synthesizes the script with ElevenLabs'
   timestamped TTS endpoint and reconstructs word-level captions from its
   character-level alignment (a documented gotcha — see the comment in
   `worker/src/lib/tts/elevenlabs.ts`).
5. **`render-episode`** renders through Remotion: the mascot ("Paula the
   Penguin," Gemini-generated with chroma-key transparency, gesture poses
   for idle/blink/talk/wave/clap/point/think, all color-locked to a single
   k-means-extracted palette so poses generated independently still match),
   a 3-act background (living room → per-topic scene → living room), and
   `@remotion/captions`-driven word-highlight captions. A number word in
   the script shows that many small pictures of Paula herself (not a
   generic icon); a color word shows a matching color swatch; a concrete
   vocabulary word shows a real photo — all sourced only from what the
   actual script says, never a topic-level fallback.
6. A human reviews it in the **deployed dashboard**
   (https://review.andreidasilva.com) — video preview, full script text,
   the safety-check's reasoning shown even on a pass (so a reviewer can
   see the automated gate is doing real work), and a preview of the exact
   description that will be published — then approves or rejects. A
   rejection routes back to script regeneration; there's no in-place
   script edit, since the audio and burned-in captions already reflect
   the exact words of that script version.
7. **`publish-episode`** publishes approved episodes to YouTube as a real
   FIFO queue — each scheduled run publishes exactly one episode, always
   the one that's been approved longest, per air slot. Title is the
   script's plain sentence-case suggestion; description is a promo-style
   template (honest one-line hook, a "today's lesson" vocabulary line,
   posting-schedule callout, subscribe CTA, curriculum hashtags, channel
   blurb) — modeled on how established creator channels structure theirs,
   without adopting the sibling project's ALL-CAPS/emoji-spam style.

## Scheduling (GitHub Actions, live)

- **`generate-content.yml`** — daily, ~5-6am ET. Tops up a standing
  buffer (target: 2 Tuesday long-form + 2 Friday long-form + 3 Shorts
  always sitting in the review queue) by running the full pipeline for
  whatever's short of target. Deliberately daily rather than a weekly
  batch: a failed render gets retried the very next morning instead of
  waiting up to a week, and daily cadence already outpaces the 7
  Shorts/week the nightly cron consumes once running for real.
- **`publish-short-nightly.yml`** — nightly, publishes one approved Short.
- **`publish-long-form-tuesday.yml`** / **`-friday.yml`** — weekly, one
  approved long-form episode each. Long-form publishing starts for real
  the first Tuesday after this was wired up; the crons themselves need no
  separate "go live" step since they only fire on their actual scheduled
  day regardless of when the workflow file landed.

All four workflows also support `workflow_dispatch` for a manual
catch-up run. `YOUTUBE_UPLOAD_PRIVACY_STATUS` is a repo secret — flipped
to `public` once a manual test run confirmed YouTube actually honors it
on this channel's OAuth app (see "OAuth status" below).

## Review dashboard (deployed)

Next.js app in `apps/dashboard/`, deployed to Vercel at
**https://review.andreidasilva.com** (custom domain via `andreidasilva.com`'s
DNS, root-domain-authorized in Google Cloud Console so the subdomain
inherits it automatically).

- `/login` — Supabase Auth email/password sign-in.
- `/forgot-password` → `/auth/confirm` → `/reset-password` — full
  self-serve password recovery (the standard Supabase SSR recovery
  pattern: request a reset email, exchange its one-time token server-side,
  then set a new password), so a lost reviewer password no longer needs
  a manual Supabase Admin API reset.
- `/review` — the actual review queue, split into **Long-form** and
  **Shorts** tabs (each with a live count). Every card shows the video,
  category/topic, suggested title, the real auto-generated description
  preview, the full script, and the safety-check's reasoning. Approve or
  reject, with optional title/description overrides for publish-time
  metadata tweaks only (they never touch the rendered video itself).

Auth/session handling follows Supabase's standard SSR proxy pattern
(`src/proxy.ts`) — real authorization comes from Postgres RLS
(`security_invoker` on `pending_reviews`), not from the redirect logic.

## Database

Live on its own Supabase project (`supabase/migrations/`, applied via
`supabase db push`) — curriculum (`topics`), episodes, versioned scripts
(a rejection produces a new version, never an in-place edit),
`safety_checks`, `voiceovers`, `renders`, `review_decisions`,
`platforms`/`platform_accounts`/`posts` for the actual YouTube publish
records, and the `pending_reviews`/`image_assets` views/tables the
dashboard and asset pipeline read from. Seeded with a 48-topic curriculum
bank (`supabase/seed.sql`).

## Branding assets

`branding/profile_icon.png` (800×800) and `branding/banner.png`
(2560×1440, safe-zone-checked) — composited locally from the actual
mascot artwork already in Supabase Storage (not a fresh AI generation),
so they're pixel-matched to what's actually in the videos. Local-only,
not committed to git; upload them directly in YouTube Studio →
Customization → Branding if they ever need to be reapplied.

`docs/` is a small static site on GitHub Pages at
https://kidsvideomaker.andreidasilva.com — home page + privacy policy,
which exists specifically to satisfy Google's OAuth consent-screen
requirements (a real home page URL + a privacy policy disclosing the
`youtube.upload` scope), not as a public marketing site.

## OAuth status

This is a personal-use, single-developer Google Cloud project — Google
explicitly does not formally review "personal use only" apps even in
Production status. The app's Publishing status is **In production**
(not Testing), which is what actually matters operationally: Testing-mode
apps get a 7-day refresh-token expiry and are restricted to private-only
uploads regardless of what `privacyStatus` is requested; Production
removes both restrictions even without the "verified" badge. Confirmed
live, not just theorized: a manual test published a video with
`privacyStatus=public` and YouTube's response confirmed
`actualPrivacyStatus=public`. Sign-in still shows Google's generic
"unverified app" warning — expected and harmless, click through as the
account owner.

## Setup

```bash
npm install
cp .env.example .env   # fill in real values, see comments in the file
```

Needs Node 18+. This project needs its own Supabase project and its own
YouTube channel/OAuth app — never point it at the sibling `videoMaker`
repo's credentials.

### Worker

```bash
cd worker
npm run generate-assets      # one-time: mascot poses, backgrounds, vocab photos
npm run generate-content     # pick-topic -> write-script -> safety-check -> voice -> render, tops up the buffer
npm run publish-episode      # publishes approved+ready episodes (add --air-slot / --limit / a render id to scope it)
npm run remotion:studio      # preview compositions with real/dummy data
```

Each stage also has its own standalone script (`pick-topic`,
`write-script`, `safety-check`, `generate-voiceover`, `render-episode`)
for running one step by hand — see `worker/package.json`.

### Dashboard

```bash
cd apps/dashboard
cp .env.local.example .env.local   # fill in real values
npm run dev     # local dev server
npm run build   # production build, also what Vercel runs on deploy
```

### Database migrations

```bash
npx supabase link --project-ref <this-project-ref>
npx supabase db push
```
