"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLoadEffect } from "@/components/shared/use-load-effect";
import type { SceneCheck, SceneCheckDepth, SceneChecks } from "@/lib/schemas/scene-check";
import type { SceneCheckProgress, SceneCheckSummary } from "@/lib/services/scene-check-service";

export type SceneChecksData = {
  checks: SceneChecks;
  status: SceneCheckSummary;
  progress: SceneCheckProgress;
};

async function errorText(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `${fallback} (HTTP ${res.status})`;
}

/**
 * Scene checks for one project: results, live status and run control.
 *
 * Re-fetched whenever `version` changes — the project's `updatedAt` — because
 * any edit can put a result out of date, and the server is what decides that.
 * Polls only while checks are running or a checked rerun is waiting on them.
 */
export function useSceneChecks(
  projectId: string,
  version: string | undefined,
  options: { onRendersQueued?: () => void } = {},
) {
  const [data, setData] = useState<SceneChecksData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rendersQueued = useRef(options.onRendersQueued);
  useEffect(() => {
    rendersQueued.current = options.onRendersQueued;
  });
  const followUpState = useRef<string | undefined>(undefined);

  const refresh = useCallback(async (isCurrent: () => boolean = () => true, version?: string) => {
    try {
      const query = version ? `?v=${encodeURIComponent(version)}` : "";
      const res = await fetch(`/api/projects/${projectId}/scene-checks${query}`, { cache: "no-store" });
      if (!res.ok || !isCurrent()) return;
      const next = (await res.json().catch(() => null)) as SceneChecksData | null;
      // Anything without the expected shape — an older server, a proxy page —
      // is ignored rather than allowed to take the storyboard down with it.
      if (!next?.progress || !next.status || !next.checks) return;
      setData(next);
      const state = next.progress.followUp?.state;
      if (followUpState.current === "waiting" && state === "queued") rendersQueued.current?.();
      followUpState.current = state;
    } catch {
      // Status is best-effort; the next poll or edit tries again.
    }
  }, [projectId]);

  // Keyed on the project's version so any edit re-reads the statuses.
  const loadForVersion = useCallback(
    (isCurrent: () => boolean) => refresh(isCurrent, version),
    [refresh, version],
  );
  useLoadEffect(loadForVersion);

  const waiting = Boolean(data?.progress.active) || data?.progress.followUp?.state === "waiting";
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => void refresh(), 2500);
    return () => window.clearInterval(timer);
  }, [waiting, refresh]);

  const run = useCallback(
    async (sceneIds: string[], depth: SceneCheckDepth, thenRender?: "keyframes" | "video") => {
      setError(null);
      try {
        const res = await fetch(`/api/projects/${projectId}/scene-checks`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sceneIds, depth, ...(thenRender ? { thenRender } : {}) }),
        });
        if (!res.ok) throw new Error(await errorText(res, "Could not start the check"));
        if (thenRender) followUpState.current = "waiting";
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not start the check");
      }
    },
    [projectId, refresh],
  );

  const cancel = useCallback(async () => {
    await fetch(`/api/projects/${projectId}/scene-checks`, { method: "DELETE" }).catch(() => null);
    await refresh();
  }, [projectId, refresh]);

  const accept = useCallback(
    async (sceneId: string, depth: SceneCheckDepth, findingId: string, accepted: boolean) => {
      setError(null);
      const res = await fetch(`/api/projects/${projectId}/scene-checks/${sceneId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ depth, findingId, accepted }),
      });
      if (!res.ok) {
        setError(await errorText(res, "Could not record that"));
        return;
      }
      const { check } = (await res.json()) as { check?: SceneCheck };
      if (check) {
        setData((current) => current && {
          ...current,
          checks: { ...current.checks, [sceneId]: { ...current.checks[sceneId], [depth]: check } },
        });
      }
      await refresh();
    },
    [projectId, refresh],
  );

  return { data, error, refresh, run, cancel, accept };
}

export type SceneChecksApi = ReturnType<typeof useSceneChecks>;
