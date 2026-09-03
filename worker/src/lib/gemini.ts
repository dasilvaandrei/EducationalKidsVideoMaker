// Thin wrapper around Google's Gemini models: the image model (used by
// generate-assets.ts) and a structured-JSON text model (used by
// write-script.ts's Gemini rewrite pass). Deliberately NOT the SDK's newer
// `ai.interactions` surface (present in @google/genai's types but
// undocumented/unstable at time of writing) — `ai.models.generateContent`
// is the path Google's own docs and the SDK's own JSDoc examples use.

import { GoogleGenAI } from "@google/genai";

// Exported so callers can record which model produced an asset (see
// image_assets.model) without a second hard-coded copy of the string.
export const MODEL = "gemini-2.5-flash-image";
// Text model for the script-rewrite pass — Pro rather than Flash since
// this runs once per script (not per-word like the vocabulary images), so
// the higher cost is worth it for writing quality. "-latest" alias rather
// than a dated model: gemini-2.5-pro (the dated model originally used
// here) came back 404 "no longer available to new users" the first time
// this ran — dated model names get deprecated as Google ships new
// generations, so tracking the current-best Pro model avoids repeating
// that breakage.
export const TEXT_MODEL = "gemini-pro-latest";

let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (!client) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY must be set");
    client = new GoogleGenAI({ apiKey });
  }
  return client;
}

// Generates one PNG image from a text prompt, optionally conditioned on a
// reference image (passed back in as inlineData alongside the prompt) so
// Gemini keeps a consistent character/style across separate calls —
// unlike gemini-2.0-flash-preview-image-generation, this model does NOT
// need `config.responseModalities` set to get image output back; it's an
// image-out model by default and setting it wrongly has been seen to
// return only a text refusal part instead of an image.
export async function generateImage(prompt: string, referenceImage?: Buffer): Promise<Buffer> {
  const ai = getClient();

  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];
  if (referenceImage) {
    // Image part goes first, then the delta-only instruction — matches
    // the "edit this image" ordering in Google's own image-editing
    // examples, as opposed to the plain text-to-image ordering.
    parts.push({ inlineData: { mimeType: "image/png", data: referenceImage.toString("base64") } });
  }
  parts.push({ text: prompt });

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: parts,
  });

  const imagePart = response.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!imagePart?.inlineData?.data) {
    // A missing image usually means the prompt tripped a safety filter and
    // the model replied with text only instead — surface the text (if any)
    // so a failed generate-assets run says why, not just "no image".
    const textPart = response.text;
    throw new Error(
      `gemini: no image returned for prompt "${prompt.slice(0, 80)}"${textPart ? ` (model said: ${textPart.slice(0, 200)})` : ""}`
    );
  }

  return Buffer.from(imagePart.inlineData.data, "base64");
}

// Structured-JSON text generation, constrained to `jsonSchema` via Gemini's
// native response-schema support (config.responseMimeType +
// responseJsonSchema — plain JSON Schema, not the OpenAPI-flavored
// `responseSchema` field, which is fussier about what it accepts per the
// SDK's own doc comment: "If response_schema doesn't process your schema
// correctly, try response_json_schema instead").
export async function generateJson<T>(params: {
  systemInstruction: string;
  prompt: string;
  jsonSchema: Record<string, unknown>;
  model?: string;
}): Promise<T> {
  const ai = getClient();

  const response = await ai.models.generateContent({
    model: params.model ?? TEXT_MODEL,
    contents: [{ text: params.prompt }],
    config: {
      systemInstruction: params.systemInstruction,
      responseMimeType: "application/json",
      responseJsonSchema: params.jsonSchema,
    },
  });

  const text = response.text;
  if (!text) {
    throw new Error(`gemini: no text returned for prompt "${params.prompt.slice(0, 80)}"`);
  }
  return JSON.parse(text) as T;
}
