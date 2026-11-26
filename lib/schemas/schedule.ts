import { z } from "zod";

/**
 * The project run schedule: one ordered list of runs, across every project.
 *
 * Operational state only — ids, titles, options and short redacted reasons.
 * Never prompts or media: the file is rewritten on every transition and is not
 * a place for a scene's dialogue to end up.
 */

export const SCHEDULE_SCHEMA_VERSION = 1;

export const RUN_TYPES = ["storyboard", "keyframes", "video"] as const;
export const runTypeSchema = z.enum(RUN_TYPES);
export type RunType = (typeof RUN_TYPES)[number];

export const SCHEDULE_STATES = ["idle", "running", "paused", "completed"] as const;
export const scheduleStateSchema = z.enum(SCHEDULE_STATES);
export type ScheduleState = (typeof SCHEDULE_STATES)[number];

export const ITEM_STATES = [
  "queued",
  "invalid",
  "running",
  "completed",
  "completed_with_errors",
  "failed",
  "skipped",
  "cancelled",
  "interrupted",
] as const;
export const itemStateSchema = z.enum(ITEM_STATES);
export type ItemState = (typeof ITEM_STATES)[number];

/** Finished: nothing further happens to the item on its own. */
export const FINISHED_ITEM_STATES: readonly ItemState[] = [
  "completed",
  "completed_with_errors",
  "failed",
  "skipped",
  "cancelled",
  "interrupted",
];

/** What may be requeued as a fresh copy (FR-21). */
export const REQUEUEABLE_ITEM_STATES: readonly ItemState[] = [
  "completed_with_errors",
  "failed",
  "skipped",
  "cancelled",
  "interrupted",
];

export const isFinishedItem = (state: ItemState) => FINISHED_ITEM_STATES.includes(state);

export const MAX_QUEUED_ITEMS = 100;
export const MAX_SCENES_PER_ITEM = 200;
export const MAX_REASON_CHARS = 200;

export const RUN_TYPE_LABELS: Record<RunType, string> = {
  storyboard: "Storyboard",
  keyframes: "Keyframes",
  video: "Video",
};

const reason = z.string().max(MAX_REASON_CHARS + 1);

export const scheduleScopeSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("all") }),
  z.object({
    mode: z.literal("selected"),
    sceneIds: z.array(z.string().min(1)).min(1).max(MAX_SCENES_PER_ITEM),
    /** Kept for display: the numbers and titles at the time of picking. */
    sceneNumbers: z.array(z.number().int()).max(MAX_SCENES_PER_ITEM).default([]),
    sceneTitles: z.array(z.string().max(200)).max(MAX_SCENES_PER_ITEM).optional(),
  }),
]);
export type ScheduleScope = z.infer<typeof scheduleScopeSchema>;

export const scheduleOptionsSchema = z.object({
  /** Keyframes with All scenes only. */
  keyframes: z.enum(["missing", "rerender"]).optional(),
  /** Video only. */
  redoFinished: z.boolean().optional(),
});
export type ScheduleOptions = z.infer<typeof scheduleOptionsSchema>;

export const itemSummarySchema = z.object({
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  cascaded: z.boolean().optional(),
  /** Keyframe reruns under `reuse_end_frame`: scenes left on a stale inherited frame. */
  followOn: z.array(z.number().int()).optional(),
  /** Picked scenes that no longer existed at dispatch. */
  droppedScenes: z.array(z.number().int()).optional(),
  firstError: reason.optional(),
  notes: z.array(reason).max(10).optional(),
});
export type ItemSummary = z.infer<typeof itemSummarySchema>;

export const WANGP_RESTART_OUTCOMES = ["restarted", "not_managed", "unhealthy", "skipped"] as const;
export type WangpRestartOutcome = (typeof WANGP_RESTART_OUTCOMES)[number];

export const itemPreparationSchema = z.object({
  wangpRestart: z
    .object({
      outcome: z.enum(WANGP_RESTART_OUTCOMES),
      seconds: z.number().nonnegative(),
      detail: reason.optional(),
    })
    .nullable()
    .default(null),
  planningModelLoaded: z.boolean().nullable().default(null),
  warnings: z.array(reason).max(10).default([]),
});
export type ItemPreparation = z.infer<typeof itemPreparationSchema>;

export const scheduleItemSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  projectTitle: z.string().max(300),
  runType: runTypeSchema,
  scope: scheduleScopeSchema,
  options: scheduleOptionsSchema.default({}),
  state: itemStateSchema,
  reason: reason.optional(),
  addedAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  /** Time spent waiting for a run already on the GPU before this one began. */
  waitedSeconds: z.number().nonnegative().optional(),
  summary: itemSummarySchema.optional(),
  preparation: itemPreparationSchema.optional(),
  correlationId: z.string().optional(),
  durableTaskId: z.string().nullable().optional(),
});
export type ScheduleItem = z.infer<typeof scheduleItemSchema>;

export const restartNoticeSchema = z.object({
  itemId: z.string(),
  label: z.string(),
  at: z.string(),
});

export const runScheduleSchema = z.object({
  schemaVersion: z.literal(SCHEDULE_SCHEMA_VERSION),
  revision: z.number().int().nonnegative(),
  state: scheduleStateSchema,
  startedAt: z.string().optional(),
  restartNotice: restartNoticeSchema.nullable().default(null),
  items: z.array(scheduleItemSchema),
});
export type RunSchedule = z.infer<typeof runScheduleSchema>;

export function emptySchedule(): RunSchedule {
  return {
    schemaVersion: SCHEDULE_SCHEMA_VERSION,
    revision: 0,
    state: "idle",
    restartNotice: null,
    items: [],
  };
}

export function itemLabel(item: Pick<ScheduleItem, "runType" | "projectTitle">): string {
  return `${RUN_TYPE_LABELS[item.runType]} — ${item.projectTitle}`;
}

/** Input for adding an item; the server fills in the rest. */
export const newScheduleItemSchema = z.object({
  projectId: z.string().min(1),
  runType: runTypeSchema,
  scope: z
    .union([
      z.object({ mode: z.literal("all") }),
      z.object({
        mode: z.literal("selected"),
        sceneIds: z.array(z.string().min(1)).min(1).max(MAX_SCENES_PER_ITEM),
      }),
    ])
    .default({ mode: "all" }),
  options: scheduleOptionsSchema.default({}),
});
export type NewScheduleItem = z.infer<typeof newScheduleItemSchema>;

export const editScheduleItemSchema = z.object({
  scope: newScheduleItemSchema.shape.scope.optional(),
  options: scheduleOptionsSchema.optional(),
});
