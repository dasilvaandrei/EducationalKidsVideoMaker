// One-time (or ~60-day periodic) manual bootstrap for Instagram Graph API
// access. Not part of the automated pipeline: run it by hand.
//
// Unlike YouTube/TikTok's full loopback OAuth flow, this project only
// needs to publish to one self-owned IG account, and per Meta's docs that
// needs no App Review — so this script skips implementing Facebook Login
// and instead expects a short-lived User Access Token pasted in, grabbed
// by hand from the Graph API Explorer (developers.facebook.com/tools/explorer):
//   1. Select your Meta app.
//   2. Get User Access Token, granting: instagram_basic,
//      instagram_content_publish, pages_show_list, pages_read_engagement.
//   3. Paste that token when this script prompts for it.
//
// This script then: exchanges it for a long-lived User token (~60 days),
// looks up the Facebook Page(s) it manages, resolves the linked Instagram
// Business Account ID for the Page matching PAULA_PAGE_NAME, and prints a
// Page access token (which, derived from a long-lived user token, doesn't
// itself expire on a fixed schedule the way the user token does — but
// re-run this periodically anyway since it can be invalidated by a
// password change or manually revoked access).

import { createInterface } from "node:readline/promises";

const GRAPH_API_VERSION = "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

const appId = process.env.META_APP_ID;
const appSecret = process.env.META_APP_SECRET;
const pageNameFilter = process.env.META_PAGE_NAME; // optional, narrows the picked Page if you manage more than one

if (!appId || !appSecret) {
  throw new Error("META_APP_ID and META_APP_SECRET must be set");
}

async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const shortLivedToken = (
    await rl.question("Paste the short-lived User Access Token from the Graph API Explorer: ")
  ).trim();
  rl.close();
  if (!shortLivedToken) throw new Error("no token entered");

  const exchangeUrl = new URL(`${GRAPH_BASE}/oauth/access_token`);
  exchangeUrl.searchParams.set("grant_type", "fb_exchange_token");
  exchangeUrl.searchParams.set("client_id", appId!);
  exchangeUrl.searchParams.set("client_secret", appSecret!);
  exchangeUrl.searchParams.set("fb_exchange_token", shortLivedToken);
  const exchangeRes = await fetch(exchangeUrl.toString());
  const exchangeBody = await exchangeRes.json();
  if (!exchangeRes.ok || exchangeBody.error) {
    throw new Error(`long-lived token exchange failed: ${exchangeRes.status} ${JSON.stringify(exchangeBody)}`);
  }
  const longLivedUserToken = exchangeBody.access_token as string;
  console.log(`\nLong-lived user token acquired (expires_in=${exchangeBody.expires_in}s)`);

  const accountsUrl = new URL(`${GRAPH_BASE}/me/accounts`);
  accountsUrl.searchParams.set("access_token", longLivedUserToken);
  const accountsRes = await fetch(accountsUrl.toString());
  const accountsBody = await accountsRes.json();
  if (!accountsRes.ok || accountsBody.error) {
    throw new Error(`/me/accounts failed: ${accountsRes.status} ${JSON.stringify(accountsBody)}`);
  }

  const pages = (accountsBody.data ?? []) as { id: string; name: string; access_token: string }[];
  if (pages.length === 0) {
    throw new Error("this user manages no Facebook Pages — link Paula's IG account to a Page first");
  }
  const page = pageNameFilter ? pages.find((p) => p.name === pageNameFilter) : pages[0];
  if (!page) {
    throw new Error(
      `no Page named "${pageNameFilter}" found — managed Pages: ${pages.map((p) => p.name).join(", ")}`
    );
  }
  if (!pageNameFilter && pages.length > 1) {
    console.warn(
      `warning: this user manages ${pages.length} Pages, picked the first ("${page.name}") — set META_PAGE_NAME to pick a specific one`
    );
  }

  const igUrl = new URL(`${GRAPH_BASE}/${page.id}`);
  igUrl.searchParams.set("fields", "instagram_business_account");
  igUrl.searchParams.set("access_token", page.access_token);
  const igRes = await fetch(igUrl.toString());
  const igBody = await igRes.json();
  if (!igRes.ok || igBody.error) {
    throw new Error(`instagram_business_account lookup failed: ${igRes.status} ${JSON.stringify(igBody)}`);
  }
  const igUserId = igBody.instagram_business_account?.id as string | undefined;
  if (!igUserId) {
    throw new Error(
      `Page "${page.name}" has no linked Instagram Business account — link Paula's IG account to this Page in Meta Business Suite first`
    );
  }

  console.log(`\nPage: ${page.name} (${page.id})`);
  console.log("\nMETA_PAGE_ACCESS_TOKEN:", page.access_token);
  console.log("META_IG_USER_ID:", igUserId);
  console.log("\nAdd both to .env.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
