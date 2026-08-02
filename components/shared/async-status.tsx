"use client";

import { useEffect, useRef, useState } from "react";

/**
 * One polite region per surface, announcing phase changes only.
 *
 * The screens here poll — the scene queue every few seconds, the canvas run
 * likewise — and putting a live region on the raw poll output would read the
 * same sentence over and over. `message` is announced when it actually changes,
 * so "Running 2 of 5" is heard once, not once per tick.
 *
 * Failures use `role="alert"`, which interrupts; everything else waits its turn.
 */
export function AsyncStatus({
  message,
  busy = false,
  failed = false,
  className = "",
}: {
  message: string | null;
  busy?: boolean;
  failed?: boolean;
  className?: string;
}) {
  const [announced, setAnnounced] = useState<string | null>(null);
  const last = useRef<string | null>(null);

  useEffect(() => {
    if (message === last.current) return;
    last.current = message;
    setAnnounced(message);
  }, [message]);

  if (!announced) return null;

  return (
    <p
      data-testid="async-status"
      role={failed ? "alert" : "status"}
      aria-live={failed ? "assertive" : "polite"}
      aria-busy={busy || undefined}
      className={`text-xs ${failed ? "text-red-300" : "text-slate-400"} ${className}`}
    >
      {announced}
    </p>
  );
}
