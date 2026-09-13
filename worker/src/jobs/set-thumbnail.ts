// Attaches a thumbnail image to a render: uploads it to Storage, records
// the path on `renders.thumbnail_path` (so publish-episode.ts's YouTube
// branch picks it up automatically for any future publish), and — if the
// episode is already published to YouTube — sets it immediately rather
// than waiting for a publish that's already happened.
//
// Deliberately NOT wired into the generate-content/render/publish
// pipeline: unlike this project's other images (mascot poses, scene
// backgrounds — see jobs/generate-assets.ts), thumbnail art is generated
// via Higgsfield, an MCP tool only available to an interactive Claude
// session, not something an unattended worker process or GitHub Actions
// cron can call. The actual image gets created by hand (or by an
// assistant session) and handed to this job as a local file — this job is
// just the "attach it" half of the workflow.
//
// Usage:
//   npm run set-thumbnail -- <render_id> <path/to/thumbnail.png>

import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { uploadYoutubeThumbnail } from "../lib/youtube.js";
import { supabase } from "../lib/supabase.js";

const MEDIA_BUCKET = "media";

interface PublishedYoutubePost {
  external_post_id: string | null;
}

function contentTypeFor(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  throw new Error(`unsupported thumbnail file extension "${ext}" — YouTube accepts JPEG or PNG`);
}

export async function setThumbnail(renderId: string, localImagePath: string): Promise<void> {
  const { data: render, error: renderError } = await supabase
    .from("renders")
    .select("id, aspect_ratio")
    .eq("id", renderId)
    .single();
  if (renderError) throw renderError;

  const contentType = contentTypeFor(localImagePath);
  const ext = extname(localImagePath).toLowerCase();
  const imageBuffer = await readFile(localImagePath);
  const storagePath = `thumbnails/${renderId}${ext}`;

  const { error: uploadError } = await supabase.storage
    .from(MEDIA_BUCKET)
    .upload(storagePath, imageBuffer, { contentType, upsert: true });
  if (uploadError) throw uploadError;

  const { error: updateError } = await supabase.from("renders").update({ thumbnail_path: storagePath }).eq("id", renderId);
  if (updateError) throw updateError;

  console.log(`set renders.thumbnail_path for ${renderId} -> ${storagePath}`);

  if (render.aspect_ratio !== "16:9") {
    console.log(`render ${renderId} is ${render.aspect_ratio}, not 16:9 — YouTube Shorts don't support thumbnails.set, so stopping here (path is still saved for reference).`);
    return;
  }

  // Look for an already-published YouTube post for this render — if the
  // episode went live before this thumbnail existed, apply it right now
  // instead of waiting for a future publish that won't happen again.
  const { data: posts, error: postsError } = await supabase
    .from("posts")
    .select("external_post_id, status, platform_accounts(platforms(name))")
    .eq("render_id", renderId)
    .eq("status", "published")
    .returns<{ external_post_id: string | null; status: string; platform_accounts: { platforms: { name: string } | { name: string }[] | null } | { platforms: { name: string } | { name: string }[] | null }[] | null }[]>();
  if (postsError) throw postsError;

  const youtubePost = (posts ?? []).find((p) => {
    const account = Array.isArray(p.platform_accounts) ? p.platform_accounts[0] : p.platform_accounts;
    const platform = Array.isArray(account?.platforms) ? account?.platforms[0] : account?.platforms;
    return platform?.name === "youtube";
  }) as PublishedYoutubePost | undefined;

  if (!youtubePost?.external_post_id) {
    console.log(`render ${renderId} isn't published to YouTube yet — thumbnail will be applied automatically next time it's published.`);
    return;
  }

  await uploadYoutubeThumbnail(youtubePost.external_post_id, imageBuffer, contentType);
  console.log(`applied thumbnail to already-published video https://youtube.com/watch?v=${youtubePost.external_post_id}`);
}

function parseArgs(argv: string[]): { renderId: string; imagePath: string } {
  const [renderId, imagePath] = argv;
  if (!renderId || !imagePath) {
    throw new Error("usage: set-thumbnail <render_id> <path/to/thumbnail.png>");
  }
  return { renderId, imagePath };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { renderId, imagePath } = parseArgs(process.argv.slice(2));
  setThumbnail(renderId, imagePath)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
