// Read-only preview of the description publish-episode.ts will actually
// generate for this episode if the reviewer leaves "Edited description"
// blank. This is a deliberate duplicate of
// worker/src/jobs/publish-episode.ts's buildDescription/plainSummary —
// the dashboard and worker are separate npm workspaces with no shared
// package yet, so keep this in sync by hand if that function changes.
const CURRICULUM_HASHTAGS = ["kidslearning", "preschool", "earlylearning"];
const CHANNEL_NAME = "Paula the Penguin Learns";
const CHANNEL_HANDLE = "@paulathepenguinlearns";

function plainSummary(scriptBody: string | null): string {
  if (!scriptBody) return "Join us for a fun lesson made just for kids!";
  const clean = scriptBody
    .replace(/\[PAUSE FOR RESPONSE\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const firstTwoSentences = clean.split(/(?<=[.!?])\s+/).slice(0, 2).join(" ");
  return firstTwoSentences || clean;
}

export function previewDescription(
  scriptBody: string | null,
  topicTitle: string,
  category: string,
  keyVocabulary: string[],
  format: "long_form" | "short"
): string {
  const hook = plainSummary(scriptBody);
  const vocab = keyVocabulary.slice(0, 5).join(", ");
  const learnLine = vocab
    ? `📚 Today's lesson: ${topicTitle} — new words: ${vocab}`
    : `📚 Today's lesson: ${topicTitle}`;
  const scheduleLine =
    "🐧 New adventures with Paula every Tuesday & Friday, plus a fun new Short every night!";
  const subscribeLine = `🔔 Subscribe for more: youtube.com/${CHANNEL_HANDLE}`;
  const categoryHashtag = category.replace(/_/g, "");
  const hashtags = [...CURRICULUM_HASHTAGS, categoryHashtag].map((h) => `#${h}`);
  if (format === "short") hashtags.push("#Shorts");
  const aboutBlurb = `${CHANNEL_NAME} is a channel made just for kids, with gentle songs, simple words, and lots of encouragement to count along, wave back, and join in the fun!`;

  return [hook, learnLine, [scheduleLine, subscribeLine].join("\n"), hashtags.join(" "), aboutBlurb].join(
    "\n\n"
  );
}
