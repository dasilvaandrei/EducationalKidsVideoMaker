// One-time (or periodic) manual OAuth bootstrap for TikTok's Content
// Posting API. Not part of the automated pipeline: run it by hand
// whenever TIKTOK_REFRESH_TOKEN needs replacing. Same loopback
// authorization-code shape as youtube-oauth-bootstrap.ts.
//
// Prerequisite: a TikTok developer app registered at
// developers.tiktok.com with the video.publish scope requested, and the
// Paula TikTok account added as a sandbox/target user if the app hasn't
// passed the Content Posting API audit yet. Until that audit passes,
// every post made with this token is forced to privacy_level SELF_ONLY
// regardless of what's requested — see lib/tiktok.ts.

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { URL } from "node:url";

const PORT = 8766;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/oauth/callback`;
const SCOPE = "video.publish";

const clientKey = process.env.TIKTOK_CLIENT_KEY;
const clientSecret = process.env.TIKTOK_CLIENT_SECRET;

if (!clientKey || !clientSecret) {
  throw new Error("TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET must be set");
}

const csrfState = randomBytes(16).toString("hex");

async function exchangeCodeForTokens(code: string) {
  const res = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache" },
    body: new URLSearchParams({
      client_key: clientKey!,
      client_secret: clientSecret!,
      code,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
    }),
  });
  const body = await res.json();
  if (!res.ok || body.error) {
    throw new Error(`token exchange failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return body as { access_token: string; refresh_token: string; expires_in: number };
}

function buildAuthUrl(): string {
  const url = new URL("https://www.tiktok.com/v2/auth/authorize/");
  url.searchParams.set("client_key", clientKey!);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("state", csrfState);
  return url.toString();
}

const server = createServer(async (req, res) => {
  if (!req.url?.startsWith("/oauth/callback")) {
    res.writeHead(404).end();
    return;
  }

  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    res.writeHead(400, { "Content-Type": "text/plain" }).end(`OAuth error: ${error}`);
    console.error(`OAuth error: ${error}`);
    server.close();
    process.exit(1);
  }

  if (state !== csrfState) {
    res.writeHead(400, { "Content-Type": "text/plain" }).end("State mismatch — possible CSRF, aborting.");
    console.error("state param didn't match — aborting");
    server.close();
    process.exit(1);
  }

  if (!code) {
    res.writeHead(400, { "Content-Type": "text/plain" }).end("Missing code param");
    return;
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    res
      .writeHead(200, { "Content-Type": "text/plain" })
      .end("Success — you can close this tab and return to the terminal.");

    console.log("\nREFRESH_TOKEN:", tokens.refresh_token);
    console.log("\nAdd this to .env as TIKTOK_REFRESH_TOKEN.");
    server.close();
    process.exit(0);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" }).end("Token exchange failed — see terminal.");
    console.error(err);
    server.close();
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log(`Listening on ${REDIRECT_URI}\n`);
  console.log("Open this URL, sign in with the Paula TikTok account, and approve:\n");
  console.log(buildAuthUrl());
  console.log("");
});
