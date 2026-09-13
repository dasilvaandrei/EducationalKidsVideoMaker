// TikTok Content Posting API — two upload paths:
//   - uploadVideoToInbox (video.upload scope): lands as a draft in the
//     account's own TikTok inbox, always, regardless of app review status
//     — the account owner still taps "Post" themselves. This is the path
//     publish-episode.ts actually uses today.
//   - uploadTiktokVideo (video.publish scope, Direct Post): posts straight
//     to the account, no manual step. Confirmed in the sibling videoMaker
//     project that a brand-new, unaudited app gets hard-rejected by this
//     endpoint with "unaudited_client_can_only_post_to_private_accounts"
//     even when requesting SELF_ONLY — not a privacy_level problem, an
//     app-review gate with no workaround. Kept intact, unused for now, so
//     switching back once TikTok's Content Posting API audit passes is a
//     config change (which function publish-episode.ts calls), not a
//     rewrite.
//
// Field names below are per TikTok's Content Posting API reference as of
// this writing — verify against a real init/publish call once a developer
// app + refresh token exist (see jobs/tiktok-oauth-bootstrap.ts), the same
// way youtube.ts's actualPrivacyStatus behavior was only confirmed by a
// real test upload, not assumed from docs.
//
// Refresh token rotation: TikTok's docs state the refresh_token returned
// by a refresh call "may be different than the one passed in" and that the
// new value must replace the old one — refreshAccessToken always returns
// the (possibly rotated) refreshToken; callers must persist it (.env and
// the GitHub secret) if it changed. Nothing in this file writes it anywhere
// itself.

const AUTH_URL = "https://www.tiktok.com/v2/auth/authorize/";
const TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
const INBOX_UPLOAD_INIT_URL = "https://open.tiktokapis.com/v2/post/publish/inbox/video/init/";
const INIT_URL = "https://open.tiktokapis.com/v2/post/publish/video/init/";
const STATUS_URL = "https://open.tiktokapis.com/v2/post/publish/status/fetch/";
const STATUS_POLL_INTERVAL_MS = 3000;
const STATUS_POLL_MAX_ATTEMPTS = 20; // ~1 minute total
const SINGLE_CHUNK_MAX_BYTES = 64 * 1024 * 1024;

function clientKey(): string {
  const key = process.env.TIKTOK_CLIENT_KEY;
  if (!key) throw new Error("TIKTOK_CLIENT_KEY must be set");
  return key;
}

function clientSecret(): string {
  const secret = process.env.TIKTOK_CLIENT_SECRET;
  if (!secret) throw new Error("TIKTOK_CLIENT_SECRET must be set");
  return secret;
}

// TikTok's redirect_uri must be an HTTPS URL on a verified domain — it
// cannot be a loopback address (http://127.0.0.1/...) on any platform,
// confirmed against the sibling videoMaker project's working setup. So
// this is a Web-platform app: jobs/tiktok-oauth-bootstrap.ts prints this
// URL for you to open, TikTok redirects the browser to the static
// docs/oauth-callback.html page (served via GitHub Pages), which displays
// the returned `code` for you to paste back into the bootstrap script.
export function buildAuthorizationUrl(redirectUri: string, state: string): string {
  const url = new URL(AUTH_URL);
  url.searchParams.set("client_key", clientKey());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "user.info.basic,video.upload,video.publish");
  url.searchParams.set("state", state);
  return url.toString();
}

export interface TiktokAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  openId: string;
}

export async function exchangeCodeForTokens(code: string, redirectUri: string): Promise<TiktokAuthTokens> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache" },
    body: new URLSearchParams({
      client_key: clientKey(),
      client_secret: clientSecret(),
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });
  const body = await res.json();
  if (!res.ok || body.error) {
    throw new Error(`TikTok token exchange failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return {
    accessToken: body.access_token as string,
    refreshToken: body.refresh_token as string,
    expiresIn: body.expires_in as number,
    openId: body.open_id as string,
  };
}

export interface TiktokTokens {
  accessToken: string;
  refreshToken: string;
}

export async function refreshAccessToken(refreshToken: string): Promise<TiktokTokens> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache" },
    body: new URLSearchParams({
      client_key: clientKey(),
      client_secret: clientSecret(),
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const body = await res.json();
  if (!res.ok || body.error) {
    throw new Error(`TikTok token refresh failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return { accessToken: body.access_token as string, refreshToken: (body.refresh_token as string) ?? refreshToken };
}

async function getAccessToken(): Promise<string> {
  const refreshToken = process.env.TIKTOK_REFRESH_TOKEN;
  if (!refreshToken) throw new Error("TIKTOK_REFRESH_TOKEN must be set");
  const tokens = await refreshAccessToken(refreshToken);
  return tokens.accessToken;
}

// Single-chunk upload only — every rendered Short is well under TikTok's
// single-chunk ceiling. Unlike Direct Post, the inbox endpoint has no
// caption/title field at all — the video arrives with nothing pre-filled,
// so whoever finishes the post has to copy the caption in by hand (it's
// already saved on the `posts` row by publish-episode.ts).
export async function uploadVideoToInbox(accessToken: string, videoBuffer: Buffer): Promise<void> {
  const initRes = await fetch(INBOX_UPLOAD_INIT_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({
      source_info: {
        source: "FILE_UPLOAD",
        video_size: videoBuffer.length,
        chunk_size: videoBuffer.length,
        total_chunk_count: 1,
      },
    }),
  });
  const initBody = await initRes.json();
  const uploadUrl = initBody?.data?.upload_url;
  if (!initRes.ok || !uploadUrl) {
    throw new Error(`TikTok inbox upload init failed: ${initRes.status} ${JSON.stringify(initBody)}`);
  }

  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(videoBuffer.length),
      "Content-Range": `bytes 0-${videoBuffer.length - 1}/${videoBuffer.length}`,
    },
    body: videoBuffer as unknown as BodyInit,
  });
  if (!putRes.ok) {
    throw new Error(`TikTok inbox upload failed: ${putRes.status} ${await putRes.text()}`);
  }
}

export type TiktokPrivacyLevel =
  | "SELF_ONLY"
  | "PUBLIC_TO_EVERYONE"
  | "MUTUAL_FOLLOW_FRIENDS"
  | "FOLLOWER_OF_CREATOR";

export interface TiktokUploadMetadata {
  title: string; // TikTok's field name for the on-post caption text
  privacyLevel: TiktokPrivacyLevel;
  // Which frame becomes the cover, in ms from the start of the video —
  // TikTok's only cover-selection mechanism (no separate custom-image
  // upload). Only meaningful here, on the dormant Direct Post path: the
  // inbox/draft endpoint this project actually uses today has no
  // post_info object at all (see uploadVideoToInbox above), so there is
  // currently no API-level way to set a TikTok cover — whoever finishes
  // the draft in-app picks the cover by hand. This field takes effect
  // automatically once publish-episode.ts switches back to
  // uploadTiktokVideo after the Content Posting API audit passes.
  videoCoverTimestampMs?: number;
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
        ...(metadata.videoCoverTimestampMs != null
          ? { video_cover_timestamp_ms: Math.round(metadata.videoCoverTimestampMs) }
          : {}),
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
