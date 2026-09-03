// Automated content-safety gate — a second, independent LLM call from
// write-script.ts, deliberately not cost-optimized down (a smaller/cheaper
// model, a shared call with script generation, etc.) given this is the
// legal/reputational backstop for a channel aimed at young children. A
// 'flag' verdict must never let a script reach a human reviewer or TTS —
// enforced both here (episode -> 'safety_flagged', script -> 'superseded')
// and in the `pending_reviews` view's WHERE clause as defense-in-depth.
//
// checkScriptSafety() is exported on its own, with no Supabase access, so
// it can be exercised directly against hand-written good/bad sample
// scripts in tests without touching the database (per the plan's build
// order step 5 — "adversarially test ... before trusting it as a gate").

import Anthropic from "@anthropic-ai/sdk";
import { supabase } from "../lib/supabase.js";
import { writeScript } from "./write-script.js";

const MODEL = "claude-opus-5";

// One initial check + up to two regenerate-and-recheck cycles (3 script
// versions total) before giving up and surfacing the episode for manual
// intervention, per the plan.
const MAX_ATTEMPTS = 3;

const RUBRIC = [
  "Scary or frightening content (monsters, danger, threats, jump-scare pacing).",
  "Violence or aggressive conflict of any kind, even cartoonish.",
  "Unsafe behavior a young child could imitate (climbing something dangerous, touching something hot, going somewhere alone, etc.).",
  "Product or brand pitches, junk food, or anything that reads as an advertisement.",
  "Sad, traumatic, or grief-related themes.",
  "Content that could be dangerously misread by a young child taking it literally.",
] as const;

const SUBMIT_VERDICT_TOOL = {
  name: "submit_safety_verdict",
  description: "Submit the safety review verdict for a children's video script.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["pass", "flag"], description: "'flag' if the script violates any rubric category." },
      categories_flagged: {
        type: "array",
        items: { type: "string" },
        description: "Which rubric categories (verbatim from the rubric) this script violates. Empty if verdict is 'pass'.",
      },
      reasoning: {
        type: "string",
        description: "A short explanation of the verdict, quoting the specific line(s) of concern if flagged.",
      },
    },
    required: ["verdict", "categories_flagged", "reasoning"],
    additionalProperties: false,
  },
} as const;

function buildSystemPrompt(): string {
  return `You are the automated content-safety reviewer for a children's educational YouTube channel aimed at kids under 8. You review a finished episode script against a fixed safety rubric before it is allowed to move on to voice recording and human review.

RUBRIC — flag the script if it contains ANY of the following:
${RUBRIC.map((r, i) => `${i + 1}. ${r}`).join("\n")}

Be strict but fair: normal, gentle educational content (a story about animals, counting, colors, feelings, science) is expected and should pass. Only flag genuine violations of the rubric above, not the mere existence of a topic that is adjacent to one (e.g. teaching "big and small" animals is fine; describing an animal attacking another animal is not).

Call the submit_safety_verdict tool exactly once with your verdict.`;
}

interface AnthropicClientLike {
  messages: {
    create: (params: any) => Promise<any>;
  };
}

export interface SafetyVerdict {
  verdict: "pass" | "flag";
  categoriesFlagged: string[];
  reasoning: string;
  model: string;
}

// Pure rubric check: no database access, safe to call directly in tests
// against hand-written good/bad sample scripts.
export async function checkScriptSafety(
  scriptBody: string,
  options: { anthropicClient?: AnthropicClientLike } = {}
): Promise<SafetyVerdict> {
  const client: AnthropicClientLike = options.anthropicClient ?? new Anthropic();

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: buildSystemPrompt(),
    messages: [
      {
        role: "user",
        content: `Review this script:\n\n${scriptBody}`,
      },
    ],
    tools: [SUBMIT_VERDICT_TOOL],
    tool_choice: { type: "tool", name: "submit_safety_verdict" },
  });

  const toolUse = response.content.find((block: any) => block.type === "tool_use");
  if (!toolUse) {
    throw new Error("Claude did not return a submit_safety_verdict tool call");
  }

  const input = toolUse.input as {
    verdict: "pass" | "flag";
    categories_flagged: string[];
    reasoning: string;
  };

  return {
    verdict: input.verdict,
    categoriesFlagged: input.categories_flagged,
    reasoning: input.reasoning,
    model: MODEL,
  };
}

interface ScriptRow {
  id: string;
  episode_id: string;
  version: number;
  body: string;
}

async function latestScriptForEpisode(episodeId: string): Promise<ScriptRow> {
  const { data, error } = await supabase
    .from("scripts")
    .select("id, episode_id, version, body")
    .eq("episode_id", episodeId)
    .order("version", { ascending: false })
    .limit(1)
    .single<ScriptRow>();
  if (error) throw error;
  return data;
}

export interface SafetyCheckResult {
  scriptId: string;
  version: number;
  verdict: "pass" | "flag";
  attempts: number;
}

// Runs the safety check for an episode's latest script, and on a 'flag'
// verdict, re-invokes write-script.ts's writeScript() with the flagged
// reasoning injected as an avoid-list, looping until a script passes or
// MAX_ATTEMPTS is reached.
export async function runSafetyCheck(episodeId: string): Promise<SafetyCheckResult> {
  const avoidList: string[] = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const script = await latestScriptForEpisode(episodeId);
    const result = await checkScriptSafety(script.body);

    const { error: insertError } = await supabase.from("safety_checks").insert({
      script_id: script.id,
      verdict: result.verdict,
      categories_flagged: result.categoriesFlagged,
      reasoning: result.reasoning,
      model: result.model,
    });
    if (insertError) throw insertError;

    if (result.verdict === "pass") {
      const { error: episodeError } = await supabase
        .from("episodes")
        .update({ status: "voicing" })
        .eq("id", episodeId);
      if (episodeError) throw episodeError;

      console.log(`safety-check: episode ${episodeId} script v${script.version} PASSED on attempt ${attempt}`);
      return { scriptId: script.id, version: script.version, verdict: "pass", attempts: attempt };
    }

    console.warn(
      `safety-check: episode ${episodeId} script v${script.version} FLAGGED (attempt ${attempt}/${MAX_ATTEMPTS}): ${result.categoriesFlagged.join(", ")} — ${result.reasoning}`
    );

    const { error: supersedeError } = await supabase
      .from("scripts")
      .update({ status: "superseded" })
      .eq("id", script.id);
    if (supersedeError) throw supersedeError;

    const { error: flagError } = await supabase
      .from("episodes")
      .update({ status: "safety_flagged" })
      .eq("id", episodeId);
    if (flagError) throw flagError;

    if (attempt === MAX_ATTEMPTS) {
      console.error(
        `safety-check: episode ${episodeId} exhausted ${MAX_ATTEMPTS} attempts — leaving status='safety_flagged' for manual intervention`
      );
      return { scriptId: script.id, version: script.version, verdict: "flag", attempts: attempt };
    }

    avoidList.push(result.reasoning, ...result.categoriesFlagged.map((c) => `Rubric category previously flagged: ${c}`));
    await writeScript(episodeId, { avoidList });
  }

  // Unreachable — the loop above always returns by MAX_ATTEMPTS.
  throw new Error(`safety-check: episode ${episodeId} loop exited without a result — unreachable`);
}

function parseArgs(argv: string[]): { episodeId: string } {
  const episodeId = argv[0];
  if (!episodeId) {
    throw new Error("usage: safety-check <episode_id>");
  }
  return { episodeId };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { episodeId } = parseArgs(process.argv.slice(2));
  runSafetyCheck(episodeId)
    .then((result) => {
      process.exit(result.verdict === "pass" ? 0 : 1);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
