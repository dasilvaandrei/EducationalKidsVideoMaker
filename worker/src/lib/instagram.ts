// Instagram Reels publishing — thin wrapper around lib/meta.ts's 3-step
// container flow (create container -> poll until FINISHED -> publish),
// keeping the same signature publish-episode.ts already calls
// (uploadInstagramReel({ videoUrl, caption })) so that call site didn't
// need to change when this moved to the Business Login flow (see
// lib/meta.ts and jobs/meta-oauth-bootstrap.ts for why: the older
// graph.facebook.com + linked-Page approach this file used to implement
// needed a Facebook Page linked to the IG account; the Instagram Platform
// API needs only the IG Professional account itself).

import {
  createMediaContainer,
  getContainerStatus,
  publishMediaContainer,
} from "./meta.js";

const STATUS_POLL_INTERVAL_MS = 5000;
const STATUS_POLL_MAX_ATTEMPTS = 36; // ~3 minutes total

// Instagram has no custom-cover-image upload — the cover is just a frame
// of the video itself, picked by timestamp (see meta.ts's thumbOffsetMs).
// Every render opens with ThumbnailCard.tsx's title-card overlay, held at
// full opacity from frame 0 until HOLD_SECONDS (3.2s) then crossfading out
// over FADE_SECONDS (0.6s) — 1.5s lands comfortably inside the fully-held
// window, well before the fade starts, so this picks a frame of that
// designed card rather than an arbitrary mid-video moment.
const DEFAULT_THUMB_OFFSET_MS = 1500;

export interface InstagramUploadMetadata {
  videoUrl: string; // publicly-fetchable, e.g. a freshly-signed Supabase Storage URL
  caption: string;
  // Overrides the default cover frame (see DEFAULT_THUMB_OFFSET_MS) if a
  // caller ever needs a different moment; almost always left unset.
  thumbOffsetMs?: number;
}

export interface InstagramUploadResult {
  mediaId: string;
}

export async function uploadInstagramReel(metadata: InstagramUploadMetadata): Promise<InstagramUploadResult> {
  const igUserId = process.env.META_INSTAGRAM_USER_ID;
  const accessToken = process.env.META_ACCESS_TOKEN;
  if (!igUserId || !accessToken) {
    throw new Error("META_INSTAGRAM_USER_ID and META_ACCESS_TOKEN must be set — run meta-oauth-bootstrap.ts first");
  }

  const containerId = await createMediaContainer(
    igUserId,
    accessToken,
    metadata.videoUrl,
    metadata.caption,
    metadata.thumbOffsetMs ?? DEFAULT_THUMB_OFFSET_MS
  );
  await waitUntilFinished(containerId, accessToken);
  const mediaId = await publishMediaContainer(igUserId, accessToken, containerId);

  return { mediaId };
}

async function waitUntilFinished(containerId: string, accessToken: string): Promise<void> {
  for (let attempt = 0; attempt < STATUS_POLL_MAX_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_INTERVAL_MS));

    const { status, statusDetail } = await getContainerStatus(containerId, accessToken);
    if (status === "FINISHED") return;
    if (status === "ERROR" || status === "EXPIRED") {
      throw new Error(`Instagram container ${containerId} failed: ${status}${statusDetail ? ` (${statusDetail})` : ""}`);
    }
    // else IN_PROGRESS — keep polling
  }
  throw new Error(
    `Instagram container ${containerId} still not FINISHED after ${STATUS_POLL_MAX_ATTEMPTS} polls — check manually via the Graph API Explorer`
  );
}
