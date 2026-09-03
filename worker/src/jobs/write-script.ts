// Writes an episode's script in two stages: Claude drafts a structurally-
// correct script (reliable at following hard constraints — word count,
// sentence caps, content bans), then Gemini rewrites that draft to punch
// up its entertainment value for kids while preserving those constraints.
// Gemini's rewrite is the version that actually ships (stored as `body`;
// Claude's draft is kept alongside as `draft_body` for comparison/
// debugging, not used downstream). A second, independent LLM call
// (safety-check.ts) re-invokes this file's `writeScript()` with an
// avoid-list when it flags a script, so this file has to support being
// called repeatedly for the same episode, each time producing a new
// script *version* (never an in-place edit — see the schema comment on
// `scripts`), running the full draft+rewrite pipeline again each time.

import Anthropic from "@anthropic-ai/sdk";
import { generateJson, TEXT_MODEL as GEMINI_TEXT_MODEL } from "../lib/gemini.js";
import { supabase } from "../lib/supabase.js";

const CLAUDE_MODEL = "claude-opus-5";
// Bump whenever the system prompt changes in a way that would make old
// scripts non-comparable to new ones (word-count band, structure, banned
// content list) — stored per-row so we can tell which prompt produced
// which script later.
const PROMPT_VERSION = "kids-script-v2-gemini-rewrite";

// Kids' narration lands slower than adult VO (~150 wpm) — this drives the
// target word counts below directly, so if this range ever changes the
// word count bands must be re-derived, not just the pacing comment.
const WPM_MIN = 110;
const WPM_MAX = 130;

type Format = "long_form" | "short";

interface WordCountBand {
  min: number;
  max: number;
  targetSeconds: number;
}

// long_form ≈ 5 minutes (300s) at 110-130 wpm -> ~550-650 words.
// short ≈ 45s at 110-130 wpm -> ~85-110 words, comfortably under YouTube's
// Shorts ceiling once the mascot intro/outro padding is added in Remotion.
const WORD_COUNT_BANDS: Record<Format, WordCountBand> = {
  long_form: { min: 550, max: 650, targetSeconds: 300 },
  short: { min: 85, max: 110, targetSeconds: 45 },
};

// A word count outside this multiple of the band counts as "wildly off"
// and triggers the one automated retry, per the plan's QA step — small
// misses (a script that comes back at 640 instead of ≤650) aren't worth
// retrying since padding/trimming a few words in review is cheap.
const WILD_MISS_FACTOR = 1.3;

interface TopicRow {
  id: string;
  category: string;
  title: string;
  key_vocabulary: string[];
  target_age_min: number;
  target_age_max: number;
}

interface EpisodeRow {
  id: string;
  topic_id: string;
  format: Format;
  topics: TopicRow | TopicRow[] | null;
}

function topicOf(episode: EpisodeRow): TopicRow {
  const topic = Array.isArray(episode.topics) ? episode.topics[0] : episode.topics;
  if (!topic) throw new Error(`episode ${episode.id} has no joined topic`);
  return topic;
}

export interface ScriptContent {
  titleSuggestion: string;
  body: string;
  keyVocabulary: string[];
  callAndResponseMoments: string[];
  topicSceneAnchor: string;
  homeSceneAnchor: string;
  wordCount: number;
  estimatedDurationSeconds: number;
  model: string;
  promptVersion: string;
}

// Fixed across every script — locks in consistency and matters
// mechanically: the counting-quantity display (TopicDisplay.tsx) always
// illustrates a number by showing that many pictures of the mascot
// itself, so the script needs to reliably call the mascot the same name
// every time for "count N Paulas" framing to make sense.
const MASCOT_NAME = "Paula";

function buildSystemPrompt(topic: TopicRow, format: Format, avoidList: string[]): string {
  const band = WORD_COUNT_BANDS[format];

  const avoidSection =
    avoidList.length > 0
      ? `\n\nA PREVIOUS DRAFT OF THIS SCRIPT WAS REJECTED BY AN AUTOMATED SAFETY REVIEW. You must avoid all of the following in this new draft:\n${avoidList
          .map((reason) => `- ${reason}`)
          .join("\n")}\nWrite a genuinely different approach to the topic that steers clear of these issues — do not just reword the same content.`
      : "";

  return `You are the scriptwriter for a children's educational YouTube channel aimed at kids aged ${topic.target_age_min}-${topic.target_age_max}. You write for a friendly on-screen penguin mascot named "${MASCOT_NAME}" who greets the viewer, teaches one concept, and says goodbye. Always call the mascot "${MASCOT_NAME}" — never a different name.

TOPIC FOR THIS EPISODE: "${topic.title}" (curriculum category: ${topic.category})
AVAILABLE VOCABULARY: ${topic.key_vocabulary.length > 0 ? topic.key_vocabulary.join(", ") : "(choose 2-4 simple words central to this topic)"}
Pick ONE of these as this episode's hero word — the single word/concept the episode visually centers on (its picture will stay on screen for the whole episode, the way a picture book has one subject). You may still mention 1-2 of the other words in passing as brief supporting examples, but do not give them their own equally-weighted teaching segment the way the hero word gets. In key_vocabulary, list the hero word FIRST, followed by at most one or two supporting words actually used — this episode should read as being about ONE thing, not three or four.

FORMAT: ${format === "long_form" ? "long-form episode (~5 minutes)" : "YouTube Short (~45 seconds)"}
TARGET LENGTH: ${band.min}-${band.max} words. This is a hard requirement — kids' narration is spoken slowly (${WPM_MIN}-${WPM_MAX} words per minute, much slower than adult narration) and the target video length is fixed, so under- or over-shooting the word count directly breaks the video's pacing. Count your words before finishing and adjust.

WRITING RULES (follow all of these — they are production requirements, not suggestions):
1. Sentence length: cap every sentence at 8-10 words. Short, simple, complete sentences a 3-7 year old can follow by ear.
2. Vocabulary repetition: the hero word must appear 4-6 times across the script, in different sentences, so it sticks — it's the one thing this episode is about. Any supporting word you mention only needs 1-2 brief appearances.
3. Call-and-response: include exactly one call-and-response beat, marked with the literal tag "[PAUSE FOR RESPONSE]" immediately after the mascot asks the viewer a question (e.g. "Can you point to something red? [PAUSE FOR RESPONSE]"). List every such moment (the question text, without the tag) in call_and_response_moments.
4. Rhyme is welcome when it happens naturally, but never force a rhyme at the cost of a confusing or unnatural sentence.
5. Vocabulary level: never use a word harder than the concept you're teaching requires. If you must use a slightly advanced word, define it in the same breath in simple terms.

VISUAL GROUNDING — read carefully, this is a hard requirement:
This video can only actually show a small, fixed set of things: ${MASCOT_NAME} the penguin (always on screen), the living-room/topic-scene background, a real photo of THIS episode's hero word (only if it's a concrete object — most are), a solid color swatch when a color name is spoken, and — when a number word is spoken — that many small pictures of ${MASCOT_NAME} popping up (so "five" makes five little ${MASCOT_NAME}s appear). Nothing else you write will have any picture, animation, or visual to match it.
- NEVER say "look at", "do you see", "can you see", or similar phrases about anything that isn't one of those things above. Do not invent or reference animals, objects, scenes, or props this system cannot show (e.g. never invent ducks, other animals, or props to "look at") — the viewer will see nothing there and it will be confusing. It IS fine to say "look" or "watch" about ${MASCOT_NAME}'s own visible actions (waving, clapping, pointing) since ${MASCOT_NAME} is always on screen.
- When illustrating a quantity/counting moment, count ${MASCOT_NAME} — e.g. "Can you count five ${MASCOT_NAME}s with me?" or "One ${MASCOT_NAME}, two ${MASCOT_NAME}s, three ${MASCOT_NAME}s!" — never invent a different animal or object to count, since only ${MASCOT_NAME} actually appears on screen for a count.
- Do not use "count"/"counting"/"number"/"numbers" themselves as key_vocabulary entries — they're abstract/meta words with no meaningful photo, not the concrete hero word.

FIXED STRUCTURE (follow this order exactly):
1. Mascot greeting — warm, upbeat, in-character hello.
2. Topic intro — tell the viewer what we're learning about today.
3. Teaching with repetition — the core content, repeating key vocabulary per rule 2.
4. One call-and-response beat (per rule 3).
5. Recap — briefly restate what was learned.
6. Closing catchphrase — a warm, consistent sign-off.
Do NOT include a "subscribe" call-to-action or any clickable-button language — this channel is Made for Kids, and YouTube strips clickable end-cards/subscribe buttons from that content anyway, so scripting one wastes the moment.

HARD CONTENT BANS — the following must never appear, under any circumstances:
- Anything scary or frightening (monsters, danger, threats, jump-scare pacing).
- Violence or aggressive conflict of any kind, even cartoonish.
- Unsafe behavior a young child could imitate (climbing something dangerous, touching something hot, going somewhere alone, etc.).
- Product or brand pitches, junk food, or anything that reads as an ad.
- Sad, traumatic, or grief-related themes.
- Anything that could be dangerously misread by a young child taking it literally (no "just kidding" reveals about something that sounded true and alarming).
This list is enforced again by a separate automated safety check after you write — treat it as a hard requirement here too, not something the other system will catch for you.${avoidSection}

SCENE ANCHORS: This channel's video always starts in a living room, cuts to a scene about the topic while the teaching content plays, then cuts back to the living room for the closing. You must mark exactly where those two cuts happen by quoting two short verbatim snippets FROM YOUR OWN script_body:
- topic_scene_anchor: the first few words (roughly 4-8 words) of the sentence where the teaching content begins — right where structure step 2/3 above starts, immediately after the greeting ends (e.g. "Today we are learning about"). This is where the video cuts from the living room to the topic scene.
- home_scene_anchor: the first few words of the sentence where the recap begins — structure step 5 above (e.g. "Now let's remember what we learned"). This is where the video cuts back to the living room.
Both must be copied character-for-character out of script_body exactly as you wrote it — not paraphrased, not summarized — because they are matched against the real spoken words later.

OUTPUT: Call the submit_script tool exactly once with the finished script. script_body should be the full narration text including the "[PAUSE FOR RESPONSE]" tag inline where it belongs — do not add speaker labels, stage directions, or scene headings.`;
}

interface AnthropicClientLike {
  messages: {
    create: (params: any) => Promise<any>;
  };
}

const SUBMIT_SCRIPT_TOOL = {
  name: "submit_script",
  description: "Submit the finished episode script.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      title_suggestion: { type: "string", description: "A short, friendly episode title." },
      script_body: { type: "string", description: "The full narration text, including [PAUSE FOR RESPONSE] tags inline." },
      key_vocabulary: { type: "array", items: { type: "string" }, description: "The vocabulary words actually taught in this script." },
      call_and_response_moments: {
        type: "array",
        items: { type: "string" },
        description: "The question text of each call-and-response beat, without the [PAUSE FOR RESPONSE] tag.",
      },
      topic_scene_anchor: {
        type: "string",
        description:
          "The first few words of the sentence where the teaching content begins (right after the greeting), copied verbatim from script_body.",
      },
      home_scene_anchor: {
        type: "string",
        description:
          "The first few words of the sentence where the closing recap begins, copied verbatim from script_body.",
      },
    },
    required: [
      "title_suggestion",
      "script_body",
      "key_vocabulary",
      "call_and_response_moments",
      "topic_scene_anchor",
      "home_scene_anchor",
    ],
    additionalProperties: false,
  },
} as const;

function countWords(text: string): number {
  return text
    .replace(/\[PAUSE FOR RESPONSE\]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

async function callClaudeForScript(
  client: AnthropicClientLike,
  topic: TopicRow,
  format: Format,
  avoidList: string[]
): Promise<ScriptContent> {
  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 4096,
    system: buildSystemPrompt(topic, format, avoidList),
    messages: [
      {
        role: "user",
        content: `Write the script now for the topic "${topic.title}".`,
      },
    ],
    tools: [SUBMIT_SCRIPT_TOOL],
    tool_choice: { type: "tool", name: "submit_script" },
  });

  const toolUse = response.content.find((block: any) => block.type === "tool_use");
  if (!toolUse) {
    throw new Error("Claude did not return a submit_script tool call");
  }

  const input = toolUse.input as {
    title_suggestion: string;
    script_body: string;
    key_vocabulary: string[];
    call_and_response_moments: string[];
    topic_scene_anchor: string;
    home_scene_anchor: string;
  };

  const wordCount = countWords(input.script_body);
  const estimatedDurationSeconds = (wordCount / ((WPM_MIN + WPM_MAX) / 2)) * 60;

  // Non-fatal: render-episode.ts's anchor matching already falls back to
  // duration-percentage timing when an anchor doesn't match the real
  // captions, so a bad anchor here shouldn't fail script generation — just
  // flag it loudly so it's visible while the script is still fresh.
  if (!input.script_body.includes(input.topic_scene_anchor)) {
    console.warn(`write-script: topic_scene_anchor "${input.topic_scene_anchor}" is not a verbatim substring of script_body`);
  }
  if (!input.script_body.includes(input.home_scene_anchor)) {
    console.warn(`write-script: home_scene_anchor "${input.home_scene_anchor}" is not a verbatim substring of script_body`);
  }

  return {
    titleSuggestion: input.title_suggestion,
    body: input.script_body,
    keyVocabulary: input.key_vocabulary,
    callAndResponseMoments: input.call_and_response_moments,
    topicSceneAnchor: input.topic_scene_anchor,
    homeSceneAnchor: input.home_scene_anchor,
    wordCount,
    estimatedDurationSeconds,
    model: CLAUDE_MODEL,
    promptVersion: PROMPT_VERSION,
  };
}

function isWildlyOffBand(wordCount: number, format: Format): boolean {
  const band = WORD_COUNT_BANDS[format];
  const lowerBound = band.min / WILD_MISS_FACTOR;
  const upperBound = band.max * WILD_MISS_FACTOR;
  return wordCount < lowerBound || wordCount > upperBound;
}

interface GeminiRewriteOutput {
  title_suggestion: string;
  script_body: string;
  key_vocabulary: string[];
  call_and_response_moments: string[];
  topic_scene_anchor: string;
  home_scene_anchor: string;
}

const REWRITE_JSON_SCHEMA = {
  type: "object",
  properties: {
    title_suggestion: { type: "string" },
    script_body: { type: "string" },
    key_vocabulary: { type: "array", items: { type: "string" } },
    call_and_response_moments: { type: "array", items: { type: "string" } },
    topic_scene_anchor: { type: "string" },
    home_scene_anchor: { type: "string" },
  },
  required: [
    "title_suggestion",
    "script_body",
    "key_vocabulary",
    "call_and_response_moments",
    "topic_scene_anchor",
    "home_scene_anchor",
  ],
  additionalProperties: false,
} as const;

function buildRewriteSystemInstruction(topic: TopicRow, format: Format, feedback?: string): string {
  const band = WORD_COUNT_BANDS[format];
  return `You are a script doctor for a children's educational YouTube show (ages ${topic.target_age_min}-${topic.target_age_max}). You will be given a working draft of an episode script. Rewrite it to be noticeably more fun, engaging, and entertaining for young children — sharper hooks, more warmth and personality, playful phrasing a kid will love hearing read aloud — while strictly preserving every one of these production requirements:

- TARGET LENGTH: ${band.min}-${band.max} words. Count carefully before finishing.
- Sentence length: every sentence capped at 8-10 words, simple enough for a 3-7 year old to follow by ear.
- Keep the same hero word/topic focus and the same factual content — you are polishing the writing and performance, not changing what's being taught.
- Preserve the exact structure: mascot greeting -> topic intro -> teaching with repetition -> exactly one call-and-response beat (marked with the literal tag "[PAUSE FOR RESPONSE]" immediately after the mascot asks the viewer a question) -> recap -> closing catchphrase.
- No "subscribe" call-to-action or clickable-button language of any kind.
- HARD CONTENT BANS, unchanged from the draft: nothing scary or frightening, no violence or aggressive conflict even cartoonish, no unsafe behavior a child could imitate, no product/brand/junk-food pitches, no sad or traumatic themes, nothing a young child could dangerously misread.
- VISUAL GROUNDING, unchanged from the draft: this video can only actually show ${MASCOT_NAME} the penguin (always on screen), the background, a real photo of the hero word, a color swatch when a color name is spoken, and — for a number word — that many little pictures of ${MASCOT_NAME}. Do NOT add or keep any "look at" / "do you see" language about anything else, and do NOT invent a different animal or object for a counting moment to count — if the draft already does this correctly, keep it that way; if you punch up a counting moment, count ${MASCOT_NAME} ("count five ${MASCOT_NAME}s"), not something else. Always call the mascot "${MASCOT_NAME}".
${feedback ? `\n${feedback}\n` : ""}
Re-derive topic_scene_anchor and home_scene_anchor from YOUR OWN rewritten script_body, not the draft's — both must be short (4-8 word) verbatim substrings of your new script_body: topic_scene_anchor is where the teaching content begins (right after the greeting ends), home_scene_anchor is where the closing recap begins. Re-derive call_and_response_moments the same way, matching whatever question you actually wrote (without the tag).

OUTPUT: valid JSON matching the required schema. script_body is the full rewritten narration including the "[PAUSE FOR RESPONSE]" tag inline — no speaker labels, stage directions, or scene headings.`;
}

async function rewriteScriptWithGemini(
  draft: ScriptContent,
  topic: TopicRow,
  format: Format,
  feedback?: string
): Promise<ScriptContent> {
  const output = await generateJson<GeminiRewriteOutput>({
    systemInstruction: buildRewriteSystemInstruction(topic, format, feedback),
    prompt: `Here is the working draft to rewrite for maximum kid-entertainment value:\n\n${draft.body}`,
    jsonSchema: REWRITE_JSON_SCHEMA,
  });

  const wordCount = countWords(output.script_body);
  const estimatedDurationSeconds = (wordCount / ((WPM_MIN + WPM_MAX) / 2)) * 60;

  // Same non-fatal fallback as the Claude draft's anchor check — see the
  // comment there.
  if (!output.script_body.includes(output.topic_scene_anchor)) {
    console.warn(`write-script: [gemini rewrite] topic_scene_anchor is not a verbatim substring of script_body`);
  }
  if (!output.script_body.includes(output.home_scene_anchor)) {
    console.warn(`write-script: [gemini rewrite] home_scene_anchor is not a verbatim substring of script_body`);
  }

  return {
    titleSuggestion: output.title_suggestion,
    body: output.script_body,
    keyVocabulary: output.key_vocabulary,
    callAndResponseMoments: output.call_and_response_moments,
    topicSceneAnchor: output.topic_scene_anchor,
    homeSceneAnchor: output.home_scene_anchor,
    wordCount,
    estimatedDurationSeconds,
    model: `${CLAUDE_MODEL}+${GEMINI_TEXT_MODEL}`,
    promptVersion: PROMPT_VERSION,
  };
}

// Exported separately from writeScript() so this can be exercised directly
// in tests without touching the database — it's a pair of LLM calls (draft
// + rewrite) plus QA retry, no Supabase reads/writes. draftBody is
// returned alongside the final content purely for storage/comparison —
// see writeScript() below.
export async function generateScriptContent(
  topic: TopicRow,
  format: Format,
  options: { avoidList?: string[]; anthropicClient?: AnthropicClientLike } = {}
): Promise<ScriptContent & { draftBody: string }> {
  const client: AnthropicClientLike = options.anthropicClient ?? new Anthropic();
  const avoidList = options.avoidList ?? [];

  const draft = await callClaudeForScript(client, topic, format, avoidList);

  let final = await rewriteScriptWithGemini(draft, topic, format);

  if (isWildlyOffBand(final.wordCount, format)) {
    console.warn(
      `write-script: gemini rewrite word count ${final.wordCount} is wildly outside the ${format} target band (${WORD_COUNT_BANDS[format].min}-${WORD_COUNT_BANDS[format].max}) — retrying the rewrite once`
    );
    final = await rewriteScriptWithGemini(
      draft,
      topic,
      format,
      `Your previous rewrite came back at ${final.wordCount} words, outside the required ${WORD_COUNT_BANDS[format].min}-${WORD_COUNT_BANDS[format].max} word range. Keep the same entertainment-focused rewrite, but count carefully and land inside that range this time.`
    );

    if (isWildlyOffBand(final.wordCount, format)) {
      throw new Error(
        `write-script: gemini rewrite word count ${final.wordCount} still wildly outside the ${format} target band (${WORD_COUNT_BANDS[format].min}-${WORD_COUNT_BANDS[format].max}) after retry — failing loudly instead of shipping an unusable script`
      );
    }
  }

  return { ...final, draftBody: draft.body };
}

export interface WriteScriptOptions {
  avoidList?: string[];
}

export async function writeScript(
  episodeId: string,
  options: WriteScriptOptions = {}
): Promise<{ scriptId: string; version: number }> {
  const { data: episode, error: episodeError } = await supabase
    .from("episodes")
    .select("id, topic_id, format, topics(id, category, title, key_vocabulary, target_age_min, target_age_max)")
    .eq("id", episodeId)
    .single<EpisodeRow>();
  if (episodeError) throw episodeError;
  const topic = topicOf(episode);

  const { error: statusError } = await supabase
    .from("episodes")
    .update({ status: "scripting" })
    .eq("id", episode.id);
  if (statusError) throw statusError;

  const { data: existingScripts, error: existingError } = await supabase
    .from("scripts")
    .select("version")
    .eq("episode_id", episodeId)
    .order("version", { ascending: false })
    .limit(1);
  if (existingError) throw existingError;
  const nextVersion = existingScripts && existingScripts.length > 0 ? existingScripts[0].version + 1 : 1;

  const content = await generateScriptContent(topic, episode.format, { avoidList: options.avoidList });

  const { data: script, error: insertError } = await supabase
    .from("scripts")
    .insert({
      episode_id: episodeId,
      version: nextVersion,
      title_suggestion: content.titleSuggestion,
      body: content.body,
      draft_body: content.draftBody,
      key_vocabulary: content.keyVocabulary,
      call_and_response_moments: content.callAndResponseMoments,
      topic_scene_anchor: content.topicSceneAnchor,
      home_scene_anchor: content.homeSceneAnchor,
      word_count: content.wordCount,
      estimated_duration_seconds: content.estimatedDurationSeconds,
      model: content.model,
      prompt_version: content.promptVersion,
      status: "ready_for_voice",
    })
    .select("id")
    .single();
  if (insertError) throw insertError;

  console.log(
    `wrote script v${nextVersion} for episode ${episodeId} (${content.wordCount} words, ~${Math.round(content.estimatedDurationSeconds)}s)`
  );

  return { scriptId: script.id as string, version: nextVersion };
}

function parseArgs(argv: string[]): { episodeId: string } {
  const episodeId = argv[0];
  if (!episodeId) {
    throw new Error("usage: write-script <episode_id>");
  }
  return { episodeId };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { episodeId } = parseArgs(process.argv.slice(2));
  writeScript(episodeId)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
