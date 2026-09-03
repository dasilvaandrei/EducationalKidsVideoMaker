// YouTube Data API v3 upload — simple multipart upload (not the chunked
// resumable protocol), same choice as the sibling project: rendered
// episodes are tens of MB, not GBs.

import { randomUUID } from "node:crypto";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=multipart&part=snippet,status";

async function getAccessToken(): Promise<string> {
  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
  const refreshToken = process.env.YOUTUBE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, and YOUTUBE_REFRESH_TOKEN must be set");
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`YouTube token refresh failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return body.access_token as string;
}

export interface YoutubeUploadMetadata {
  title: string;
  description: string;
  tags: string[];
  categoryId: string;
  privacyStatus: "private" | "unlisted" | "public";
  // Required — deliberately no default, unlike a growth-lever field.
  // This channel is child-directed content; COPPA requires an accurate
  // "made for kids" declaration on every single upload, with real legal
  // consequences for getting it wrong. publish-episode.ts must always
  // pass `true` here. Do NOT add a code path, flag, or default that sets
  // this to `false` for this channel — there is no scenario (reach,
  // monetization, A/B testing) where that would be correct.
  selfDeclaredMadeForKids: boolean;
}

export interface YoutubeUploadResult {
  videoId: string;
  // What YouTube actually saved, not necessarily what was requested — see
  // the PRIVACY_STATUS comment in publish-episode.ts. Always check this
  // rather than assuming the request was honored.
  actualPrivacyStatus: string;
}

export async function uploadYoutubeVideo(
  videoBuffer: Buffer,
  metadata: YoutubeUploadMetadata
): Promise<YoutubeUploadResult> {
  const accessToken = await getAccessToken();
  const boundary = `kidsvideomaker-${randomUUID()}`;

  const metadataJson = JSON.stringify({
    snippet: {
      title: metadata.title,
      description: metadata.description,
      tags: metadata.tags,
      categoryId: metadata.categoryId,
    },
    status: {
      privacyStatus: metadata.privacyStatus,
      selfDeclaredMadeForKids: metadata.selfDeclaredMadeForKids,
    },
  });

  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadataJson}\r\n--${boundary}\r\nContent-Type: video/mp4\r\n\r\n`
    ),
    videoBuffer,
    Buffer.from(`\r\n--${boundary}--`),
  ]);

  const res = await fetch(UPLOAD_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
      "Content-Length": String(body.length),
    },
    body,
  });

  const responseBody = await res.json();
  if (!res.ok) {
    throw new Error(`YouTube upload failed: ${res.status} ${JSON.stringify(responseBody)}`);
  }
  return {
    videoId: responseBody.id as string,
    actualPrivacyStatus: responseBody.status?.privacyStatus as string,
  };
}
