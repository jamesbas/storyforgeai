"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAgentRun } from "@/components/shared/use-agent-run";
import { useLoadEffect } from "@/components/shared/use-load-effect";
import Link from "next/link";
import { SceneCard } from "@/components/storyboard/scene-card";
import { ScenePicker } from "@/components/storyboard/scene-picker";
import { CreativePlansPanel, planStates } from "@/components/storyboard/creative-plans-panel";
import { NegativePromptRepair } from "@/components/storyboard/negative-prompt-repair";
import { TaskRecoveryPanel } from "@/components/storyboard/task-recovery-panel";
import { chipLabel, phaseLabel } from "@/components/storyboard/phase-labels";
import { AsyncStatus } from "@/components/shared/async-status";
import { WardrobeCheck } from "@/components/storyboard/wardrobe-check";
import { GENERATION_MODE_DOCS, SCENE_CONTINUITY_OPTIONS } from "@/lib/presets";
import type { GenerationMode, SceneContinuityMode } from "@/lib/types";
import { DEFAULT_SCENE_CONTINUITY, GENERATION_MODES, generationStages } from "@/lib/types";
import { resolveSceneLoras } from "@/lib/lora/scene-selection";
import { effectiveTriggerWords } from "@/lib/lora/trigger-words";
import { latestExecution } from "@/lib/schemas/provenance";
import type { LoraCatalog, SceneLoraOverride } from "@/lib/schemas/lora";
import type { LlmRuntimeStatus } from "@/lib/services/llm-runtime-service";
import type { PhaseProgress, SceneQueueEntry } from "@/lib/services/scene-queue";
import type { ProjectRecord } from "@/lib/schemas/storyboard";
import type { Character } from "@/lib/schemas/character";
import { handEditedSinceGeneration } from "@/lib/history";
import { familyLabel, familyOf } from "@/lib/wangp/family";
import { checkPromptFamily, promptsPredateGuidance } from "@/lib/agents/prompt-family";
import type { PromptPass } from "@/lib/agents/prompt-agents";
import { PROMPT_VERSIONS } from "@/lib/agents/prompt-version";
import type { MediaDescriptor } from "@/lib/media/refs";

type QueueSnapshot = { entries: SceneQueueEntry[]; active: boolean; phase?: PhaseProgress };

export function StoryboardView({ projectId }: { projectId: string }) {
  const [record, setRecord] = useState<ProjectRecord | null>(null);
  const [media, setMedia] = useState<MediaDescriptor[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rewritingAll, setRewritingAll] = useState(false);

  /** Empty means every scene, matching the clip queue. */
  const rewritePrompts = useCallback(
    async (sceneIds: string[] = [], passes?: PromptPass[]) => {
      setRewritingAll(true);
      setError(null);
      try {
        const res = await fetch(`/api/projects/${projectId}/prompts`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sceneIds, passes }),
        });
        if (!res.ok) {
          const detail = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(detail?.error ?? "Failed to rewrite prompts");
        }
        setRecord((await res.json()) as ProjectRecord);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to rewrite prompts");
      } finally {
        setRewritingAll(false);
      }
    },
    [projectId],
  );

  const rewriteAllPrompts = useCallback(() => rewritePrompts([]), [rewritePrompts]);
  // Both staleness checks below are about the clip prompt and nothing else, so
  // the button that clears them writes the clip prompt and nothing else. The
  // image pass costs a second model call per scene and would replace start and
  // end frame prompts — hand edits included — that never went stale.
  const rewriteVideoPrompts = useCallback(
    () => rewritePrompts([], ["video"]),
    [rewritePrompts],
  );


  const loadMedia = useCallback(async () => {
    const res = await fetch(`/api/projects/${projectId}/media`);
    if (res.ok) {
      const data = (await res.json()) as { media: MediaDescriptor[] };
      setMedia(data.media);
    }
  }, [projectId]);

  const load = useCallback(
    async (isCurrent: () => boolean = () => true) => {
      setError(null);
      const res = await fetch(`/api/projects/${projectId}`);
      if (!isCurrent()) return;
      if (res.status === 404) {
        setError("Project not found");
        setRecord(null);
      } else if (res.ok) {
        setRecord((await res.json()) as ProjectRecord);
        await loadMedia();
      } else {
        setError("Failed to load project");
      }
      if (isCurrent()) setLoading(false);
    },
    [projectId, loadMedia],
  );

  useLoadEffect(load);

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

  /** Scenes whose hand-written prompts a regeneration would discard. */
  const handEdits = record ? handEditedSinceGeneration(record) : [];
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);

  /**
   * Every regenerate button routes through here, so the guard sits in one place
   * rather than on each of them.
   */
  const requestGenerate = useCallback(() => {
    if (handEdits.length) {
      setConfirmRegenerate(true);
      return;
    }
    void generate();
  }, [handEdits.length, generate]);

  const [sceneBusy, setSceneBusy] = useState<string | null>(null);
  const [llm, setLlm] = useState<LlmRuntimeStatus | null>(null);
  const [llmBusy, setLlmBusy] = useState<null | "load" | "unload">(null);
  const [queue, setQueue] = useState<QueueSnapshot | null>(null);
  const [queueBusy, setQueueBusy] = useState(false);
  /** Scenes ticked for a clip-only rerun. Empty means the whole project. */
  const [videoPicks, setVideoPicks] = useState<string[]>([]);
  const [promptPicks, setPromptPicks] = useState<string[]>([]);
  const [cascadeNotice, setCascadeNotice] = useState<string | null>(null);
  /**
   * LoRA catalogs, fetched once per model rather than per scene. They are only
   * needed to look up trigger words, which every scene shares.
   */
  const [loraCatalogs, setLoraCatalogs] = useState<{ image?: LoraCatalog; video?: LoraCatalog }>({});
  /** The project's pinned cast, for the per-scene wardrobe panel. */
  const [fetchedCast, setFetchedCast] = useState<Character[]>([]);
  const castEnabled = Boolean(
    record?.project.useCharacterLibrary && record.project.characterIds?.length,
  );
  // Derived rather than reset from an effect: an effect that writes [] on the
  // disabled path is a synchronous state update and an extra render.
  const cast = useMemo(() => (castEnabled ? fetchedCast : []), [castEnabled, fetchedCast]);

  /**
   * Whether this project renders clips at all. The clip phase runs either way —
   * it closes the attempts out — so every label that names it has to know.
   */
  const rendersVideo = record ? generationStages(record.project.generationMode).video : true;

  /** Scenes with keyframes banked. This is the number that moves in phases 1–2. */
  const keyframesDone =
    queue?.entries.filter((e) => e.completedPhase || e.state === "completed").length ?? 0;

  /**
   * One sentence for the batch, changing only when a phase or a scene does.
   *
   * The visible line recomputes its counts on every three-second poll; feeding
   * that straight to a live region would read the same sentence over and over.
   * Phase name plus completed count moves on real progress and nothing else.
   */
  const batchStatus = (() => {
    if (!queue) return null;
    const done = queue.entries.filter((e) => e.state === "completed").length;
    const failedCount = queue.entries.filter((e) => e.state === "failed").length;
    if (queue.active) {
      const current = queue.phase;
      // No scene is finished before the clip phase, so a completed-scene count
      // reads as zero for hours. Keyframes banked is what is actually moving.
      const beforeClips = current?.phase === "keyframes" || current?.phase === "face_swap";
      const progress = beforeClips
        ? `${keyframesDone} of ${queue.entries.length} scenes have keyframes.`
        : `${done} of ${queue.entries.length} scenes done.`;
      const label = current ? `${phaseLabel(current.phase, rendersVideo)}. ` : "";
      return `${label}${progress}${failedCount ? ` ${failedCount} failed.` : ""}`;
    }
    if (!queue.entries.length) return null;
    return failedCount
      ? `Generation finished. ${done} done, ${failedCount} failed.`
      : `Generation finished. All ${done} scenes done.`;
  })();

  useEffect(() => {
    const ids = record?.project.characterIds;
    if (!castEnabled || !ids?.length) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/characters", { cache: "no-store" });
        if (!res.ok) return;
        const all = ((await res.json()) as { characters?: Character[] }).characters ?? [];
        const byId = new Map(all.map((c) => [c.id, c] as const));
        if (!cancelled) setFetchedCast(ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])));
      } catch {
        // The wardrobe panel is optional; the storyboard works without it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [castEnabled, record?.project.characterIds]);

  const loadLlmStatus = useCallback(async (isCurrent: () => boolean = () => true) => {
    try {
      // `no-store` matters here: without it the browser can answer Refresh from
      // its own cache and report a model as unloaded when it is resident.
      const res = await fetch("/api/llm/status", { cache: "no-store" });
      if (res.ok && isCurrent()) setLlm((await res.json()) as LlmRuntimeStatus);
    } catch {
      // Runtime control is optional; the storyboard works without it.
    }
  }, []);

  useLoadEffect(loadLlmStatus);

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
  const loadQueue = useCallback(
    async (isCurrent: () => boolean = () => true) => {
      try {
        const res = await fetch(`/api/projects/${projectId}/queue`, { cache: "no-store" });
        if (res.ok && isCurrent()) setQueue((await res.json()) as QueueSnapshot);
      } catch {
        // Progress polling is best-effort.
      }
    },
    [projectId],
  );

  useLoadEffect(loadQueue);

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

  /**
   * Rebuild clips from the keyframes already on the record.
   *
   * `sceneIds` empty means every scene. On `continue_video` the server extends
   * the selection forward, because each clip there is built from the previous
   * scene's clip — it reports that back so the notice is not a guess.
   */
  const regenerateVideo = useCallback(
    async (sceneIds: string[]) => {
      setQueueBusy(true);
      setError(null);
      setCascadeNotice(null);
      try {
        const res = await fetch(`/api/projects/${projectId}/queue?video=1`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sceneIds }),
        });
        if (!res.ok) throw new Error(await failureMessage(res, "Failed to queue clips"));
        const body = (await res.json()) as QueueSnapshot & { cascaded?: boolean };
        setQueue(body);
        if (body.cascaded) {
          setCascadeNotice(
            "This project continues each clip from the previous one, so every scene after the earliest you picked was included too. Leaving them alone would have left them continuing from a clip that no longer exists.",
          );
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to queue clips");
      } finally {
        setQueueBusy(false);
      }
    },
    [projectId, failureMessage],
  );

  const cancelQueue = useCallback(async () => {    setQueueBusy(true);
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

  /**
   * Whether this scene's end frame is rendered against the frame it inherited.
   *
   * Applies from the next render on, like every other continuity setting — the
   * frames already on the record are not touched.
   */
  const setEndFrameReference = useCallback(
    async (sceneId: string, endFrameReference: boolean) => {
      setSceneBusy(sceneId);
      setError(null);
      try {
        const res = await fetch(`/api/projects/${projectId}/scenes/${sceneId}/framing`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ endFrameReference }),
        });
        if (!res.ok) throw new Error(await failureMessage(res, "Failed to update the reference"));
        setRecord((await res.json()) as ProjectRecord);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to update the reference");
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

  /**
   * Replace one of a scene's rendered keyframes with a supplied image.
   *
   * The server reports whether the next scene's carried-over start frame went
   * with it, so the notice is a fact rather than a guess — that scene's card
   * may be a long way down the page.
   */
  const importSceneFrame = useCallback(
    async (sceneId: string, purpose: "start_frame" | "end_frame", file: File) => {
      setSceneBusy(sceneId);
      setError(null);
      setCascadeNotice(null);
      try {
        const body = new FormData();
        body.append("file", file);
        body.append("purpose", purpose);
        const res = await fetch(`/api/projects/${projectId}/scenes/${sceneId}/import-frame`, {
          method: "POST",
          body,
        });
        if (!res.ok) throw new Error(await failureMessage(res, "Failed to import the image"));
        const result = (await res.json()) as {
          record: ProjectRecord;
          cascadedTo?: { sceneId: string; sceneNumber: number };
        };
        setRecord(result.record);
        await loadMedia();
        if (result.cascadedTo) {
          setCascadeNotice(
            `This project carries each scene's end frame into the next one's start frame, so scene ${result.cascadedTo.sceneNumber} now shows the imported image as its start frame too. Its clip was built from the old frame — rebuild it from "Regenerate video for selected scenes" above.`,
          );
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to import the image");
      } finally {
        setSceneBusy(null);
      }
    },
    [projectId, failureMessage, loadMedia],
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
  const continuity = project.sceneContinuity ?? DEFAULT_SCENE_CONTINUITY;

  // Only a pinned model can make a prompt stale — an unpinned project falls
  // through to the router, so there is no family to disagree with.
  const videoFamily = project.videoModel ? familyOf(project.videoModel) : undefined;
  const promptFamily = checkPromptFamily({
    videoModel: project.videoModel,
    scenes: storyboard?.scenes ?? [],
  });
  // The wording the agents are given changes between releases, and a prompt
  // written under the old wording is stale even when nothing about the project
  // has moved. Only the video prompt is checked: it is the one whose guidance
  // is model-specific and has actually changed.
  const outdatedGuidance = promptsPredateGuidance(
    (storyboard?.scenes ?? []).map(
      (scene) => latestExecution(record.executions, `${scene.id}.video_prompt`)?.promptVersion,
    ),
    PROMPT_VERSIONS.videoPrompt,
  );
  // Regenerating the storyboard rewrites prompts as part of the job, so where
  // plans are also out of step the prompt rewrite is the wrong button.
  const plansStale = planStates(record).staleCount > 0;

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
            onClick={requestGenerate}
            disabled={generating}
            className="rounded-md bg-accent-solid px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
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

      {promptFamily || outdatedGuidance ? (
        <section
          data-testid="stale-prompt-family"
          className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4"
        >
          <h2 className="text-sm font-semibold text-amber-100">
            {promptFamily
              ? promptFamily.staleScenes === promptFamily.totalScenes
                ? promptFamily.certainty === "stamped"
                  ? "These prompts were written for a different video model"
                  : "These prompts may have been written for a different video model"
                : `${promptFamily.staleScenes} of ${promptFamily.totalScenes} scenes have prompts written for a different video model`
              : "These prompts were written under older guidance"}
          </h2>
          <p className="mt-1 text-sm text-amber-100/80">
            {!promptFamily ? (
              <>
                The wording the prompt agents are given has changed since these were written, so
                they do not follow the current guidance for{" "}
                <strong>{familyLabel(videoFamily)}</strong>.
              </>
            ) : promptFamily.certainty === "stamped" ? (
              <>
                The clip prompts were written for{" "}
                <strong>{familyLabel(promptFamily.writtenFor)}</strong>, and this project now
                renders on <strong>{familyLabel(videoFamily)}</strong>.
              </>
            ) : (
              <>
                Those scenes predate the record of which model their prompts were written for, and
                they do not read like prompts written for{" "}
                <strong>{familyLabel(videoFamily)}</strong>.
              </>
            )}{" "}
            {promptFamily ? (
              <>
                They will still render, but each family wants a different kind of writing — length,
                camera vocabulary, and whether the soundtrack is described in fields of its own — so
                the clips will be worse than they need to be.
              </>
            ) : (
              <>
                They will still render. What has changed is what the agents are told to do with a
                scene — most recently, that a shot continuing from the one before it opens on that
                scene&apos;s final frame rather than on its own.
              </>
            )}{" "}
            Rewriting re-runs the video prompt agent against the scene cards you already have; the
            story, shot list, cards and image prompts are untouched.
          </p>
          {/* Two amber banners offering near-identical verbs is how someone ends
              up running the cheaper one twice. Regenerating covers both. */}
          {plansStale ? (
            <p className="mt-2 text-[11px] text-amber-100/70">
              Creative plans have changed too — see below. Regenerating the storyboard rewrites the
              prompts as part of the job, so do that instead and this clears with it.
            </p>
          ) : null}
          <button
            type="button"
            data-testid="rewrite-video-prompts"
            disabled={busy || rewritingAll || plansStale}
            onClick={() => void rewriteVideoPrompts()}
            className="mt-3 rounded-md bg-accent-solid px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
          >
            {rewritingAll
              ? "Rewriting every scene…"
              : `Rewrite all ${storyboard?.scenes.length ?? 0} scenes' video prompts`}
          </button>
          <p className="mt-2 text-[11px] text-amber-100/60">
            One agent call per scene — only the clip prompt is stale, so the start and end frame
            prompts are left as they are. Clip prompt wording you typed by hand is replaced.
          </p>
        </section>
      ) : null}

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

      {confirmRegenerate ? (
        <section
          className="rounded-lg border border-red-500/40 bg-red-500/10 p-4"
          data-testid="regenerate-confirm"
        >
          <h2 className="text-sm font-semibold">
            Regenerating rewrites {handEdits.length} hand-edited{" "}
            {handEdits.length === 1 ? "scene" : "scenes"}
          </h2>
          <p className="mt-1 text-sm text-slate-300">
            Every prompt is written afresh, so the wording you typed on{" "}
            {handEdits.slice(0, 6).join(", ")}
            {handEdits.length > 6 ? ` and ${handEdits.length - 6} more` : ""} is replaced. This
            cannot be undone.
          </p>
          <p className="mt-1 text-xs text-slate-400">
            <strong>Export JSON</strong> first if you want a copy to read them back from. It will not
            restore them automatically, but the text will still be there.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                setConfirmRegenerate(false);
                void generate();
              }}
              disabled={generating}
              className="rounded-md bg-accent-solid px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
            >
              Regenerate anyway
            </button>
            <button
              type="button"
              onClick={() => setConfirmRegenerate(false)}
              className="rounded-md border border-white/15 px-3 py-1.5 text-xs font-semibold hover:border-accent"
            >
              Keep my edits
            </button>
            <a
              href={`/api/projects/${projectId}/export?format=json`}
              className="rounded-md border border-white/15 px-3 py-1.5 text-xs hover:border-accent"
            >
              Export JSON
            </a>
          </div>
        </section>
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
            onClick={requestGenerate}
            disabled={generating}
            className="mt-3 rounded-md bg-accent-solid px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
          >
            {generating ? "Regenerating…" : "Regenerate storyboard"}
          </button>
        </section>
      ) : null}

      <CreativePlansPanel
        record={record}
        projectId={projectId}
        busy={generating}
        onRegenerate={requestGenerate}
      />

      <TaskRecoveryPanel projectId={projectId} />

      <NegativePromptRepair
        record={record}
        projectId={projectId}
        cast={cast}
        onRepaired={() => void load()}
      />

      <WardrobeCheck
        record={record}
        projectId={projectId}
        cast={cast}
        onApplied={() => void load()}
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
            <h2
              id="generation-mode-heading"
              className="text-sm font-semibold uppercase tracking-wide text-slate-400"
            >
              Generation mode
            </h2>
            <div className="mt-2">
              <select
                aria-labelledby="generation-mode-heading"
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
            </div>
            <p className="mt-2 text-xs text-slate-500">
              {GENERATION_MODE_DOCS[record.project.generationMode]}
            </p>
          </section>

          <section className="rounded-lg border border-white/10 bg-panel/40 p-4">
            <h2
              id="scene-continuity-heading"
              className="text-sm font-semibold uppercase tracking-wide text-slate-400"
            >
              Scene continuity
            </h2>
            <div className="mt-2">
              <select
                aria-labelledby="scene-continuity-heading"
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
            </div>
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
            {videoFamily === "minimax_ref2va" &&
            (record.project.sceneContinuity ?? DEFAULT_SCENE_CONTINUITY) === "reuse_end_frame" ? (
              <p
                data-testid="continuity-ref2va-warning"
                className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200"
              >
                Reference mode has no positional first frame — the opening is whatever the clip
                prompt describes, so a carried-over frame only holds if the prompt opens on what
                that frame shows. Scenes are written that way, but it depends on the writing agent
                following it, and a scene card that describes a different opening can win. If a
                clip does not begin on the frame above it, rewrite that scene&apos;s prompts before
                reaching for <strong>Cut</strong> — cutting fixes it by removing the continuity you
                chose this setting for.
              </p>
            ) : null}
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
                      ? queue.phase?.phase === "keyframes" || queue.phase?.phase === "face_swap"
                        ? `Running — ${keyframesDone} of ${queue.entries.length} scenes have keyframes`
                        : `Running — ${queue.entries.filter((e) => e.state === "completed").length} of ${queue.entries.length} done`
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
                    {phaseLabel(queue.phase.phase, stages.video)} · {queue.phase.completed} of{" "}
                    {queue.phase.total}
                    {queue.phase.failed ? ` · ${queue.phase.failed} failed` : ""}
                    {queue.phase.phase === "keyframes" && stages.video
                      ? " — clips start once every keyframe is done"
                      : ""}
                  </p>
                ) : null}
                <AsyncStatus
                  testId="batch-status"
                  message={batchStatus}
                  busy={Boolean(queue?.active)}
                />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => void generateAll(false)}
                  disabled={queueBusy || queue?.active || !stages.keyframes}
                  className="rounded-md bg-accent-solid px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
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
                {stages.video ? (
                  <button
                    onClick={() => void regenerateVideo([])}
                    disabled={queueBusy || queue?.active}
                    title="Rebuild every clip from the keyframes already rendered. The frames are not touched."
                    className="rounded-md border border-white/10 px-4 py-2 text-sm hover:border-accent disabled:opacity-50"
                  >
                    Regenerate all video
                  </button>
                ) : null}
                {/* Not only inside the staleness warning: prompts also want
                    rewriting after editing scene cards or changing the cast,
                    and a control that appears only when something is wrong
                    cannot be found when nothing is. */}
                <button
                  onClick={() => void rewriteAllPrompts()}
                  disabled={busy || rewritingAll || queue?.active}
                  title="Re-run the two prompt agents over every scene card, against the models pinned now. Scene cards, the story and the shot list are untouched; prompt wording you typed by hand is replaced."
                  className="rounded-md border border-white/10 px-4 py-2 text-sm hover:border-accent disabled:opacity-50"
                >
                  {rewritingAll ? "Rewriting prompts…" : "Rewrite all prompts"}
                </button>
                {/* Changing the video model is the common half of that job, and
                    it is half the model calls. */}
                <button
                  onClick={() => void rewriteVideoPrompts()}
                  disabled={busy || rewritingAll || queue?.active}
                  title="Re-run only the video prompt agent over every scene card, against the video model pinned now. The start and end frame prompts are left as they are."
                  className="rounded-md border border-white/10 px-4 py-2 text-sm hover:border-accent disabled:opacity-50"
                >
                  {rewritingAll ? "Rewriting prompts…" : "Rewrite all video prompts"}
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

            {cascadeNotice ? (
              <p
                data-testid="queue-cascade-notice"
                className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200"
              >
                {cascadeNotice}
              </p>
            ) : null}

            {storyboard.scenes.length > 0 ? (
              <details className="mt-3 rounded-md border border-white/10 bg-black/20">
                <summary className="cursor-pointer px-3 py-2 text-xs text-slate-400 hover:text-slate-200">
                  Rewrite prompts for selected scenes
                </summary>
                <div className="space-y-2 px-3 pb-3">
                  <p className="text-xs text-slate-500">
                    Re-runs the two prompt agents for the scenes you pick, from their existing
                    cards. Every other scene keeps its wording, including any hand edits — which is
                    the reason to use this rather than rewriting all of them.
                  </p>
                  <ScenePicker
                    scenes={storyboard.scenes}
                    picked={promptPicks}
                    onChange={setPromptPicks}
                    testId="prompt-scene-picker"
                  />
                  <button
                    onClick={() => void rewritePrompts(promptPicks)}
                    disabled={rewritingAll || busy || promptPicks.length === 0}
                    className="rounded-md border border-white/10 px-3 py-1.5 text-xs hover:border-accent disabled:opacity-50"
                  >
                    {rewritingAll
                      ? "Rewriting prompts…"
                      : `Rewrite ${promptPicks.length} scene${promptPicks.length === 1 ? "" : "s"}' prompts`}
                  </button>
                </div>
              </details>
            ) : null}

            {stages.video && storyboard.scenes.length > 0 ? (
              <details className="mt-3 rounded-md border border-white/10 bg-black/20">
                <summary className="cursor-pointer px-3 py-2 text-xs text-slate-400 hover:text-slate-200">
                  Regenerate video for selected scenes
                </summary>
                <div className="space-y-2 px-3 pb-3">
                  <p className="text-xs text-slate-500">
                    Rebuilds only the clip, reusing each scene&apos;s existing keyframes — for when
                    a video prompt or a motion LoRA changed but the frames are fine.
                  </p>
                  <ScenePicker
                    scenes={storyboard.scenes}
                    picked={videoPicks}
                    onChange={setVideoPicks}
                    testId="video-scene-picker"
                  />
                  <button
                    onClick={() => void regenerateVideo(videoPicks)}
                    disabled={queueBusy || queue?.active || videoPicks.length === 0}
                    className="rounded-md border border-white/10 px-3 py-1.5 text-xs hover:border-accent disabled:opacity-50"
                  >
                    Regenerate {videoPicks.length} clip{videoPicks.length === 1 ? "" : "s"}
                  </button>
                </div>
              </details>
            ) : null}

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
                    Scene {entry.sceneNumber} · {chipLabel(entry, stages.video)}
                    {entry.attempts > 1 ? ` · try ${entry.attempts}` : ""}
                  </li>
                ))}
              </ul>
            ) : null}

            {/* A tooltip is where an error goes to be missed; the whole point of
                a failure is that it has to be read. */}
            {queue?.entries.some((entry) => entry.state === "failed" && entry.error) ? (
              <ul data-testid="queue-failures" className="mt-3 space-y-2">
                {queue.entries
                  .filter((entry) => entry.state === "failed" && entry.error)
                  .map((entry) => (
                    <li
                      key={`${entry.sceneId}-error`}
                      className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200"
                    >
                      <strong>Scene {entry.sceneNumber} failed.</strong> {entry.error}
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
            {storyboard.scenes.map((scene, index) => {
              const attempts = record.attempts?.[scene.id] ?? [];
              const latest = attempts[attempts.length - 1];
              // Generation reads the approved attempt; the card shows the newest
              // one so a fresh render can be judged. When they differ, the
              // frames on screen are not the frames being used.
              const approved = [...attempts].reverse().find((a) => a.approved);
              const superseded =
                approved && latest && approved.id !== latest.id ? approved.attemptNumber : undefined;
              // Only the immediate predecessor can be copied from: an inheriting
              // scene in between means there is no adjacent selection to carry.
              const previousScene = index > 0 ? storyboard.scenes[index - 1] : undefined;
              // Which scene, if any, is actually showing this one's end frame as
              // its start frame. Read off the attempts rather than inferred from
              // the continuity setting, which says what would happen on a fresh
              // render and not what the scene after this one is holding now.
              const nextScene = storyboard.scenes[index + 1];
              const nextLatest = nextScene
                ? (record.attempts?.[nextScene.id] ?? []).at(-1)
                : undefined;
              const endFrameCarriedToScene =
                latest?.endImagePath &&
                nextLatest?.startImageInherited &&
                nextLatest.startImagePath === latest.endImagePath
                  ? nextScene!.sceneNumber
                  : undefined;
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
                  supersededBy={superseded}
                  media={media}
                  busy={sceneBusy === scene.id}
                  onGenerate={stages.keyframes ? () => generateSceneMedia(scene.id) : undefined}
                  onApprove={latest ? () => approveScene(scene.id, latest.id) : undefined}
                  projectId={projectId}
                  loraOverride={record.project.sceneLoras?.[scene.id]}
                  previousLoraOverride={
                    previousScene ? record.project.sceneLoras?.[previousScene.id] : undefined
                  }
                  onLoraSave={(next) => void saveSceneLoras(scene.id, next)}
                  triggerWords={{ image: triggerWordsFor("image"), video: triggerWordsFor("video") }}
                  videoFamily={videoFamily}
                  promptExecution={latestExecution(record.executions, `${scene.id}.image_prompt`)}
                  onPromptsSaved={(next) => setRecord(next)}
                  cast={cast}
                  wardrobeChanges={record.project.wardrobeChanges?.[scene.id]}
                  continuousTake={continuity !== "cut"}
                  onGenerateKeyframe={
                    stages.keyframes
                      ? (purpose) => void generateSceneKeyframe(scene.id, purpose)
                      : undefined
                  }
                  onClearPreviews={() => void clearScenePreviews(scene.id)}
                  seed={record.project.sceneSeeds?.[scene.id]}
                  onNewSeed={() => void newSceneSeed(scene.id)}
                  onFaceVisibleChange={(next) => void setFaceVisible(scene.id, next)}
                  endFrameReference={
                    continuity === "reuse_end_frame" &&
                    scene.sceneNumber > 1 &&
                    record.project.endFrameReferences !== false
                      ? record.project.sceneEndFrameRefs?.[scene.id] !== false
                      : undefined
                  }
                  onEndFrameReferenceChange={(next) =>
                    void setEndFrameReference(scene.id, next)
                  }
                  onSwapFace={
                    stages.keyframes ? (purpose) => void swapSceneFace(scene.id, purpose) : undefined
                  }
                  onRevertFace={
                    stages.keyframes
                      ? (purpose) => void revertSceneFace(scene.id, purpose)
                      : undefined
                  }
                  onImportFrame={
                    stages.keyframes
                      ? (purpose, file) => void importSceneFrame(scene.id, purpose, file)
                      : undefined
                  }
                  endFrameCarriedToScene={endFrameCarriedToScene}
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
