"use client";

import { useState, useTransition } from "react";
import { approveRender, rejectRender } from "./actions";

export interface ReviewRender {
  render_id: string;
  episode_id: string;
  aspect_ratio: "16:9" | "9:16";
  storage_path: string | null;
  duration_seconds: number | null;
  script_id: string;
  script_body: string;
  title_suggestion: string | null;
  category: string;
  topic_title: string;
  safety_reasoning: string;
  safety_categories_flagged: string[];
  format: "long_form" | "short";
  air_slot: "tuesday_long_form" | "friday_long_form" | "nightly_short";
  created_at: string;
  videoUrl: string | null;
  previewDescriptionText: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  phonics_abcs: "Phonics / ABCs",
  counting_numbers: "Counting / Numbers",
  colors_shapes: "Colors / Shapes",
  animals: "Animals",
  science_how_things_work: "Science: How Things Work",
  emotions_manners: "Emotions / Manners",
};

const AIR_SLOT_LABELS: Record<string, string> = {
  tuesday_long_form: "Tuesday long-form",
  friday_long_form: "Friday long-form",
  nightly_short: "Nightly Short",
};

const FORMAT_LABELS: Record<string, string> = {
  long_form: "Long-form (16:9, ~5 min)",
  short: "Short (9:16)",
};

function formatDuration(seconds: number | null): string {
  if (seconds == null) return "unknown length";
  const total = Math.round(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export function ReviewCard({ render }: { render: ReviewRender }) {
  const [isPending, startTransition] = useTransition();
  const [mode, setMode] = useState<"view" | "approve" | "reject">("view");
  const [editedTitle, setEditedTitle] = useState(render.title_suggestion ?? "");
  const [editedDescription, setEditedDescription] = useState("");
  const [rejectNotes, setRejectNotes] = useState("");
  const [rejectError, setRejectError] = useState<string | null>(null);
  const [done, setDone] = useState<"approved" | "rejected" | null>(null);

  if (done) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-neutral-800 bg-neutral-900 p-6 text-sm text-neutral-500">
        {done === "approved" ? "Approved." : "Rejected — routed back to script regeneration."}
      </div>
    );
  }

  const isPortrait = render.aspect_ratio === "9:16";

  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900">
      {render.videoUrl ? (
        <video
          src={render.videoUrl}
          controls
          preload="metadata"
          className={`w-full bg-black object-contain ${isPortrait ? "aspect-[9/16]" : "aspect-video"}`}
        />
      ) : (
        <div
          className={`flex w-full items-center justify-center bg-black text-sm text-neutral-600 ${isPortrait ? "aspect-[9/16]" : "aspect-video"}`}
        >
          No preview available
        </div>
      )}

      <div className="space-y-3 p-4 text-sm">
        <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
          <span>{formatDuration(render.duration_seconds)}</span>
          <span>·</span>
          <span>{FORMAT_LABELS[render.format] ?? render.format}</span>
          <span>·</span>
          <span>{AIR_SLOT_LABELS[render.air_slot] ?? render.air_slot}</span>
        </div>

        <div>
          <p className="text-xs uppercase tracking-wide text-neutral-500">
            {CATEGORY_LABELS[render.category] ?? render.category}
          </p>
          <p className="font-medium text-neutral-100">{render.topic_title}</p>
        </div>

        <div>
          <p className="text-xs uppercase tracking-wide text-neutral-500">Suggested title</p>
          <p className="text-neutral-200">{render.title_suggestion ?? "(none)"}</p>
        </div>

        <div>
          <p className="text-xs uppercase tracking-wide text-neutral-500">
            Description that will be published (auto-generated)
          </p>
          <p className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded border border-neutral-800 bg-neutral-950 p-2 text-neutral-300">
            {render.previewDescriptionText}
          </p>
        </div>

        <div>
          <p className="text-xs uppercase tracking-wide text-neutral-500">Script</p>
          <p className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded border border-neutral-800 bg-neutral-950 p-2 text-neutral-300">
            {render.script_body}
          </p>
        </div>

        {/* Deliberately shown even though this script already passed — so
            reviewers can see the automated safety gate is doing real work,
            not rubber-stamping every script. */}
        <div className="rounded border border-emerald-900 bg-emerald-950/40 p-2">
          <p className="text-xs font-medium text-emerald-400">
            Automated safety check: passed
          </p>
          <p className="mt-1 text-xs text-emerald-200/80">{render.safety_reasoning}</p>
          {render.safety_categories_flagged.length > 0 && (
            <p className="mt-1 text-xs text-emerald-200/60">
              Categories considered: {render.safety_categories_flagged.join(", ")}
            </p>
          )}
        </div>

        {mode === "approve" && (
          <div className="space-y-2 rounded border border-neutral-800 bg-neutral-950 p-2">
            <p className="text-xs text-neutral-500">
              Optional publish-metadata overrides only — these change what gets
              uploaded to YouTube, not the rendered video itself. Leave blank to
              publish with the auto-generated title/description shown above.
            </p>
            <label className="block text-xs text-neutral-500" htmlFor={`title-${render.render_id}`}>
              Edited title
            </label>
            <input
              id={`title-${render.render_id}`}
              value={editedTitle}
              onChange={(e) => setEditedTitle(e.target.value)}
              className="w-full rounded border border-neutral-700 bg-neutral-900 p-2 text-neutral-100"
            />
            <label
              className="block text-xs text-neutral-500"
              htmlFor={`description-${render.render_id}`}
            >
              Edited description
            </label>
            <textarea
              id={`description-${render.render_id}`}
              value={editedDescription}
              onChange={(e) => setEditedDescription(e.target.value)}
              rows={2}
              placeholder="Leave blank to publish the auto-generated description above"
              className="w-full rounded border border-neutral-700 bg-neutral-900 p-2 text-neutral-100"
            />
          </div>
        )}

        {mode === "reject" && (
          <div className="space-y-1">
            <p className="text-xs text-neutral-500">
              Rejecting routes this episode back to script regeneration — there
              is no in-place script edit, since the audio and burned-in
              captions already reflect this script&apos;s exact words.
            </p>
            <textarea
              value={rejectNotes}
              onChange={(e) => {
                setRejectNotes(e.target.value);
                if (rejectError) setRejectError(null);
              }}
              rows={2}
              placeholder="Why is this being rejected? (required)"
              className="w-full rounded border border-neutral-700 bg-neutral-950 p-2 text-neutral-100"
            />
            {rejectError && <p className="text-xs text-red-400">{rejectError}</p>}
          </div>
        )}

        <div className="flex flex-wrap gap-2 pt-2">
          {mode === "view" && (
            <>
              <button
                disabled={isPending}
                onClick={() => setMode("approve")}
                className="rounded bg-emerald-600 px-3 py-1.5 font-medium text-white disabled:opacity-50"
              >
                Approve
              </button>
              <button
                disabled={isPending}
                onClick={() => setMode("reject")}
                className="rounded border border-red-900 px-3 py-1.5 text-red-400 disabled:opacity-50"
              >
                Reject
              </button>
            </>
          )}

          {mode === "approve" && (
            <>
              <button
                disabled={isPending}
                onClick={() =>
                  startTransition(async () => {
                    await approveRender(
                      render.render_id,
                      editedTitle.trim() || null,
                      editedDescription.trim() || null
                    );
                    setDone("approved");
                  })
                }
                className="rounded bg-emerald-600 px-3 py-1.5 font-medium text-white disabled:opacity-50"
              >
                Confirm approve
              </button>
              <button
                disabled={isPending}
                onClick={() => setMode("view")}
                className="rounded border border-neutral-700 px-3 py-1.5 text-neutral-200 disabled:opacity-50"
              >
                Cancel
              </button>
            </>
          )}

          {mode === "reject" && (
            <>
              <button
                disabled={isPending}
                onClick={() => {
                  if (!rejectNotes.trim()) {
                    setRejectError("Rejection notes are required.");
                    return;
                  }
                  startTransition(async () => {
                    await rejectRender(render.render_id, rejectNotes);
                    setDone("rejected");
                  });
                }}
                className="rounded bg-red-700 px-3 py-1.5 font-medium text-white disabled:opacity-50"
              >
                Confirm reject
              </button>
              <button
                disabled={isPending}
                onClick={() => setMode("view")}
                className="rounded border border-neutral-700 px-3 py-1.5 text-neutral-200 disabled:opacity-50"
              >
                Cancel
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
