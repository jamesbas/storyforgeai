import { z } from "zod";
import { maybe } from "@/lib/schemas/maybe";

/**
 * Durable task state (SPEC-008). See ADR-008 in the spec for the decision record.
 *
 * Task records are operational, not creative: ids, states and versions only.
 * Never prompts, media payloads, secrets or unbounded errors — a task file is
 * written on every transition and read by the recovery UI, and neither is a
 * place for a scene's dialogue to end up.
 */

/** Refuse to parse a newer major rather than silently dropping fields. */
export const TASK_SCHEMA_VERSION = 1;

export const TASK_STATES = [
  "pending",
  /**
   * Intent persisted, backend not yet confirmed to have accepted.
   *
   * The whole point of the durable model: written *before* a non-idempotent
   * WanGP submission, so a restart in the submit window is detectable.
   */
  "submitting",
  "submitted",
  "running",
  /** Startup is checking with the backend what actually happened. */
  "reconciling",
  "completed",
  "failed",
  "retry_pending",
  "cancelled",
  /** Cancel asked for, but work is in flight — "stop after current". */
  "cancel_requested",
  /** Was running; the backend can no longer confirm it. Needs a human. */
  "interrupted",
  /**
   * Restarted between backend acceptance and job-id persistence.
   *
   * Never auto-resubmitted: generation is not idempotent, and a duplicate costs
   * real GPU minutes against the same scene.
   */
  "submission_unknown",
  /** Operator gave up waiting; the backend job may still be running. */
  "stop_tracking",
] as const;
export const taskStateSchema = z.enum(TASK_STATES);
export type TaskState = (typeof TASK_STATES)[number];

/** No further transition happens on its own. */
export const TERMINAL_STATES: readonly TaskState[] = [
  "completed",
  "failed",
  "cancelled",
  "stop_tracking",
];

/** Stuck until a human decides; deliberately not terminal and never pruned. */
export const NEEDS_OPERATOR_STATES: readonly TaskState[] = ["interrupted", "submission_unknown"];

export function isTerminal(state: TaskState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function needsOperator(state: TaskState): boolean {
  return NEEDS_OPERATOR_STATES.includes(state);
}

/** Work is outstanding: neither finished nor waiting on a person. */
export function isActive(state: TaskState): boolean {
  return !isTerminal(state) && !needsOperator(state);
}

export const TASK_KINDS = ["scene_batch", "canvas_run", "planning"] as const;
export const taskKindSchema = z.enum(TASK_KINDS);
export type TaskKind = (typeof TASK_KINDS)[number];

/** Matches media-service `PhaseName`, plus the canvas run's single phase. */
export const TASK_PHASES = ["keyframes", "face_swap", "video", "qc", "plan"] as const;
export const taskPhaseSchema = z.enum(TASK_PHASES);
export type TaskPhase = (typeof TASK_PHASES)[number];

export const MAX_TASKS_PER_PROJECT = 25;
export const MAX_ENTRIES_PER_TASK = 200;
export const MAX_HISTORY_PER_ENTRY = 20;
export const MAX_ERROR_CHARS = 200;

/** One state change, kept so a failure can be explained after the fact. */
export const taskTransitionSchema = z.object({
  at: z.string(),
  from: taskStateSchema,
  to: taskStateSchema,
  /** Redacted and truncated. Never a prompt or a response body. */
  detail: maybe(z.string().max(MAX_ERROR_CHARS)),
});
export type TaskTransition = z.infer<typeof taskTransitionSchema>;

export const taskEntrySchema = z.object({
  /** Stable across retries, unlike the old (projectId, sceneId) pairing. */
  id: z.string(),
  /** Scene id for media work, agent key for a canvas run. */
  ref: z.string(),
  label: z.string(),
  /** Orders the UI and the drainer. Scene number, or position in the run. */
  order: z.number().int().nonnegative(),
  state: taskStateSchema,
  phase: maybe(taskPhaseSchema),
  attempts: z.number().int().nonnegative().default(0),
  /**
   * The backend's own job id, persisted the moment it is known.
   *
   * Its presence is what separates "resume by polling" from
   * "ask a human what happened".
   */
  externalJobId: maybe(z.string()),
  /** SPEC-004 execution this entry's inputs came from. Ids only. */
  executionId: maybe(z.string()),
  composerVersion: maybe(z.string()),
  error: maybe(z.string().max(MAX_ERROR_CHARS)),
  startedAt: maybe(z.string()),
  finishedAt: maybe(z.string()),
  history: z.array(taskTransitionSchema).default([]),
});
export type TaskEntry = z.infer<typeof taskEntrySchema>;

export const taskSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  kind: taskKindSchema,
  state: taskStateSchema,
  phase: maybe(taskPhaseSchema),
  /** Groups this task with the SPEC-004 executions from the same user action. */
  correlationId: maybe(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
  entries: z.array(taskEntrySchema).max(MAX_ENTRIES_PER_TASK).default([]),
  /** Set when the operator asked to stop; drives "stop after current". */
  cancelRequestedAt: maybe(z.string()),
});
export type Task = z.infer<typeof taskSchema>;

/**
 * Cooperative single-host lease. Not a distributed lock — two Node processes on
 * one data directory would still race, as they already do for project.json.
 */
export const taskLeaseSchema = z.object({
  owner: z.string(),
  heldUntil: z.string(),
});
export type TaskLease = z.infer<typeof taskLeaseSchema>;

export const taskFileSchema = z.object({
  schemaVersion: z.number().int().positive(),
  /** Monotonic; lets the UI poll for change and makes a stale write visible. */
  revision: z.number().int().nonnegative(),
  tasks: z.array(taskSchema).default([]),
  lease: maybe(taskLeaseSchema),
});
export type TaskFile = z.infer<typeof taskFileSchema>;

export function emptyTaskFile(): TaskFile {
  return { schemaVersion: TASK_SCHEMA_VERSION, revision: 0, tasks: [] };
}
