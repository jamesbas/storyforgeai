import { createHash } from "node:crypto";
import {
  buildSceneCheckInput,
  ruleFindings,
  runDeepCheck,
  runQuickCheck,
  sceneCheckInputHash,
  sceneCheckSources,
} from "@/lib/agents/scene-check";
import { proposeFix, type CardFixField, type FixProposal } from "@/lib/agents/scene-check-fix";
import { rebuiltPrompts } from "@/lib/agents/cast-sheet";
import { wardrobeTimeline } from "@/lib/agents/wardrobe";
import { storedPromptWarnings, storedSceneImageContext } from "@/lib/agents/prompt-validation";
import { loadQcImages } from "@/lib/agents/qc-agent";
import { getPlanningProvider, visionAvailable } from "@/lib/agents/llm/provider";
import {
  appendHistory,
  getProjectRecord,
  updateSceneCard,
  updateScenePrompts,
} from "@/lib/services/project-service";
import { resolveProjectCast } from "@/lib/services/character-service";
import {
  clearFinished,
  enqueueKeyframeRerun,
  enqueueVideoRerun,
  getQueue,
} from "@/lib/services/scene-queue";
import { repository } from "@/lib/db/store";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { logEvent } from "@/lib/telemetry";
import {
  openFindings,
  sceneCheckFixApplySchema,
  sceneCheckStatus,
  type FixableField,
  type SceneCheck,
  type SceneCheckDepth,
  type SceneCheckStatus,
} from "@/lib/schemas/scene-check";
import type { ProjectRecord, Scene } from "@/lib/schemas/storyboard";

/**
 * Runs scene checks one at a time, only for the scenes someone asked about.
 *
 * Deliberately not part of storyboard generation, the agentic canvas or a
 * render batch: a check is a full model round trip per scene, on the same GPU
 * the renders need, and its value is in being pointed at the scenes in doubt.
 * One worker, an in-process queue and a polled status endpoint — the shape the
 * scene queue already uses, for the same reasons.
 */

export type SceneCheckEntryState = "pending" | "running" | "completed" | "failed" | "cancelled";

export type SceneCheckEntry = {
  projectId: string;
  sceneId: string;
  sceneNumber: number;
  depth: SceneCheckDepth;
  state: SceneCheckEntryState;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
};

type CheckStore = { entries: SceneCheckEntry[]; running: boolean; followUps: Map<string, RenderFollowUp> };

/**
 * "Check first" on a rerun: what to render once the checks finish.
 *
 * Scenes with an open error are held back and listed with the reason; the
 * rest go to the render queue exactly as the plain rerun would send them.
 */
export type RenderFollowUp = {
  scope: "keyframes" | "video";
  depth: SceneCheckDepth;
  sceneIds: string[];
  state: "waiting" | "queued" | "cancelled" | "failed";
  held?: { sceneId: string; sceneNumber: number; reason: string }[];
  queued?: number;
  cascaded?: boolean;
  error?: string;
};

const globalRef = globalThis as unknown as { __storyforgeSceneChecks?: CheckStore };

function store(): CheckStore {
  globalRef.__storyforgeSceneChecks ??= { entries: [], running: false, followUps: new Map() };
  globalRef.__storyforgeSceneChecks.followUps ??= new Map();
  return globalRef.__storyforgeSceneChecks;
}

export type SceneCheckProgress = {
  entries: SceneCheckEntry[];
  active: boolean;
  remaining: number;
  followUp?: RenderFollowUp;
};

export function getSceneCheckProgress(projectId: string): SceneCheckProgress {
  const entries = store().entries
    .filter((entry) => entry.projectId === projectId)
    .sort((a, b) => a.sceneNumber - b.sceneNumber);
  const remaining = entries.filter((e) => e.state === "pending" || e.state === "running").length;
  const followUp = store().followUps.get(projectId);
  return { entries, active: remaining > 0, remaining, ...(followUp ? { followUp } : {}) };
}

/**
 * Check the chosen scenes, then render the ones that pass.
 *
 * The checks run first, while the planning model is loaded; the render queue
 * then evicts it as it always does before GPU work. Doing it the other way
 * round would load the model back in the middle of a batch.
 */
export async function checkThenRender(
  projectId: string,
  sceneIds: readonly string[],
  depth: SceneCheckDepth,
  scope: "keyframes" | "video",
): Promise<SceneCheckEntry[]> {
  if (getQueue(projectId).active) {
    throw new ValidationError("A render is already running for this project. Wait for it to finish.");
  }
  const state = store();
  if (state.followUps.get(projectId)?.state === "waiting") {
    throw new ValidationError("A checked rerun is already waiting on its checks.");
  }
  const queued = await enqueueSceneChecks(projectId, sceneIds, depth);
  state.followUps.set(projectId, { scope, depth, sceneIds: [...sceneIds], state: "waiting" });
  // Every scene may already have been waiting at this depth, in which case
  // nothing was added and the drain will not come back round on its own.
  if (!queued.length && !getSceneCheckProgress(projectId).active) await resolveFollowUp(projectId);
  return queued;
}

async function resolveFollowUp(projectId: string): Promise<void> {
  const state = store();
  const followUp = state.followUps.get(projectId);
  if (!followUp || followUp.state !== "waiting") return;
  try {
    const record = await getProjectRecord(projectId);
    const scenes = record.storyboard?.scenes ?? [];
    const failedChecks = new Set(state.entries
      .filter((entry) => entry.projectId === projectId && entry.state === "failed")
      .map((entry) => entry.sceneId));
    const held: NonNullable<RenderFollowUp["held"]> = [];
    const cleared: string[] = [];
    for (const sceneId of followUp.sceneIds) {
      const scene = scenes.find((candidate) => candidate.id === sceneId);
      if (!scene) continue;
      const check = record.sceneChecks?.[sceneId]?.[followUp.depth];
      const errors = check ? openFindings(check).filter((finding) => finding.severity === "error") : [];
      if (failedChecks.has(sceneId) || !check) {
        held.push({ sceneId, sceneNumber: scene.sceneNumber, reason: "The check could not run." });
      } else if (check.coverage === "failed") {
        // Rule findings alone are not a review; a scene nobody could vouch for waits.
        held.push({
          sceneId,
          sceneNumber: scene.sceneNumber,
          reason: "The review returned nothing usable, so the scene could not be vouched for." +
            (check.detail ? ` ${check.detail}` : ""),
        });
      } else if (errors.length) {
        const top = errors[0]!;
        held.push({
          sceneId,
          sceneNumber: scene.sceneNumber,
          reason: `${top.code}: ${top.explanation}` + (errors.length > 1 ? ` (+${errors.length - 1} more)` : ""),
        });
      } else {
        cleared.push(sceneId);
      }
    }
    let queued = 0;
    let cascaded = false;
    if (cleared.length) {
      clearFinished(projectId);
      if (followUp.scope === "keyframes") {
        queued = (await enqueueKeyframeRerun(projectId, cleared)).entries.length;
      } else {
        const result = await enqueueVideoRerun(projectId, cleared);
        queued = result.entries.length;
        cascaded = result.cascaded;
      }
    }
    state.followUps.set(projectId, { ...followUp, state: "queued", held, queued, cascaded });
    if (held.length) {
      logEvent("scene_check.held", { projectId, scope: followUp.scope, held: held.length, queued });
    }
  } catch (err) {
    state.followUps.set(projectId, {
      ...followUp, state: "failed", error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Queue checks for the chosen scenes. Scenes already waiting at that depth are not queued twice. */
export async function enqueueSceneChecks(
  projectId: string,
  sceneIds: readonly string[],
  depth: SceneCheckDepth,
): Promise<SceneCheckEntry[]> {
  const record = await getProjectRecord(projectId);
  const scenes = record.storyboard?.scenes ?? [];
  if (!scenes.length) throw new ValidationError("Generate a storyboard before checking scenes.");
  const unknown = sceneIds.filter((id) => !scenes.some((scene) => scene.id === id));
  if (unknown.length) throw new NotFoundError(`Scene not found: ${unknown.join(", ")}`);

  const state = store();
  // A new run starts from a clean slate once nothing is left in flight.
  if (!getSceneCheckProgress(projectId).active) {
    state.entries = state.entries.filter((entry) => entry.projectId !== projectId);
    if (state.followUps.get(projectId)?.state !== "waiting") state.followUps.delete(projectId);
  }
  const waiting = new Set(state.entries
    .filter((e) => e.projectId === projectId && e.depth === depth && (e.state === "pending" || e.state === "running"))
    .map((e) => e.sceneId));

  const queued: SceneCheckEntry[] = [];
  for (const scene of scenes) {
    if (!sceneIds.includes(scene.id) || waiting.has(scene.id)) continue;
    const entry: SceneCheckEntry = {
      projectId, sceneId: scene.id, sceneNumber: scene.sceneNumber, depth, state: "pending",
    };
    state.entries.push(entry);
    queued.push(entry);
  }
  if (queued.length) {
    logEvent("scene_check.enqueued", { projectId, depth, scenes: queued.length });
    void drain();
  }
  return queued;
}

/** Abandon checks not yet started; the one running finishes. A waiting render is called off too. */
export function cancelSceneChecks(projectId: string): number {
  let cancelled = 0;
  for (const entry of store().entries) {
    if (entry.projectId === projectId && entry.state === "pending") {
      entry.state = "cancelled";
      entry.finishedAt = new Date().toISOString();
      cancelled += 1;
    }
  }
  const followUp = store().followUps.get(projectId);
  if (followUp?.state === "waiting") store().followUps.set(projectId, { ...followUp, state: "cancelled" });
  if (cancelled) logEvent("scene_check.cancelled", { projectId, cancelled });
  return cancelled;
}

async function drain(): Promise<void> {
  const state = store();
  if (state.running) return;
  state.running = true;
  try {
    for (;;) {
      const entry = state.entries.find((candidate) => candidate.state === "pending");
      if (!entry) break;
      entry.state = "running";
      entry.startedAt = new Date().toISOString();
      try {
        await checkSceneNow(entry.projectId, entry.sceneId, entry.depth);
        entry.state = "completed";
      } catch (err) {
        entry.state = "failed";
        entry.error = err instanceof Error ? err.message : String(err);
        logEvent("scene_check.failed", { projectId: entry.projectId, sceneId: entry.sceneId, error: entry.error });
      }
      entry.finishedAt = new Date().toISOString();
      if (!getSceneCheckProgress(entry.projectId).active) await resolveFollowUp(entry.projectId);
    }
  } finally {
    state.running = false;
  }
}

/**
 * Check one scene now and store the result.
 *
 * Used by the queue and by "check first" on a rerun, which needs the verdict
 * before deciding what to render.
 */
export async function checkSceneNow(
  projectId: string,
  sceneId: string,
  depth: SceneCheckDepth,
): Promise<SceneCheck> {
  const record = await getProjectRecord(projectId);
  const cast = await resolveProjectCast(record.project);
  const sources = sceneCheckSources(record, sceneId, cast);
  if (!sources) throw new NotFoundError(`Scene ${sceneId} not found`);
  logEvent("scene_check.started", { projectId, sceneId, depth });

  const input = buildSceneCheckInput(sources, depth);
  const rules = ruleFindings(sources);
  const provider = getPlanningProvider();
  const previous = record.sceneChecks?.[sceneId]?.[depth];
  const check = depth === "quick"
    ? await runQuickCheck({ input, rules, provider, previous, sceneId })
    : await runDeepCheck({
        input,
        rules,
        provider,
        previous,
        sceneId,
        visionConfigured: visionAvailable(),
        images: visionAvailable() ? await loadQcImages([sources.frames?.start, sources.frames?.end]) : [],
      });

  await saveCheck(projectId, sceneId, check);
  logEvent("scene_check.finished", {
    projectId, sceneId, depth, coverage: check.coverage, mode: check.mode,
    findings: check.findings.length, durationMs: check.durationMs,
  });
  return check;
}

/** Merge into the record as it is now; the check took long enough for it to move. */
async function saveCheck(projectId: string, sceneId: string, check: SceneCheck): Promise<void> {
  const latest = await getProjectRecord(projectId);
  const scene = latest.storyboard?.scenes.find((candidate) => candidate.id === sceneId);
  if (!scene) return;
  // Someone may have accepted a finding while this ran. Those acceptances are
  // read from the record as it stands now, not from the snapshot taken before
  // the model call, so they survive the save when the inputs are unchanged.
  const stored = latest.sceneChecks?.[sceneId]?.[check.depth];
  const accepted = stored?.inputHash === check.inputHash
    ? new Map(stored.findings.filter((finding) => finding.accepted).map((finding) => [finding.id, finding.accepted!]))
    : new Map();
  const merged: SceneCheck = {
    ...check,
    findings: check.findings.map((finding) =>
      accepted.has(finding.id) ? { ...finding, accepted: accepted.get(finding.id) } : finding),
  };
  const open = merged.findings.filter((finding) => finding.severity !== "info").length;
  await repository.update(projectId, {
    ...latest,
    sceneChecks: {
      ...(latest.sceneChecks ?? {}),
      [sceneId]: { ...(latest.sceneChecks?.[sceneId] ?? {}), [check.depth]: merged },
    },
    history: appendHistory(
      latest,
      "scene.checked",
      `Scene ${scene.sceneNumber} (${check.depth}): ${open} ${open === 1 ? "finding" : "findings"}` +
        (check.coverage === "complete" ? "" : `, ${check.coverage}`),
    ),
  });
}

export type SceneCheckSummary = Record<
  string,
  { quick: SceneCheckStatus; deep: SceneCheckStatus; currentHash: { quick: string; deep: string } }
>;

/** Every scene's check status against its current inputs. Computed here so nothing stale reads as passed. */
export async function summariseSceneChecks(record: ProjectRecord): Promise<SceneCheckSummary> {
  const cast = await resolveProjectCast(record.project);
  const summary: SceneCheckSummary = {};
  for (const scene of record.storyboard?.scenes ?? []) {
    const sources = sceneCheckSources(record, scene.id, cast);
    if (!sources) continue;
    const quickHash = sceneCheckInputHash(buildSceneCheckInput(sources, "quick"));
    const deepHash = sceneCheckInputHash(buildSceneCheckInput(sources, "deep"));
    const checks = record.sceneChecks?.[scene.id];
    summary[scene.id] = {
      quick: sceneCheckStatus(checks?.quick, quickHash),
      deep: sceneCheckStatus(checks?.deep, deepHash),
      currentHash: { quick: quickHash, deep: deepHash },
    };
  }
  return summary;
}

/** Mark a finding intentional, or take that back. Bound to the inputs it was judged against. */
export async function acceptSceneFinding(
  projectId: string,
  sceneId: string,
  depth: SceneCheckDepth,
  findingId: string,
  accepted: boolean,
): Promise<ProjectRecord> {
  const record = await getProjectRecord(projectId);
  const check = record.sceneChecks?.[sceneId]?.[depth];
  if (!check) throw new NotFoundError(`Scene ${sceneId} has no ${depth} check`);
  if (!check.findings.some((finding) => finding.id === findingId)) {
    throw new NotFoundError(`Finding ${findingId} not found`);
  }
  const findings = check.findings.map((finding) => {
    if (finding.id !== findingId) return finding;
    if (!accepted) {
      const { accepted: _gone, ...rest } = finding;
      return rest;
    }
    return { ...finding, accepted: { at: new Date().toISOString(), inputHash: check.inputHash } };
  });
  const updated: ProjectRecord = {
    ...record,
    sceneChecks: {
      ...(record.sceneChecks ?? {}),
      [sceneId]: { ...(record.sceneChecks?.[sceneId] ?? {}), [depth]: { ...check, findings } },
    },
  };
  await repository.update(projectId, updated);
  logEvent("scene_check.finding_accepted", { projectId, sceneId, depth, accepted });
  return updated;
}

// ---------------------------------------------------------------------------
// Fixes: previewed, then applied through the same path as a hand edit.

export type FixPreview = FixProposal & {
  sceneId: string;
  findingId: string;
  depth: SceneCheckDepth;
  /** Hash of the text being replaced; apply refuses if it has changed since. */
  sourceHash: string;
  /** How it was produced: the mechanical identity repair, or the model. */
  method: "rebuild" | "model";
};

const textHash = (text: string) => createHash("sha256").update(text).digest("hex");

function cardFields(scene: Scene): Record<CardFixField, string> {
  return {
    sceneObjective: scene.sceneObjective,
    storyBeat: scene.storyBeat,
    visualDescription: scene.visualDescription,
    actionDescription: scene.actionDescription,
    cameraMovement: scene.cameraMovement,
  };
}

/**
 * Propose the smallest change that resolves one finding, without applying it.
 *
 * A candidate that would raise a deterministic warning the scene does not
 * already have is not offered: a fix that trades one fault for another is not
 * a fix, and nobody reviewing a one-line diff would spot the new one.
 */
export async function previewSceneCheckFix(
  projectId: string,
  sceneId: string,
  depth: SceneCheckDepth,
  findingId: string,
): Promise<FixPreview> {
  const record = await getProjectRecord(projectId);
  const finding = record.sceneChecks?.[sceneId]?.[depth]?.findings.find((f) => f.id === findingId);
  if (!finding) throw new NotFoundError(`Finding ${findingId} not found`);
  const cast = await resolveProjectCast(record.project);
  const sources = sceneCheckSources(record, sceneId, cast);
  if (!sources) throw new NotFoundError(`Scene ${sceneId} not found`);
  const { scene, scenes, project, visualBible } = sources;

  let proposal: FixProposal | { error: string } | undefined;
  let method: FixPreview["method"] = "model";
  // The identity rule has a mechanical answer; the model is not needed for it.
  if (finding.origin === "rule" && finding.code === "identity_missing" &&
    (finding.field === "startFramePrompt" || finding.field === "endFramePrompt")) {
    const timeline = wardrobeTimeline(project, scenes, cast, visualBible);
    const rebuilt = rebuiltPrompts(scene, cast, timeline.get(scene.id), visualBible)[finding.field];
    if (rebuilt !== scene.prompts[finding.field]) {
      proposal = {
        kind: "prompt", field: finding.field, before: scene.prompts[finding.field], after: rebuilt,
        summary: "Stated the skin tone the visual bible gives, beside the name.",
      };
      method = "rebuild";
    }
  }
  proposal ??= await proposeFix({
    input: buildSceneCheckInput(sources, depth),
    finding,
    currentPrompts: {
      startFramePrompt: scene.prompts.startFramePrompt,
      endFramePrompt: scene.prompts.endFramePrompt,
      endFrameEditPrompt: scene.prompts.endFrameEditPrompt,
      videoPromptSegment: scene.prompts.videoPromptSegment,
    },
    currentCard: cardFields(scene),
    provider: getPlanningProvider(),
    sceneId,
  });
  if ("error" in proposal) throw new ValidationError(proposal.error);

  const context = storedSceneImageContext(project, scene, cast, visualBible, scenes);
  const before = new Set(storedPromptWarnings(scene, context));
  const candidate: Scene = proposal.kind === "prompt"
    ? { ...scene, prompts: { ...scene.prompts, [proposal.field]: proposal.after } }
    : { ...scene, [proposal.field]: proposal.after };
  const introduced = storedPromptWarnings(candidate, context).filter((warning) => !before.has(warning));
  if (introduced.length) {
    throw new ValidationError(
      `The proposed fix would introduce new problems (${introduced.join("; ")}), so it was not offered. ` +
        "Edit the prompt by hand, or run the check again for a different suggestion.",
    );
  }

  logEvent("scene_check.fix_previewed", { projectId, sceneId, depth, field: proposal.field, method });
  return { ...proposal, sceneId, findingId, depth, sourceHash: textHash(proposal.before), method };
}

/**
 * Apply a previewed fix, refusing if the text moved since the preview.
 *
 * Goes through the same services as a hand edit, so the next scene's carried
 * opening follows, warnings are recomputed and history records it — and the
 * scene's check then reads as out of date, which is the prompt to re-check it.
 */
export async function applySceneCheckFix(projectId: string, raw: unknown): Promise<ProjectRecord> {
  const body = sceneCheckFixApplySchema.parse(raw);
  const record = await getProjectRecord(projectId);
  const scene = record.storyboard?.scenes.find((candidate) => candidate.id === body.sceneId);
  if (!scene) throw new NotFoundError(`Scene ${body.sceneId} not found`);
  const current = body.kind === "prompt"
    ? scene.prompts[body.field as FixableField] ?? ""
    : cardFields(scene)[body.field as CardFixField];
  if (textHash(current) !== body.sourceHash) {
    throw new ValidationError("This scene changed after the fix was previewed. Preview the fix again.");
  }
  const updated = body.kind === "prompt"
    ? await updateScenePrompts(projectId, body.sceneId, { [body.field]: body.after })
    : await updateSceneCard(projectId, body.sceneId, { [body.field]: body.after });
  logEvent("scene_check.fix_applied", { projectId, sceneId: body.sceneId, field: body.field });
  return updated;
}
