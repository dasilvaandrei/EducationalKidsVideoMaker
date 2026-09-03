// Word-highlight captions tuned for pre-readers, not the typical fast
// adult-Shorts caption style. Two deliberate departures from the sibling
// project's HighlightClip caption approach (which has none — that project
// burns in a fixed hook/caption line, not word-synced captions):
//   - Much longer per-page hold time (SWITCH_CAPTIONS_EVERY_MS) than a
//     typical ~1.2s adult-caption switch — a 3-7 year old can't read that
//     fast, and the point of the on-screen text is reinforcement, not a
//     transcript to follow along with.
//   - A large, rounded, kid-friendly Google Font (Fredoka) instead of the
//     sibling's aggressive all-caps Anton.

import React, { useMemo } from "react";
import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig } from "remotion";
import { createTikTokStyleCaptions } from "@remotion/captions";
import type { Caption, TikTokPage } from "@remotion/captions";
import { loadFont } from "@remotion/google-fonts/Fredoka";

const { fontFamily } = loadFont("normal", { weights: ["600", "700"], subsets: ["latin"] });

const SWITCH_CAPTIONS_EVERY_MS = 3500;
const FONT_SIZE = 80;
const HIGHLIGHT_COLOR = "#FFDD57";

export type CaptionsProps = {
  captions: Caption[];
};

export const Captions: React.FC<CaptionsProps> = ({ captions }) => {
  const { fps } = useVideoConfig();

  const { pages } = useMemo(
    () => createTikTokStyleCaptions({ captions, combineTokensWithinMilliseconds: SWITCH_CAPTIONS_EVERY_MS }),
    [captions]
  );

  return (
    <AbsoluteFill>
      {pages.map((page, index) => {
        const nextPage = pages[index + 1] ?? null;
        const startFrame = Math.round((page.startMs / 1000) * fps);
        const endFrame = Math.round(
          Math.min(
            nextPage ? (nextPage.startMs / 1000) * fps : Infinity,
            startFrame + (SWITCH_CAPTIONS_EVERY_MS / 1000) * fps
          )
        );
        const durationInFrames = endFrame - startFrame;
        if (durationInFrames <= 0) return null;

        return (
          <Sequence key={index} from={startFrame} durationInFrames={durationInFrames}>
            <CaptionPage page={page} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};

const CaptionPage: React.FC<{ page: TikTokPage }> = ({ page }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const currentTimeMs = (frame / fps) * 1000;
  const absoluteTimeMs = page.startMs + currentTimeMs;

  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", paddingBottom: 120 }}>
      <div
        style={{
          fontFamily,
          fontWeight: 700,
          fontSize: FONT_SIZE,
          textAlign: "center",
          maxWidth: "85%",
          lineHeight: 1.25,
          color: "white",
          WebkitTextStroke: "6px #3A2E2E",
          paintOrder: "stroke fill",
        }}
      >
        {page.tokens.map((token) => {
          const isActive = token.fromMs <= absoluteTimeMs && token.toMs > absoluteTimeMs;
          return (
            <span key={token.fromMs} style={{ color: isActive ? HIGHLIGHT_COLOR : "white" }}>
              {token.text}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
