"use client";

import Link from "next/link";

/** The Scheduler's refusal (FR-18) starts with this, whatever it is running. */
const SCHEDULER_REFUSAL = /^The Scheduler is running /;

export function isSchedulerRefusal(message: string | null | undefined): boolean {
  return Boolean(message && SCHEDULER_REFUSAL.test(message));
}

/**
 * A run button's failure, as the server worded it.
 *
 * When the Scheduler refused the run, the message names the item it is busy
 * with; a link to the Scheduler tab is what turns that into something to act on.
 */
export function RunError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-sm text-red-300">
      {message}
      {isSchedulerRefusal(message) && (
        <>
          {" "}
          <Link href="/scheduler" className="underline underline-offset-2 hover:text-accent">
            Open the Scheduler
          </Link>
        </>
      )}
    </p>
  );
}
