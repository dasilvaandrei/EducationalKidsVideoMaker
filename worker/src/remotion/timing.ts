// Shared between Root.tsx's calculateMetadata (which needs the real frame
// count for a render) and jobs/render-episode.ts (which needs to record
// an accurate duration_seconds on the renders row without re-probing the
// rendered mp4) — keeping these in one place avoids the two drifting
// apart.
export const FPS = 30;

// Small trailing hold after the voiceover ends so the video doesn't cut
// the instant narration stops — a beat of breathing room before the frame
// YouTube grabs for its auto-thumbnail (no custom-thumbnail upload path
// without channel verification, same constraint as the sibling project's
// FREEZE_FRAMES).
export const TRAILING_HOLD_FRAMES = 15;
