// TikTok Content Posting API — Direct Post via FILE_UPLOAD, mirroring
// lib/youtube.ts's shape (refresh token -> access token -> single upload
// call). Single-chunk upload only (chunk_size = video_size, one PUT) since
// our rendered Shorts are well under TikTok's 64MB single-chunk ceiling —
// same non-resumable-is-fine reasoning as youtube.ts's non-chunked upload.
//
// Field names below are per TikTok's Content Posting API reference as of
// this writing — verify against a real init/publish call once a developer
// app + refresh token exist (see jobs/tiktok-oauth-bootstrap.ts), the same
// way youtube.ts's actualPrivacyStatus behavior was only confirmed by a
// real test upload, not assumed from docs.

const TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
const INIT_URL = "https://open.tiktokapis.com/v2/post/publish/video/init/";
const STATUS_URL = "https://open.tiktokapis.com/v2/post/publish/status/fetch/";
const STATUS_POLL_INTERVAL_MS = 3000;
const STATUS_POLL_MAX_ATTEMPTS = 20; // ~1 minute total
const SINGLE_CHUNK_MAX_BYTES = 64 * 1024 * 1024;

async function getAccessToken(): Promise<string> {
  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
  const refreshToken = process.env.TIKTOK_REFRESH_TOKEN;
  if (!clientKey || !clientSecret || !refreshToken) {
    throw new Error("TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, and TIKTOK_REFRESH_TOKEN must be set");
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache" },
    body: new URLSearchParams({
      client_key: clientKey,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const body = await res.json();
  if (!res.ok || body.error) {
    throw new Error(`TikTok token refresh failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return body.access_token as string;
}

export type TiktokPrivacyLevel =
  | "SELF_ONLY"
  | "PUBLIC_TO_EVERYONE"
  | "MUTUAL_FOLLOW_FRIENDS"
  | "FOLLOWER_OF_CREATOR";

export interface TiktokUploadMetadata {
  title: string; // TikTok's field name for the on-post caption text
  privacyLevel: TiktokPrivacyLevel;
}

export interface TiktokUploadResult {
  publishId: string;
  // What TikTok's status-poll actually reports, not just what was
  // requested — unaudited apps are silently forced to SELF_ONLY
  // regardless of privacyLevel, same "never assume the request was
  // honored" pattern youtube.ts already established for privacy status.
  status: string;
}

export async function uploadTiktokVideo(
  videoBuffer: Buffer,
  metadata: TiktokUploadMetadata
): Promise<TiktokUploadResult> {
  if (videoBuffer.length > SINGLE_CHUNK_MAX_BYTES) {
    throw new Error(
      `video is ${videoBuffer.length} bytes, over the ${SINGLE_CHUNK_MAX_BYTES}-byte single-chunk ceiling — ` +
        `this client only implements single-chunk FILE_UPLOAD (fine for Shorts-length content); add real multi-chunk support before using it for anything longer`
    );
  }

  const accessToken = await getAccessToken();

  const initRes = await fetch(INIT_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({
      post_info: {
        title: metadata.title,
        privacy_level: metadata.privacyLevel,
        disable_duet: false,
        disable_comment: false,
        disable_stitch: false,
      },
      source_info: {
        source: "FILE_UPLOAD",
        video_size: videoBuffer.length,
        chunk_size: videoBuffer.length,
        total_chunk_count: 1,
      },
    }),
  });
  const initBody = await initRes.json();
  if (!initRes.ok || initBody.error?.code !== "ok") {
    throw new Error(`TikTok publish init failed: ${initRes.status} ${JSON.stringify(initBody)}`);
  }

  const publishId = initBody.data.publish_id as string;
  const uploadUrl = initBody.data.upload_url as string;

  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "video/mp4",
      "Content-Range": `bytes 0-${videoBuffer.length - 1}/${videoBuffer.length}`,
    },
    body: new Uint8Array(videoBuffer),
  });
  if (!putRes.ok) {
    throw new Error(`TikTok video upload failed: ${putRes.status} ${await putRes.text()}`);
  }

  return pollPublishStatus(accessToken, publishId);
}

async function pollPublishStatus(accessToken: string, publishId: string): Promise<TiktokUploadResult> {
  for (let attempt = 0; attempt < STATUS_POLL_MAX_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_INTERVAL_MS));

    const res = await fetch(STATUS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ publish_id: publishId }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`TikTok status poll failed: ${res.status} ${JSON.stringify(body)}`);

    const status = body.data?.status as string;
    if (status === "PUBLISH_COMPLETE") {
      return { publishId, status };
    }
    if (status === "FAILED") {
      throw new Error(`TikTok publish failed: ${JSON.stringify(body.data)}`);
    }
    // else PROCESSING_DOWNLOAD / PROCESSING_UPLOAD / SEND_TO_USER_INBOX — keep polling
  }
  throw new Error(
    `TikTok publish status still pending after ${STATUS_POLL_MAX_ATTEMPTS} polls (publish_id=${publishId}) — check the TikTok Content Posting API status endpoint manually`
  );
}
