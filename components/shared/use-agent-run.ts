"use client";

import { useEffect, useState } from "react";

/**
 * Which agent the server thinks is running for this project.
 *
 * A run outlives the component that started it: navigate away mid-run and the
 * agent keeps working, but a remounted screen knew nothing about it, unlocked
 * its buttons and invited a second run onto a GPU already busy with the first.
 * The server holds the truth, so both the Agentic Canvas and the Storyboard
 * screen read it back from here rather than trusting their own state.
 *
 * `onFinished` fires when a run this hook was watching disappears, which is the
 * moment there is new output worth reloading.
 */
export function useAgentRun(
  projectId: string,
  onFinished?: () => void,
): { agentKey: string | null; agentName: string | null } {
  const [run, setRun] = useState<{ agentKey: string; agentName: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/agent-run`, { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const { run: next } = (await res.json()) as {
          run: { agentKey: string; agentName: string } | null;
        };
        if (cancelled) return;
        setRun((current) => {
          if (current && !next) onFinished?.();
          return next;
        });
      } catch {
        // Transient: the next tick tries again.
      } finally {
        if (!cancelled) timer = setTimeout(() => void poll(), 3000);
      }
    };

    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `onFinished` is deliberately not a dependency: callers pass an inline
    // closure, and re-subscribing on every render would restart the poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  return { agentKey: run?.agentKey ?? null, agentName: run?.agentName ?? null };
}
