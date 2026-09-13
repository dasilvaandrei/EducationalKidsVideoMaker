// One-time (or periodic) manual OAuth bootstrap for TikTok's Content
// Posting API. Not part of the automated pipeline: run it by hand
// whenever TIKTOK_REFRESH_TOKEN needs replacing.
//
// TikTok's redirect_uri must be an HTTPS URL on a verified domain — it
// cannot be a loopback address (http://127.0.0.1/...) on any platform,
// confirmed against the sibling videoMaker project's working setup. So
// this is a Web-platform app, not Desktop: this script prints the
// authorization URL for you to open, and TikTok redirects the browser to
// the static docs/oauth-callback.html page (served via GitHub Pages at
// kidsvideomaker.andreidasilva.com — same page reused for the Instagram
// bootstrap), which displays the returned `code` for you to paste back
// here.
//
// Prerequisite: a TikTok developer app registered at developers.tiktok.com
// with the Content Posting API product added, requesting both video.upload
// and video.publish scopes, Website URL
// https://kidsvideomaker.andreidasilva.com, Redirect URI
// https://kidsvideomaker.andreidasilva.com/oauth-callback.html, and the
// Paula TikTok account added as a sandbox/target user. publish-episode.ts
// currently only uses video.upload (inbox/draft uploads — see
// lib/tiktok.ts) since a brand-new unaudited app gets hard-rejected by
// Direct Post; video.publish is requested up front anyway so the same
// token works once the Content Posting API audit passes and
// publish-episode.ts switches back to uploadTiktokVideo, no re-auth
// needed.
//
// IMPORTANT: TikTok can rotate the refresh_token on every use (see
// lib/tiktok.ts) — the value printed here is only good until the next
// refresh, at which point whatever new value that refresh call returns
// must replace it in .env and the GitHub secret.

import { createInterface } from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { buildAuthorizationUrl, exchangeCodeForTokens } from "../lib/tiktok.js";

const REDIRECT_URI = "https://kidsvideomaker.andreidasilva.com/oauth-callback.html";

async function main() {
  const state = randomUUID();
  const authUrl = buildAuthorizationUrl(REDIRECT_URI, state);

  console.log("Open this URL, log in as the Paula TikTok account, and approve:\n");
  console.log(authUrl);
  console.log("\nAfter approving, the browser lands on the callback page showing a code.");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const code = (await rl.question("\nPaste the code here: ")).trim();
  rl.close();

  const tokens = await exchangeCodeForTokens(code, REDIRECT_URI);

  console.log("\nACCESS_TOKEN:", tokens.accessToken, "(valid 24h — not saved anywhere, use tiktok-upload-test.ts instead)");
  console.log("REFRESH_TOKEN:", tokens.refreshToken, "(valid 365 days, may rotate on next refresh)");
  console.log("OPEN_ID:", tokens.openId);
  console.log("\nAdd the refresh token to .env as TIKTOK_REFRESH_TOKEN, and to the GitHub Actions secret of the same name.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
