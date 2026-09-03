"use client";

import { useState } from "react";
import { ReviewCard, type ReviewRender } from "./ReviewCard";

type Tab = "long_form" | "short";

const TAB_LABELS: Record<Tab, string> = {
  long_form: "Long-form",
  short: "Shorts",
};

export function ReviewTabs({ rows }: { rows: ReviewRender[] }) {
  const [tab, setTab] = useState<Tab>("long_form");
  const counts: Record<Tab, number> = {
    long_form: rows.filter((r) => r.format === "long_form").length,
    short: rows.filter((r) => r.format === "short").length,
  };
  const visible = rows.filter((r) => r.format === tab);

  return (
    <div className="space-y-6">
      <div className="flex gap-2 border-b border-neutral-800">
        {(["long_form", "short"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`border-b-2 px-3 py-2 text-sm font-medium ${
              tab === t
                ? "border-neutral-100 text-neutral-100"
                : "border-transparent text-neutral-500 hover:text-neutral-300"
            }`}
          >
            {TAB_LABELS[t]} ({counts[t]})
          </button>
        ))}
      </div>

      {visible.length === 0 && (
        <p className="text-neutral-500">Nothing to review in this tab right now.</p>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {visible.map((row) => (
          <ReviewCard key={row.render_id} render={row} />
        ))}
      </div>
    </div>
  );
}
