"use client";

import { useCallback, useEffect, useState } from "react";
import { useAgentRun } from "@/components/shared/use-agent-run";
import Link from "next/link";
import { SceneCard } from "@/components/storyboard/scene-card";
import { CreativePlansPanel } from "@/components/storyboard/creative-plans-panel";
import { GENERATION_MODE_DOCS, SCENE_CONTINUITY_OPTIONS } from "@/lib/presets";
import type { GenerationMode, SceneContinuityMode } from "@/lib/types";
import { DEFAULT_SCENE_CONTINUITY, GENERATION_MODES, generationStages } from "@/lib/types";
import { resolveSceneLoras } from "@/lib/lora/scene-selection";
import { effectiveTriggerWords } from "@/lib/lora/trigger-words";
import type { LoraCatalog, SceneLoraOverride } from "@/lib/schemas/lora";
import type { LlmRuntimeStatus } from "@/lib/services/llm-runtime-service";
import type { PhaseProgress, SceneQueueEntry } from "@/lib/services/scene-queue";
import type { ProjectRecord } from "@/lib/schemas/storyboard";
import type { MediaDescriptor } from "@/lib/media/refs";

type QueueSnapshot = { entries: SceneQueueEntry[]; active: boolean; phase?: PhaseProgress };

/** What each phase is actually doing, in the user's terms rather than the code's. */
const PHASE_LABELS: Record<PhaseProgress["phase"], string> = {
  keyframes: "Rendering keyframes",
  face_swap: "Applying face swap",
  video: "Rendering clips",
  qc: "Scoring results",
};

export function StoryboardView({ projectId }: { projectId: string }) {
  const [record, setRecord] = useState<ProjectRecord | null>(null);
  const [media, setMedia] = useState<MediaDescriptor[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadMedia = useCallback(async () => {
    const res = await fetch(`/api/projects/${projectId}/media`);
    if (res.ok) {
      const data = (await res.json()) as { media: MediaDescriptor[] };
      setMedia(data.media);
    }
  }, [projectId]);

  const load = useCallback(async () => {
    setError(null);
    const res = await fetch(`/api/projects/${projectId}`);
    if (res.status === 404) {
      setError("Project not found");
      setRecord(null);
    } else if (res.ok) {
      setRecord((await res.json()) as ProjectRecord);
      await loadMedia();
    } else {
      setError("Failed to load project");
    }
    setLoading(false);
  }, [projectId, loadMedia]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * A storyboard run outlives this component.
   *
   * Eighteen scene cards plus their prompts is many minutes of work; leaving the
   * page and coming back showed an idle screen with the button unlocked, which
   * invited a second run onto the model already writing the first.
   */
  const { agentKey: remoteAgent, agentName: remoteAgentName } = useAgentRun(
    projectId,
    () => void load(),
  );
  const generating = busy || remoteAgent === "storyboard";

  /**
   * Surface what the backend actually said.
   *
   * Generation failures are usually WanGP's own words — an out-of-memory
   * profile hint, a missing reference file, a busy session — and every one of
   * them is actionable. Replacing that with "failed to generate" throws away
   * the only useful part of the response.
   */
  const failureMessage = useCallback(
    async (res: Response, fallback: string): Promise<string> => {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      return data.error ?? `${fallback} (HTTP ${res.status} ${res.statusText})`;
    },
    [],
  );

  const generate = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/generate-storyboard`, { method: "POST" });
      if (!res.ok) throw new Error(await failureMessage(res, "Failed to generate storyboard"));
      setRecord((await res.json()) as ProjectRecord);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to generate storyboard");
    } finally {
      setBusy(false);
    }
  }, [projectId, failureMessage]);

  const [sceneBusy, setSceneBusy] = useState<string | null>(null);
  const [llm, setLlm] = useState<LlmRuntimeStatus | null>(null);
  const [llmBusy, setLlmBusy] = useState<null | "load" | "unload">(null);
  const [queue, setQueue] = useState<QueueSnapshot | null>(null);
  const [queueBusy, setQueueBusy] = useState(false);
  /**
   * LoRA catalogs, fetched once per model rather than per scene. They are only
   * needed to look up trigger words, which every scene shares.
   */
  const [loraCatalogs, setLoraCatalogs] = useState<{ image?: LoraCatalog; video?: LoraCatalog }>({});

  const loadLlmStatus = useCallback(async () => {
    try {
      // `no-store` matters here: without it the browser can answer Refresh from
      // its own cache and report a model as unloaded when it is resident.
      const res = await fetch("/api/llm/status", { cache: "no-store" });
      if (res.ok) setLlm((await res.json()) as LlmRuntimeStatus);
    } catch {
      // Runtime control is optional; the storyboard works without it.
    }
  }, []);

  useEffect(() => {
    void loadLlmStatus();
  }, [loadLlmStatus]);

  // Trigger words come from the LoRA catalog, so it is fetched once per kind and
  // shared across every scene card.
  useEffect(() => {
    void (async () => {
      const fetchCatalog = async (kind: "image" | "video") => {
        try {
          const res = await fetch(`/api/wangp/loras?projectId=${projectId}&kind=${kind}`, {
            cache: "no-store",
          });
          return res.ok ? ((await res.json()) as LoraCatalog) : undefined;
        } catch {
          return undefined;
        }
      };
      const [image, video] = await Promise.all([fetchCatalog("image"), fetchCatalog("video")]);
      setLoraCatalogs({ image, video });
    })();
  }, [projectId]);

  /**
   * Planning and generation both want the GPU, and on a single card they do not
   * fit together. Unloading between the two phases is what keeps a render from
   * failing with an out-of-memory hint.
   */
  const llmAction = useCallback(
    async (action: "load" | "unload") => {
      setLlmBusy(action);
      setError(null);
      try {
        const res = await fetch(`/api/llm/${action}`, { method: "POST" });
        if (!res.ok) throw new Error(await failureMessage(res, `Failed to ${action} the model`));
        setLlm((await res.json()) as LlmRuntimeStatus);
      } catch (e) {
        setError(e instanceof Error ? e.message : `Failed to ${action} the model`);
      } finally {
        setLlmBusy(null);
      }
    },
    [failureMessage],
  );

  /**
   * Continuity only affects scenes generated from here on, so it stays editable
   * for the life of the project and needs no regeneration to take effect.
   */
  const setContinuity = useCallback(
    async (mode: SceneContinuityMode) => {
      setError(null);
      try {
        const res = await fetch(`/api/projects/${projectId}/models`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sceneContinuity: mode }),
        });
        if (!res.ok) throw new Error(`Failed to save continuity (HTTP ${res.status})`);
        setRecord((await res.json()) as ProjectRecord);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to save continuity");
      }
    },
    [projectId],
  );

  /**
   * How far the pipeline may run. Editable because the answer changes as a
   * project matures — you plan first, then decide to render.
   */
  const setGenerationMode = useCallback(
    async (mode: GenerationMode) => {
      setError(null);
      try {
        const res = await fetch(`/api/projects/${projectId}/models`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ generationMode: mode }),
        });
        if (!res.ok) throw new Error(`Failed to save generation mode (HTTP ${res.status})`);
        setRecord((await res.json()) as ProjectRecord);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to save generation mode");
      }
    },
    [projectId],
  );

  /**
   * Save one scene's LoRA override.
   *
   * The whole map is sent because the patch replaces it wholesale. A scene that
   * goes back to inheriting drops out of the map entirely rather than being
   * stored as an empty override, so the record does not accumulate entries that
   * say nothing.
   */
  const saveSceneLoras = useCallback(
    async (sceneId: string, override: SceneLoraOverride) => {
      setError(null);
      setSceneBusy(sceneId);
      try {
        const current = { ...(record?.project.sceneLoras ?? {}) };
        if (override.mode === "override") current[sceneId] = override;
        else delete current[sceneId];

        const res = await fetch(`/api/projects/${projectId}/models`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sceneLoras: current }),
        });
        if (!res.ok) {
          const detail = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(detail?.error ?? `Failed to save scene LoRAs (HTTP ${res.status})`);
        }
        setRecord((await res.json()) as ProjectRecord);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to save scene LoRAs");
      } finally {
        setSceneBusy(null);
      }
    },
    [projectId, record],
  );

  /**
   * Batch generation runs server-side so closing the tab does not abandon it,
   * and strictly in scene order so the continuity modes can read the previous
   * scene's finished attempt. The page just polls for progress.
   */
  const loadQueue = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/queue`, { cache: "no-store" });
      if (res.ok) setQueue((await res.json()) as QueueSnapshot);
    } catch {
      // Progress polling is best-effort.
    }
  }, [projectId]);

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  // Poll only while work is outstanding, and refresh the record as scenes land.
  useEffect(() => {
    if (!queue?.active) return;
    const timer = window.setInterval(() => {
      void loadQueue();
      void load();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [queue?.active, loadQueue, load]);

  const generateAll = useCallback(
    async (includeGenerated: boolean) => {
      setQueueBusy(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/projects/${projectId}/queue${includeGenerated ? "?all=1" : ""}`,
          { method: "POST" },
        );
        if (!res.ok) throw new Error(await failureMessage(res, "Failed to queue scenes"));
        setQueue((await res.json()) as QueueSnapshot);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to queue scenes");
      } finally {
        setQueueBusy(false);
      }
    },
    [projectId, failureMessage],
  );

  const cancelQueue = useCallback(async () => {
    setQueueBusy(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/queue`, { method: "DELETE" });
      if (res.ok) setQueue((await res.json()) as QueueSnapshot);
    } catch {
      // Cancelling is best-effort; the running scene finishes either way.
    } finally {
      setQueueBusy(false);
    }
  }, [projectId]);

  const generateSceneMedia = useCallback(
    async (sceneId: string) => {
      setSceneBusy(sceneId);
      setError(null);
      try {
        const res = await fetch(`/api/projects/${projectId}/scenes/${sceneId}/generate`, {
          method: "POST",
        });
        if (!res.ok) throw new Error(await failureMessage(res, "Failed to generate scene media"));
        setRecord((await res.json()) as ProjectRecord);
        await loadMedia();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to generate scene media");
      } finally {
        setSceneBusy(null);
      }
    },
    [projectId, loadMedia, failureMessage],
  );

  /**
   * Render one keyframe so a prompt, model or LoRA change can be judged without
   * paying for the whole scene. Stored as a preview, so it does not disturb the
   * scene's attempts or its approval state.
   */
  const generateSceneKeyframe = useCallback(
    async (sceneId: string, purpose: "start_frame" | "end_frame") => {
      setSceneBusy(sceneId);
      setError(null);
      try {
        const res = await fetch(`/api/projects/${projectId}/scenes/${sceneId}/keyframe`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ purpose }),
        });
        if (!res.ok) throw new Error(await failureMessage(res, "Failed to render the keyframe"));
        setRecord((await res.json()) as ProjectRecord);
        await loadMedia();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to render the keyframe");
      } finally {
        setSceneBusy(null);
      }
    },
    [projectId, loadMedia, failureMessage],
  );

  /** Previews are a scratch pad; this is how they get cleared away. */
  const clearScenePreviews = useCallback(
    async (sceneId: string) => {
      setSceneBusy(sceneId);
      setError(null);
      try {
        const res = await fetch(`/api/projects/${projectId}/scenes/${sceneId}/keyframe`, {
          method: "DELETE",
        });
        if (!res.ok) throw new Error(await failureMessage(res, "Failed to remove the previews"));
        setRecord((await res.json()) as ProjectRecord);
        await loadMedia();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to remove the previews");
      } finally {
        setSceneBusy(null);
      }
    },
    [projectId, loadMedia, failureMessage],
  );

  /** A pinned seed makes regeneration reproduce; this is the way out of that. */
  const newSceneSeed = useCallback(
    async (sceneId: string) => {
      setSceneBusy(sceneId);
      setError(null);
      try {
        const res = await fetch(`/api/projects/${projectId}/scenes/${sceneId}/seed`, {
          method: "DELETE",
        });
        if (!res.ok) throw new Error(await failureMessage(res, "Failed to take a new seed"));
        setRecord((await res.json()) as ProjectRecord);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to take a new seed");
      } finally {
        setSceneBusy(null);
      }
    },
    [projectId, failureMessage],
  );

  const setFaceVisible = useCallback(
    async (sceneId: string, subjectFaceVisible: boolean) => {
      setSceneBusy(sceneId);
      setError(null);
      try {
        const res = await fetch(`/api/projects/${projectId}/scenes/${sceneId}/framing`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ subjectFaceVisible }),
        });
        if (!res.ok) throw new Error(await failureMessage(res, "Failed to update framing"));
        setRecord((await res.json()) as ProjectRecord);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to update framing");
      } finally {
        setSceneBusy(null);
      }
    },
    [projectId, failureMessage],
  );

  const swapSceneFace = useCallback(
    async (sceneId: string, purpose: "start_frame" | "end_frame") => {
      setSceneBusy(sceneId);
      setError(null);
      try {
        const res = await fetch(`/api/projects/${projectId}/scenes/${sceneId}/face-swap`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ purpose }),
        });
        if (!res.ok) throw new Error(await failureMessage(res, "Failed to swap the face"));
        setRecord((await res.json()) as ProjectRecord);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to swap the face");
      } finally {
        setSceneBusy(null);
      }
    },
    [projectId, failureMessage],
  );

  const revertSceneFace = useCallback(
    async (sceneId: string, purpose: "start_frame" | "end_frame") => {
      setSceneBusy(sceneId);
      setError(null);
      try {
        const res = await fetch(
          `/api/projects/${projectId}/scenes/${sceneId}/face-swap?purpose=${purpose}`,
          { method: "DELETE" },
        );
        if (!res.ok) throw new Error(await failureMessage(res, "Failed to undo the swap"));
        setRecord((await res.json()) as ProjectRecord);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to undo the swap");
      } finally {
        setSceneBusy(null);
      }
    },
    [projectId, failureMessage],
  );

  const approveScene = useCallback(
    async (sceneId: string, attemptId: string) => {
      setSceneBusy(sceneId);
      try {
        const res = await fetch(
          `/api/projects/${projectId}/scenes/${sceneId}/approve-attempt/${attemptId}`,
          { method: "POST" },
        );
        if (!res.ok) throw new Error("Failed to approve attempt");
        setRecord((await res.json()) as ProjectRecord);
        await loadMedia();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to approve attempt");
      } finally {
        setSceneBusy(null);
      }
    },
    [projectId, loadMedia],
  );

  if (loading) return <p className="text-sm text-slate-400">Loading…</p>;
  if (error && !record) return <p role="alert" className="text-sm text-red-300">{error}</p>;
  if (!record) return null;

  const { project, storyboard } = record;
  const stages = generationStages(project.generationMode);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{project.title}</h1>
          <p className="mt-1 text-sm text-slate-400">
            {project.segmentCount} scenes · {project.generatedDurationSeconds}s generated ·{" "}
            {project.finalTrimSeconds}s trim · {project.status}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href={`/variant-review/${projectId}`}
            className="rounded-md border border-white/10 px-4 py-2 text-sm hover:border-accent"
          >
            Variant review
          </Link>
          <Link
            href={`/agentic-canvas/${projectId}`}
            className="rounded-md border border-white/10 px-4 py-2 text-sm hover:border-accent"
          >
            Agentic canvas
          </Link>
          <Link
            href={`/generation-console/${projectId}`}
            className="rounded-md border border-white/10 px-4 py-2 text-sm hover:border-accent"
          >
            Generation console
          </Link>
          <Link
            href={`/assembly/${projectId}`}
            className="rounded-md border border-white/10 px-4 py-2 text-sm hover:border-accent"
          >
            Assembly
          </Link>
          <Link
            href={`/settings/${projectId}`}
            className="rounded-md border border-white/10 px-4 py-2 text-sm hover:border-accent"
          >
            Settings
          </Link>
          <button
            onClick={generate}
            disabled={generating}
            className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {generating ? "Generating…" : storyboard ? "Regenerate storyboard" : "Generate storyboard"}
          </button>
          {storyboard && (
            <>
              <a
                href={`/api/projects/${projectId}/export?format=json`}
                className="rounded-md border border-white/10 px-4 py-2 text-sm hover:border-accent"
              >
                Export JSON
              </a>
              <a
                href={`/api/projects/${projectId}/export?format=md`}
                className="rounded-md border border-white/10 px-4 py-2 text-sm hover:border-accent"
              >
                Export MD
              </a>
            </>
          )}
        </div>
      </div>

      {error && <p role="alert" className="text-sm text-red-300">{error}</p>}

      {remoteAgent && !busy ? (
        <p
          data-testid="storyboard-remote-run"
          className="rounded-lg border border-sky-500/30 bg-sky-500/10 px-4 py-2 text-xs text-sky-200/90"
        >
          {remoteAgentName ?? "An agent"} is running on the server — started before you last left
          this page, or from somewhere else. A full storyboard is one call per batch of scene cards
          plus two per scene for the prompts, so it takes a while. The buttons stay locked until it
          finishes, and this page updates itself when it does.
        </p>
      ) : null}

      {storyboard?.fallbacks?.length ? (
        <section
          className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4"
          data-testid="storyboard-fallback"
        >
          <h2 className="text-sm font-semibold text-amber-200">
            {storyboard.fallbacks.some((f) => f.reason === "no_valid_response")
              ? "These scene cards were not written by the planning model"
              : "Some scene cards were not written by the planning model"}
          </h2>
          {storyboard.fallbacks.map((f) => (
            <p key={f.reason} className="mt-1 text-xs text-amber-200/90">
              {f.reason === "no_valid_response" ? (
                <>
                  The {f.agent} returned nothing usable, so the built-in builder filled every scene
                  card in from the story beats. They are structurally complete and will render, but
                  they are mechanical — the descriptions follow the beats rather than interpreting
                  them.
                </>
              ) : f.reason === "scene_count_short" ? (
                <>
                  The {f.agent} returned fewer scene cards than this project has segments
                  {f.detail ? ` (${f.detail})` : ""}. Its cards were kept; the remaining ones at the
                  end were filled in by the built-in builder and will read as mechanical.
                </>
              ) : (
                <>
                  The {f.agent} returned more scene cards than this project has segments
                  {f.detail ? ` (${f.detail})` : ""}. The surplus was dropped, so the story may end
                  abruptly rather than resolving.
                </>
              )}
            </p>
          ))}
          <p className="mt-2 text-[11px] text-amber-200/70">
            This affects the scene cards only. Each scene&apos;s image and video prompts are written
            by separate per-scene calls and are unaffected — expand <strong>Prompts</strong> on any
            card to see what will actually be sent to WanGP. Long storyboards are the usual cause:
            every card is produced in one request, so a project with many segments can exceed what
            the model will return in one go. Load the planning model and regenerate, and if it keeps
            happening, raise <code>OPENAI_MAX_TOKENS</code> or shorten the project.
          </p>
          <button
            type="button"
            onClick={generate}
            disabled={generating}
            className="mt-3 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
          >
            {generating ? "Regenerating…" : "Regenerate storyboard"}
          </button>
        </section>
      ) : null}

      <CreativePlansPanel
        record={record}
        projectId={projectId}
        busy={generating}
        onRegenerate={generate}
      />

      {llm?.enabled ? (
        <section className="rounded-lg border border-white/10 bg-panel/40 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
                Planning model (LM Studio)
              </h2>
              <p className="mt-1 text-sm">
                {!llm.reachable ? (
                  <span className="text-slate-400">LM Studio is not responding.</span>
                ) : llm.loadedModels.length === 0 ? (
                  <span className="text-emerald-400">
                    Unloaded — the GPU is free for image and video generation.
                  </span>
                ) : (
                  <span className="text-amber-300">
                    Loaded: {llm.loadedModels.join(", ")}
                  </span>
                )}
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => void llmAction("load")}
                disabled={llmBusy !== null || !llm.reachable}
                className="rounded-md border border-white/10 px-4 py-2 text-sm hover:border-accent disabled:opacity-50"
              >
                {llmBusy === "load" ? "Loading…" : "Load for planning"}
              </button>
              <button
                onClick={() => void llmAction("unload")}
                disabled={llmBusy !== null || !llm.reachable}
                className="rounded-md border border-white/10 px-4 py-2 text-sm hover:border-accent disabled:opacity-50"
              >
                {llmBusy === "unload" ? "Unloading…" : "Unload to free GPU"}
              </button>
              <button
                onClick={() => void loadLlmStatus()}
                disabled={llmBusy !== null}
                className="rounded-md border border-white/10 px-3 py-2 text-sm hover:border-accent disabled:opacity-50"
              >
                Refresh
              </button>
            </div>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Planning and generation compete for the same GPU. Load the model to write or regenerate a
            storyboard, then unload it before generating media. Configured model:{" "}
            <code>{llm.configuredModel}</code>
            {llm.reachable && !llm.configuredModelLoaded && llm.loadedModels.length > 0
              ? " — note a different model is currently resident."
              : ""}
          </p>
        </section>
      ) : null}

      {storyboard ? (
        <>
          <section className="rounded-lg border border-white/10 bg-panel/40 p-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Logline</h2>
            <p className="mt-1">{storyboard.brief.logline}</p>
            <p className="mt-2 text-sm text-slate-400">{storyboard.brief.synopsis}</p>
          </section>

          <section className="rounded-lg border border-white/10 bg-panel/40 p-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
              Generation mode
            </h2>
            <label className="mt-2 block">
              <select
                value={record.project.generationMode}
                onChange={(e) => void setGenerationMode(e.target.value as GenerationMode)}
                className="w-full rounded-md border border-white/10 bg-canvas px-3 py-2 text-sm outline-none focus:border-accent sm:max-w-md"
              >
                {GENERATION_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {mode.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </label>
            <p className="mt-2 text-xs text-slate-500">
              {GENERATION_MODE_DOCS[record.project.generationMode]}
            </p>
          </section>

          <section className="rounded-lg border border-white/10 bg-panel/40 p-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
              Scene continuity
            </h2>
            <label className="mt-2 block">
              <select
                value={record.project.sceneContinuity ?? DEFAULT_SCENE_CONTINUITY}
                onChange={(e) => void setContinuity(e.target.value as SceneContinuityMode)}
                className="w-full rounded-md border border-white/10 bg-canvas px-3 py-2 text-sm outline-none focus:border-accent sm:max-w-md"
              >
                {SCENE_CONTINUITY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="mt-2 text-xs text-slate-500">
              {
                SCENE_CONTINUITY_OPTIONS.find(
                  (o) => o.value === (record.project.sceneContinuity ?? DEFAULT_SCENE_CONTINUITY),
                )?.description
              }
            </p>
            <p className="mt-1 text-[11px] text-slate-500">
              Applies to scenes generated from now on. Scene 1 always renders its own frames, and any
              scene whose predecessor has not been generated yet falls back to a cut.
            </p>
          </section>

          <section className="rounded-lg border border-white/10 bg-panel/40 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
                  Batch generation
                </h2>
                <p className="mt-1 text-sm text-slate-300">
                  {!stages.keyframes
                    ? "This project is set to plan only. Change the generation mode above to render media."
                    : queue?.active
                      ? `Running — ${queue.entries.filter((e) => e.state === "completed").length} of ${queue.entries.length} done`
                      : queue?.entries.length
                        ? `Last run: ${queue.entries.filter((e) => e.state === "completed").length} completed, ${queue.entries.filter((e) => e.state === "failed").length} failed`
                        : stages.video
                          ? "Generates every scene in order, one at a time."
                          : "Generates start and end frames for every scene. No clips — the mode is keyframes only."}
                </p>
                {/*
                  A phase can run for an hour without a single scene chip
                  changing, which reads as a stalled job. This is the only signal
                  that work is happening.
                */}
                {queue?.phase ? (
                  <p className="mt-1 text-xs text-accent" data-testid="queue-phase">
                    {PHASE_LABELS[queue.phase.phase]} · {queue.phase.completed} of{" "}
                    {queue.phase.total}
                    {queue.phase.phase === "keyframes" && stages.video
                      ? " — clips start once every keyframe is done"
                      : ""}
                  </p>
                ) : null}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => void generateAll(false)}
                  disabled={queueBusy || queue?.active || !stages.keyframes}
                  className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                >
                  {queue?.active ? "Generating…" : "Generate all media"}
                </button>
                <button
                  onClick={() => void generateAll(true)}
                  disabled={queueBusy || queue?.active || !stages.keyframes}
                  className="rounded-md border border-white/10 px-4 py-2 text-sm hover:border-accent disabled:opacity-50"
                >
                  Regenerate all
                </button>
                {queue?.active ? (
                  <button
                    onClick={() => void cancelQueue()}
                    disabled={queueBusy}
                    className="rounded-md border border-white/10 px-4 py-2 text-sm hover:border-accent disabled:opacity-50"
                  >
                    Cancel remaining
                  </button>
                ) : null}
              </div>
            </div>

            {queue?.entries.length ? (
              <ul className="mt-3 flex flex-wrap gap-2">
                {queue.entries.map((entry) => (
                  <li
                    key={entry.sceneId}
                    title={entry.error ?? entry.state}
                    className={`rounded-md border px-2 py-1 text-xs ${
                      entry.state === "completed"
                        ? "border-emerald-500/40 text-emerald-300"
                        : entry.state === "running"
                          ? "border-accent text-accent"
                          : entry.state === "failed"
                            ? "border-red-500/40 text-red-300"
                            : entry.state === "cancelled"
                              ? "border-white/10 text-slate-500"
                              : "border-white/10 text-slate-400"
                    }`}
                  >
                    Scene {entry.sceneNumber} · {entry.state}
                    {entry.attempts > 1 ? ` · try ${entry.attempts}` : ""}
                  </li>
                ))}
              </ul>
            ) : null}

            <p className="mt-2 text-[11px] text-slate-500">
              Scenes run one at a time because WanGP generates one job at a time, and because the
              continuity modes need the previous scene finished before the next starts. Generation
              continues server-side if you close this page. A scene that fails does not stop the
              rest, and transient GPU faults are retried automatically.
            </p>
            {llm?.reachable && llm.loadedModels.length > 0 ? (
              <p className="mt-1 text-[11px] text-amber-300/90">
                The planning model is currently holding the GPU. Starting a batch will unload it
                first, because a local LLM and the image/video models cannot share one card.
              </p>
            ) : null}
          </section>

          <section className="space-y-4">
            <h2 className="text-lg font-semibold">Scenes</h2>
            {storyboard.scenes.map((scene) => {
              const attempts = record.attempts?.[scene.id] ?? [];
              const latest = attempts[attempts.length - 1];
              // Mirrors what generation does: resolve the scene's effective LoRAs,
              // then collect only the trigger words each one will contribute — a
              // multi-concept LoRA contributes nothing until a trigger is chosen.
              const triggerWordsFor = (kind: "image" | "video") => {
                const catalog = loraCatalogs[kind];
                if (!catalog?.supported) return [];
                const selected = resolveSceneLoras(record.project, scene.id, kind);
                const byName = new Map(catalog.loras.map((l) => [l.name.toLocaleLowerCase(), l]));
                return [
                  ...new Set(
                    selected.flatMap((s) =>
                      effectiveTriggerWords(
                        s.triggerWords,
                        byName.get(s.name.toLocaleLowerCase())?.triggerWords ?? [],
                      ),
                    ),
                  ),
                ];
              };
              return (
                <SceneCard
                  key={scene.id}
                  scene={scene}
                  attempt={latest}
                  media={media}
                  busy={sceneBusy === scene.id}
                  onGenerate={stages.keyframes ? () => generateSceneMedia(scene.id) : undefined}
                  onApprove={latest ? () => approveScene(scene.id, latest.id) : undefined}
                  projectId={projectId}
                  loraOverride={record.project.sceneLoras?.[scene.id]}
                  onLoraSave={(next) => void saveSceneLoras(scene.id, next)}
                  triggerWords={{ image: triggerWordsFor("image"), video: triggerWordsFor("video") }}
                  onPromptsSaved={(next) => setRecord(next)}
                  onGenerateKeyframe={
                    stages.keyframes
                      ? (purpose) => void generateSceneKeyframe(scene.id, purpose)
                      : undefined
                  }
                  onClearPreviews={() => void clearScenePreviews(scene.id)}
                  seed={record.project.sceneSeeds?.[scene.id]}
                  onNewSeed={() => void newSceneSeed(scene.id)}
                  onFaceVisibleChange={(next) => void setFaceVisible(scene.id, next)}
                  onSwapFace={
                    stages.keyframes ? (purpose) => void swapSceneFace(scene.id, purpose) : undefined
                  }
                  onRevertFace={
                    stages.keyframes
                      ? (purpose) => void revertSceneFace(scene.id, purpose)
                      : undefined
                  }
                />
              );
            })}
          </section>
        </>
      ) : (
        <p className="text-sm text-slate-400">
          No storyboard yet. Generate one to plan {project.segmentCount} scenes.
        </p>
      )}
    </div>
  );
}
