# KidsVideoMaker review dashboard

Internal Next.js app for human review of generated episodes before they can
be published. A render only appears in the queue once its script has passed
the automated safety-check gate (see `pending_reviews` in
`../../supabase/migrations/20260901010000_review_dashboard.sql`); the
safety-check reasoning is still shown on every card so reviewers can see the
automated gate is doing real work, not rubber-stamping.

Approving or rejecting only ever inserts a row into `review_decisions` — it
never edits the script or the render. A rejection routes the episode back to
`write-script.ts` for a brand-new script version, since the audio and
burned-in captions already reflect the current script's exact words and
can't be patched in place.

## Setup

1. Copy `.env.local.example` to `.env.local` and fill in this project's own
   Supabase project URL and anon key:

   ```bash
   cp .env.local.example .env.local
   ```

   ```
   NEXT_PUBLIC_SUPABASE_URL=
   NEXT_PUBLIC_SUPABASE_ANON_KEY=
   ```

   This is a separate Supabase project from the sibling `videoMaker` repo's
   dashboard — do not point it at that project.

2. Install dependencies from the repo root (npm workspaces):

   ```bash
   npm install
   ```

3. Run the dev server:

   ```bash
   npm run dev
   ```

   Open [http://localhost:3000](http://localhost:3000).

Reviewer accounts are created out-of-band via the Supabase dashboard or
Admin API — there is no self-serve signup flow.
