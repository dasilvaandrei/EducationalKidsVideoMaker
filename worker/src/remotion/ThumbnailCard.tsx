// A full-bleed "cold open" title card shown for the first few seconds of
// every episode, on top of everything else. This project has no
// custom-thumbnail upload path (see timing.ts's TRAILING_HOLD_FRAMES
// comment — YouTube's thumbnails.set requires a phone-verified channel,
// and TikTok/Instagram's content-posting APIs don't accept an arbitrary
// cover image either), so "changing the thumbnail" has to mean designing
// an actual in-video frame worth auto-picking or manually selecting from
// Studio/the app — this card is that frame, held long enough (see
// HOLD_SECONDS) to give either a wide window.
//
// Two distinct layouts per the product ask: Shorts get a punchy, giant
// tilted Paula with the topic in huge type (the classic vertical-thumbnail
// look); long-form gets a calmer "lesson card" layout so the two formats
// read as visually distinct on a channel page.

import React from "react";
import { AbsoluteFill, Img, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { loadFont } from "@remotion/google-fonts/Baloo2";

const { fontFamily } = loadFont("normal", { weights: ["700", "800"] });

const HOLD_SECONDS = 3.2;
const FADE_SECONDS = 0.6;

// Hero-word -> emoji, covering the seeded curriculum's vocabulary. Falls
// back to a per-category emoji, then a generic sparkle — this is a
// best-effort visual accent, not a complete dictionary.
const EMOJI_BY_WORD: Record<string, string> = {
  elephant: "🐘", lion: "🦁", tiger: "🐯", monkey: "🐒", cow: "🐄", pig: "🐷", chicken: "🐔",
  fish: "🐟", whale: "🐳", octopus: "🐙", bird: "🐦", butterfly: "🦋", bee: "🐝", owl: "🦉",
  bat: "🦇", dog: "🐶", puppy: "🐶", cat: "🐱", kitten: "🐱", pet: "🐾",
  root: "🌱", stem: "🌿", leaf: "🍃", plant: "🌱", seed: "🌱", sprout: "🌱", flower: "🌸",
  petal: "🌸", bloom: "🌸", tree: "🌳", fruit: "🍎", vegetable: "🥕",
  one: "1️⃣", two: "2️⃣", three: "3️⃣", four: "4️⃣", five: "5️⃣", six: "6️⃣", seven: "7️⃣",
  eight: "8️⃣", nine: "9️⃣", ten: "🔟", count: "🔢", number: "🔢",
  apple: "🍎", alligator: "🐊", ant: "🐜", ball: "⚽", bear: "🐻", cookie: "🍪", car: "🚗",
  moon: "🌙", mouse: "🐭", sun: "☀️", snake: "🐍", star: "⭐", turtle: "🐢", train: "🚂",
  red: "🔴", yellow: "🟡", blue: "🔵", green: "🟢", purple: "🟣", rainbow: "🌈", orange: "🟠",
  rain: "🌧️", cloud: "☁️", water: "💧", sky: "💙", magnet: "🧲",
  happy: "😊", sad: "😢", please: "🙏", share: "🤝", friend: "🤝", sorry: "😔", scared: "😨",
};

const EMOJI_BY_CATEGORY: Record<string, string> = {
  animals: "🐾",
  plants: "🌱",
  counting_numbers: "🔢",
  phonics_abcs: "🔤",
  colors: "🎨",
  science_how_things_work: "🔬",
  emotions_manners: "💛",
};

const DEFAULT_EMOJI = "✨";

function normalize(word: string): string {
  return word.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function emojiFor(heroWord: string, category: string): string {
  return EMOJI_BY_WORD[normalize(heroWord)] ?? EMOJI_BY_CATEGORY[category] ?? DEFAULT_EMOJI;
}

// Per-category accent gradient so different topics don't all look
// identical — falls back to a friendly warm default.
const GRADIENT_BY_CATEGORY: Record<string, [string, string]> = {
  animals: ["#F5A742", "#E4483C"],
  plants: ["#6FCB6F", "#2E9E5B"],
  counting_numbers: ["#4FB6E8", "#2E6FE0"],
  phonics_abcs: ["#F5A9C7", "#D46FA0"],
  colors: ["#9B7FD4", "#4FB6E8"],
  science_how_things_work: ["#4FB6E8", "#2B2B6B"],
  emotions_manners: ["#FFD966", "#F5A742"],
};
const DEFAULT_GRADIENT: [string, string] = ["#4FB6E8", "#2E6FE0"];

export type ThumbnailCardProps = {
  title: string;
  heroWord: string;
  category: string;
  mascotIdleSrc: string;
  mascotWaveSrc: string;
};

export const ThumbnailCard: React.FC<ThumbnailCardProps> = ({ title, heroWord, category, mascotIdleSrc, mascotWaveSrc }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isPortrait = height >= width;

  const holdFrames = Math.round(HOLD_SECONDS * fps);
  const fadeFrames = Math.round(FADE_SECONDS * fps);
  if (frame > holdFrames + fadeFrames) return null;

  const opacity = interpolate(frame, [holdFrames, holdFrames + fadeFrames], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  if (opacity <= 0) return null;

  const emoji = emojiFor(heroWord, category);
  const [gradientFrom, gradientTo] = GRADIENT_BY_CATEGORY[category] ?? DEFAULT_GRADIENT;
  const displayTitle = title.trim() || "Let's Learn Together!";

  return (
    <AbsoluteFill style={{ opacity, fontFamily }}>
      {isPortrait ? (
        <ShortThumbnail title={displayTitle} emoji={emoji} mascotSrc={mascotIdleSrc} gradientFrom={gradientFrom} gradientTo={gradientTo} />
      ) : (
        <LongFormThumbnail title={displayTitle} emoji={emoji} mascotSrc={mascotWaveSrc} gradientFrom={gradientFrom} gradientTo={gradientTo} />
      )}
    </AbsoluteFill>
  );
};

type VariantProps = { title: string; emoji: string; mascotSrc: string; gradientFrom: string; gradientTo: string };

// Shorts: a GIANT tilted Paula bursting in from the side, topic title in
// huge bold type dead center, an emoji badge for extra pop — the classic
// high-CTR vertical-thumbnail composition.
const ShortThumbnail: React.FC<VariantProps> = ({ title, emoji, mascotSrc, gradientFrom, gradientTo }) => {
  const fontSize = title.length > 26 ? 64 : title.length > 16 ? 76 : 92;

  return (
    <AbsoluteFill style={{ background: `linear-gradient(160deg, ${gradientFrom}, ${gradientTo})` }}>
      {/* Giant sideways Paula, cropped off the bottom-right like she's bursting into frame. */}
      <div
        style={{
          position: "absolute",
          right: "-22%",
          bottom: "-16%",
          width: "105%",
          aspectRatio: "1 / 1",
          transform: "rotate(-18deg)",
          filter: "drop-shadow(0 20px 30px rgba(0,0,0,0.35))",
        }}
      >
        <Img src={mascotSrc} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
      </div>

      <div style={{ position: "absolute", top: 56, left: 48, fontSize: 120, filter: "drop-shadow(0 6px 10px rgba(0,0,0,0.3))" }}>{emoji}</div>

      <AbsoluteFill style={{ justifyContent: "flex-start", alignItems: "center", paddingTop: "16%" }}>
        <div
          style={{
            fontSize,
            fontWeight: 800,
            textAlign: "center",
            width: "88%",
            lineHeight: 1.1,
            color: "white",
            WebkitTextStroke: "10px #2B2B2B",
            paintOrder: "stroke fill",
          }}
        >
          {title}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// Long-form: a calmer "lesson card" — Paula upright inside a spotlight
// badge on the left, the title on a rounded banner to the right with a
// "New Lesson" ribbon, so long-form episodes read as a distinct, more
// storybook-like series next to the punchier Shorts thumbnails.
const LongFormThumbnail: React.FC<VariantProps> = ({ title, emoji, mascotSrc, gradientFrom, gradientTo }) => {
  const fontSize = title.length > 34 ? 58 : title.length > 20 ? 68 : 80;

  return (
    <AbsoluteFill style={{ background: `linear-gradient(120deg, ${gradientTo}, ${gradientFrom})` }}>
      {/* Spotlight badge behind Paula */}
      <div
        style={{
          position: "absolute",
          left: "6%",
          top: "50%",
          transform: "translateY(-50%)",
          width: "38%",
          aspectRatio: "1 / 1",
          borderRadius: "50%",
          background: "rgba(255,255,255,0.92)",
          boxShadow: "0 0 0 18px rgba(255,255,255,0.25)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Img src={mascotSrc} style={{ width: "82%", height: "82%", objectFit: "contain" }} />
      </div>

      {/* Title banner */}
      <div
        style={{
          position: "absolute",
          right: "5%",
          top: "50%",
          transform: "translateY(-50%)",
          width: "50%",
          background: "rgba(255,255,255,0.96)",
          borderRadius: 40,
          padding: "48px 56px",
          boxShadow: "0 16px 40px rgba(0,0,0,0.25)",
        }}
      >
        <div
          style={{
            display: "inline-block",
            background: gradientTo,
            color: "white",
            fontWeight: 700,
            fontSize: 28,
            borderRadius: 999,
            padding: "8px 24px",
            marginBottom: 20,
          }}
        >
          NEW LESSON {emoji}
        </div>
        <div style={{ fontSize, fontWeight: 800, lineHeight: 1.15, color: "#2B2B2B" }}>{title}</div>
      </div>
    </AbsoluteFill>
  );
};
