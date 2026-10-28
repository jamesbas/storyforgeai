import { z } from "zod";

export const PROMPT_FIELD_LABELS = {
  startFramePrompt: "Start frame",
  endFramePrompt: "End frame",
  videoPromptSegment: "Video",
} as const;

export const promptFieldSchema = z.enum([
  "startFramePrompt",
  "endFramePrompt",
  "videoPromptSegment",
]);
export type PromptField = z.infer<typeof promptFieldSchema>;

const selection = {
  scope: z.enum(["all", "selected"]),
  sceneIds: z.array(z.string().min(1)).default([]),
  frames: z.enum(["start", "end", "both"]).default("both"),
};

function hasSelection(input: { scope: string; sceneIds: string[] }): boolean {
  return input.scope === "all" || input.sceneIds.length > 0;
}

export const addPromptTextSchema = z.object({
  ...selection,
  text: z.string().trim().min(1).max(8000),
  placement: z.enum(["append", "prepend"]),
}).strict().refine(hasSelection, { message: "Pick at least one scene." });

export const simplifyPromptsSchema = z.object({
  ...selection,
  target: z.enum(["image", "video", "both"]),
}).strict().refine(hasSelection, { message: "Pick at least one scene." });

const previewFields = {
  sceneId: z.string().min(1),
  sceneNumber: z.number().int().positive(),
  field: promptFieldSchema,
  sourceHash: z.string().min(1),
  before: z.string(),
};

export const simplifiedPromptSchema = z.object({
  ...previewFields,
  status: z.literal("ready"),
  after: z.string().trim().min(1).max(8000),
}).strict();

export const promptPreviewSchema = z.object({
  results: z.array(z.discriminatedUnion("status", [
    simplifiedPromptSchema,
    z.object({
      ...previewFields,
      status: z.literal("error"),
      error: z.string(),
    }).strict(),
  ])),
});
export type SimplifiedPrompt = z.infer<typeof simplifiedPromptSchema>;
export type PromptPreview = z.infer<typeof promptPreviewSchema>;

export const applySimplifiedPromptsSchema = z.object({
  results: z.array(simplifiedPromptSchema).min(1),
}).strict();

export function imagePromptFields(frames: "start" | "end" | "both"): PromptField[] {
  if (frames === "start") return ["startFramePrompt"];
  if (frames === "end") return ["endFramePrompt"];
  return ["startFramePrompt", "endFramePrompt"];
}
