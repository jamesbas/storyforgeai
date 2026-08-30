"use client";

import type { ReactNode } from "react";

/**
 * A settings block that starts closed.
 *
 * Native `<details>`, so expand/collapse, keyboard operation and focus are the
 * browser's rather than ours. The heading stays inside `<summary>` so the page
 * can still be navigated by heading while every section is shut.
 */
export function CollapsibleSection({
  title,
  description,
  defaultOpen = false,
  testId,
  children,
}: {
  title: string;
  description?: ReactNode;
  defaultOpen?: boolean;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <details
      open={defaultOpen}
      data-testid={testId}
      className="group rounded-lg border border-white/10 bg-panel/40"
    >
      {/* Only phrasing and heading content is valid inside summary — no <div>/<p>. */}
      <summary className="grid cursor-pointer list-none grid-cols-[auto_1fr] items-start gap-x-3 rounded-lg p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent [&::-webkit-details-marker]:hidden">
        <svg
          viewBox="0 0 8 12"
          aria-hidden="true"
          className="mt-1 h-3 w-2 shrink-0 fill-slate-400 transition-transform group-open:rotate-90"
        >
          <path d="M0 0l8 6-8 6z" />
        </svg>
        <h2 className="font-semibold">{title}</h2>
        {description ? (
          <span className="col-start-2 mt-1 text-xs text-slate-500">{description}</span>
        ) : null}
      </summary>
      <div className="space-y-4 border-t border-white/10 p-4">{children}</div>
    </details>
  );
}
