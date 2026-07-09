import { z } from "zod";
import { projectSchema } from "@/lib/schemas/project";
import { sceneSchema } from "@/lib/schemas/storyboard";
import { creativeBriefSchema, visualBibleSchema } from "@/lib/schemas/agents";

/**
 * Machine-consumable export artifact. Validated before it leaves the system
 * (generic-build-spec Section 5.3 / 7).
 */
export const storyboardExportSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string(),
  project: projectSchema,
  brief: creativeBriefSchema,
  visualBible: visualBibleSchema,
  scenes: z.array(sceneSchema),
});
export type StoryboardExport = z.infer<typeof storyboardExportSchema>;
