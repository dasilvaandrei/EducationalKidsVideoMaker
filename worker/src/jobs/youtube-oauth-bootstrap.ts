// One-time (or periodic — see below) manual OAuth bootstrap for YouTube
// upload access. Not part of the automated pipeline: run it by hand
// whenever a refresh token is needed.
//
// Why this exists at all: a plain API key (YOUTUBE_API_KEY) only grants
// read-only access to public data — uploading to a specific channel
// requires OAuth 2.0 user consent. This script runs the loopback
// authorization-code flow locally: it opens a listener, prints a Google
// consent URL for you to open in a browser, and exchanges the resulting
// code for a refresh token.
//
// Re-run this whenever YOUTUBE_REFRESH_TOKEN needs replacing — notably,
// while the Google Cloud OAuth app is unverified (Testing publish status),
// refresh tokens for test users expire after ~7 days (see the plan's
// YouTube setup section). This channel posts up to 7x/week on an
// unattended cron, more often than the sibling project's 1x/day, so a
// silent token death here is more disruptive — submit the app for
// verification early rather than deferring it.

import { createServer } from "node:http";
import { URL } from "node:url";

const PORT = 8765;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/oauth/callback`;
const SCOPE = "https://www.googleapis.com/auth/youtube.upload";

const clientId = process.env.YOUTUBE_CLIENT_ID;
const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  throw new Error("YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET must be set");
}

async function exchangeCodeForTokens(code: string) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId!,
      client_secret: clientSecret!,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`token exchange failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return body as { access_token: string; refresh_token?: string; expires_in: number };
}

function buildAuthUrl(): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId!);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("access_type", "offline");
  // Forces Google to issue a refresh_token even if this account already
  // granted this app access before (otherwise re-consent can silently
  // omit it).
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

const server = createServer(async (req, res) => {
  if (!req.url?.startsWith("/oauth/callback")) {
    res.writeHead(404).end();
    return;
  }

  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    res.writeHead(400, { "Content-Type": "text/plain" }).end(`OAuth error: ${error}`);
    console.error(`OAuth error: ${error}`);
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

    if (!tokens.refresh_token) {
      console.error(
        "No refresh_token in response — Google omits it on repeat consent without prompt=consent, or if this account already has one issued. Revoke prior access at https://myaccount.google.com/permissions and re-run."
      );
      server.close();
      process.exit(1);
    }

    console.log("\nREFRESH_TOKEN:", tokens.refresh_token);
    console.log("\nAdd this to .env as YOUTUBE_REFRESH_TOKEN.");
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
  console.log("Open this URL, sign in with the Google account for this channel, and approve:\n");
  console.log(buildAuthUrl());
  console.log("");
});
