// Instagram Platform API (Business Login for Instagram) — publishing to
// the Paula Instagram Professional account. Deliberately does the real
// OAuth authorization-code flow (see jobs/meta-oauth-bootstrap.ts) instead
// of a token grabbed from the Meta app dashboard's "Generate access
// tokens" shortcut button: confirmed in the sibling videoMaker project
// that a shortcut token works fine for basic reads (GET /me) but is
// consistently rejected by the long-lived-token exchange with a
// non-transient "Session key invalid" error — Meta's own troubleshooting
// docs warn that mixing token types across these endpoints causes exactly
// this kind of failure. The real flow below is Meta's documented, working
// pipeline, and needs no linked Facebook Page (unlike the older
// graph.facebook.com + Page flow).

const AUTHORIZE_URL = "https://api.instagram.com/oauth/authorize";
const CODE_EXCHANGE_URL = "https://api.instagram.com/oauth/access_token";
const LONG_LIVED_EXCHANGE_URL = "https://graph.instagram.com/access_token";
const REFRESH_URL = "https://graph.instagram.com/refresh_access_token";
const GRAPH_BASE = "https://graph.instagram.com";

function appId(): string {
  const id = process.env.META_APP_ID;
  if (!id) throw new Error("META_APP_ID must be set");
  return id;
}

function appSecret(): string {
  const secret = process.env.META_APP_SECRET;
  if (!secret) throw new Error("META_APP_SECRET must be set");
  return secret;
}

// Only the scopes this pipeline actually uses — instagram_business_basic
// (required dependency) and instagram_business_content_publish (the actual
// publishing permission). Omits the messaging scopes Meta's use case
// bundles by default; this project never reads or responds to
// comments/DMs.
const SCOPE = "instagram_business_basic,instagram_business_content_publish";

export function buildAuthorizationUrl(redirectUri: string, state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", appId());
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("state", state);
  return url.toString();
}

export interface ShortLivedToken {
  accessToken: string;
  userId: string;
}

// Instagram's redirect sometimes appends a "#_" fragment to the returned
// code — must be stripped before exchange, per Meta's own docs.
function stripCodeSuffix(code: string): string {
  return code.replace(/#_$/, "");
}

export async function exchangeCodeForToken(code: string, redirectUri: string): Promise<ShortLivedToken> {
  const body = new URLSearchParams({
    client_id: appId(),
    client_secret: appSecret(),
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    code: stripCodeSuffix(code),
  });
  const res = await fetch(CODE_EXCHANGE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const responseBody = await res.json();
  if (!res.ok || !responseBody.access_token) {
    throw new Error(`Instagram code exchange failed: ${res.status} ${JSON.stringify(responseBody)}`);
  }
  return { accessToken: responseBody.access_token, userId: String(responseBody.user_id) };
}

export interface LongLivedToken {
  accessToken: string;
  expiresIn: number;
}

export async function exchangeForLongLivedToken(shortLivedToken: string): Promise<LongLivedToken> {
  const params = new URLSearchParams({
    grant_type: "ig_exchange_token",
    client_secret: appSecret(),
    access_token: shortLivedToken,
  });
  const res = await fetch(`${LONG_LIVED_EXCHANGE_URL}?${params.toString()}`);
  const body = await res.json();
  if (!res.ok || !body.access_token) {
    throw new Error(`Instagram long-lived token exchange failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return { accessToken: body.access_token, expiresIn: body.expires_in };
}

// Refreshes a long-lived token that's at least 24h old but not yet
// expired, extending it another 60 days from the refresh date — a future
// scheduled job could call this periodically to keep META_ACCESS_TOKEN
// alive indefinitely without a new manual login. Not wired into the cron
// yet; re-run meta-oauth-bootstrap.ts by hand before the token's ~60-day
// expiry until then.
export async function refreshLongLivedToken(longLivedToken: string): Promise<LongLivedToken> {
  const params = new URLSearchParams({
    grant_type: "ig_refresh_token",
    access_token: longLivedToken,
  });
  const res = await fetch(`${REFRESH_URL}?${params.toString()}`);
  const body = await res.json();
  if (!res.ok || !body.access_token) {
    throw new Error(`Instagram token refresh failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return { accessToken: body.access_token, expiresIn: body.expires_in };
}

// Step 1 of 2 — posts as a Reel (share_to_feed also surfaces it in the
// main feed grid, not just the Reels tab). Instagram's servers fetch the
// video FROM this URL themselves rather than accepting a file upload, so
// videoUrl must be a real public URL a server can reach — a Supabase
// signed URL works as long as its TTL outlives however long Instagram
// takes to fetch and process it. Sign fresh right before calling this;
// reusing an earlier-signed URL is exactly the bug that broke
// render-episode.ts's batch renders once already — see publish-episode.ts.
export async function createMediaContainer(
  igUserId: string,
  accessToken: string,
  videoUrl: string,
  caption: string
): Promise<string> {
  const params = new URLSearchParams({
    media_type: "REELS",
    video_url: videoUrl,
    caption,
    share_to_feed: "true",
    access_token: accessToken,
  });
  const res = await fetch(`${GRAPH_BASE}/${igUserId}/media`, { method: "POST", body: params });
  const body = await res.json();
  if (!res.ok || !body.id) {
    throw new Error(`Instagram media container creation failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return body.id;
}

export type ContainerStatus = "EXPIRED" | "ERROR" | "FINISHED" | "IN_PROGRESS" | "PUBLISHED";

export async function getContainerStatus(
  containerId: string,
  accessToken: string
): Promise<{ status: ContainerStatus; statusDetail?: string }> {
  const params = new URLSearchParams({ fields: "status_code,status", access_token: accessToken });
  const res = await fetch(`${GRAPH_BASE}/${containerId}?${params.toString()}`);
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`Instagram container status check failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return { status: body.status_code, statusDetail: body.status };
}

// Step 2 of 2 — the container must be status_code=FINISHED (video fully
// processed server-side) before this succeeds; see getContainerStatus.
export async function publishMediaContainer(
  igUserId: string,
  accessToken: string,
  containerId: string
): Promise<string> {
  const params = new URLSearchParams({ creation_id: containerId, access_token: accessToken });
  const res = await fetch(`${GRAPH_BASE}/${igUserId}/media_publish`, { method: "POST", body: params });
  const body = await res.json();
  if (!res.ok || !body.id) {
    throw new Error(`Instagram media publish failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return body.id;
}
