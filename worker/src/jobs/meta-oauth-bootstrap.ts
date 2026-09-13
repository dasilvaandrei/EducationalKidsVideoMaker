// One-time (or ~60-day periodic) manual OAuth bootstrap for Instagram
// publishing access. Mirrors tiktok-oauth-bootstrap.ts's loopback shape
// conceptually, but Instagram's redirect_uri must be an HTTPS URL on a
// verified domain (no localhost), so this uses a static receiver page
// (docs/oauth-callback.html, served via GitHub Pages) instead of a local
// HTTP server: you approve in the browser, the page shows the returned
// `code`, and you paste it back here.
//
// Does the real OAuth authorization-code flow rather than the Meta app
// dashboard's "Generate access tokens" shortcut — see lib/meta.ts for why
// that shortcut doesn't work for this pipeline.
//
// Prerequisite: a Meta developer app registered at developers.facebook.com
// with the "Instagram API with Instagram Login" product added, this app's
// OAuth redirect URI set to https://kidsvideomaker.andreidasilva.com/oauth-callback.html,
// and the Paula Instagram Professional account added as an Instagram
// tester (Meta app dashboard -> App roles -> Roles -> Add Instagram
// Testers) and accepted from the Instagram account's own
// Settings -> Apps and websites -> Tester invites.

import { createInterface } from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { buildAuthorizationUrl, exchangeCodeForToken, exchangeForLongLivedToken } from "../lib/meta.js";

const REDIRECT_URI = "https://kidsvideomaker.andreidasilva.com/oauth-callback.html";

async function main() {
  const state = randomUUID();
  const authUrl = buildAuthorizationUrl(REDIRECT_URI, state);

  console.log("Open this URL, log in as the Paula Instagram account, and approve:\n");
  console.log(authUrl);
  console.log("\nAfter approving, the browser lands on the callback page showing a code.");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const code = (await rl.question("\nPaste the code here: ")).trim();
  rl.close();

  const shortLived = await exchangeCodeForToken(code, REDIRECT_URI);
  console.log("\nShort-lived token obtained, exchanging for a long-lived one...");

  const longLived = await exchangeForLongLivedToken(shortLived.accessToken);

  console.log("\nMETA_INSTAGRAM_USER_ID:", shortLived.userId);
  console.log("META_ACCESS_TOKEN:", longLived.accessToken, `(valid ${Math.round(longLived.expiresIn / 86400)} days)`);
  console.log("\nAdd both to .env and to the GitHub Actions secrets used by publish-short-nightly.yml.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
