// Instagram Graph API — Reels publishing via the 3-step container flow
// (create container -> poll until FINISHED -> publish). Unlike
// youtube.ts/tiktok.ts, this takes a fetchable video URL rather than a raw
// buffer, since Meta's servers download the video themselves instead of
// accepting an upload. The caller must hand this a signed URL with a
// generous TTL, signed fresh right before the call — Meta's processing is
// async and can take minutes, and reusing a URL signed earlier in a batch
// is exactly the bug that broke render-episode.ts's batch renders this
// session. Don't repeat it here.
//
// Posting only to our own IG account (not third-party users'), so per
// Meta's docs this needs no App Review — just the account added as a
// tester/asset on the Meta developer app in Development Mode.

const GRAPH_API_VERSION = "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
const STATUS_POLL_INTERVAL_MS = 5000;
const STATUS_POLL_MAX_ATTEMPTS = 36; // ~3 minutes total

export interface InstagramUploadMetadata {
  videoUrl: string; // publicly-fetchable, e.g. a freshly-signed Supabase Storage URL
  caption: string;
}

export interface InstagramUploadResult {
  mediaId: string;
}

export async function uploadInstagramReel(metadata: InstagramUploadMetadata): Promise<InstagramUploadResult> {
  const igUserId = process.env.META_IG_USER_ID;
  const accessToken = process.env.META_PAGE_ACCESS_TOKEN;
  if (!igUserId || !accessToken) {
    throw new Error("META_IG_USER_ID and META_PAGE_ACCESS_TOKEN must be set");
  }

  const containerRes = await fetch(`${GRAPH_BASE}/${igUserId}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      media_type: "REELS",
      video_url: metadata.videoUrl,
      caption: metadata.caption,
      access_token: accessToken,
    }),
  });
  const containerBody = await containerRes.json();
  if (!containerRes.ok || containerBody.error) {
    throw new Error(
      `Instagram media container creation failed: ${containerRes.status} ${JSON.stringify(containerBody)}`
    );
  }
  const containerId = containerBody.id as string;

  await pollContainerReady(containerId, accessToken);

  const publishRes = await fetch(`${GRAPH_BASE}/${igUserId}/media_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ creation_id: containerId, access_token: accessToken }),
  });
  const publishBody = await publishRes.json();
  if (!publishRes.ok || publishBody.error) {
    throw new Error(`Instagram media publish failed: ${publishRes.status} ${JSON.stringify(publishBody)}`);
  }

  return { mediaId: publishBody.id as string };
}

async function pollContainerReady(containerId: string, accessToken: string): Promise<void> {
  for (let attempt = 0; attempt < STATUS_POLL_MAX_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_INTERVAL_MS));

    const url = new URL(`${GRAPH_BASE}/${containerId}`);
    url.searchParams.set("fields", "status_code");
    url.searchParams.set("access_token", accessToken);
    const res = await fetch(url.toString());
    const body = await res.json();
    if (!res.ok || body.error) {
      throw new Error(`Instagram container status check failed: ${res.status} ${JSON.stringify(body)}`);
    }

    if (body.status_code === "FINISHED") return;
    if (body.status_code === "ERROR") {
      throw new Error(`Instagram failed to process the uploaded video (container ${containerId})`);
    }
    // else IN_PROGRESS / EXPIRED — keep polling
  }
  throw new Error(
    `Instagram container ${containerId} still not FINISHED after ${STATUS_POLL_MAX_ATTEMPTS} polls — check manually via the Graph API Explorer`
  );
}
