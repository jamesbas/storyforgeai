import type { LoraKind, LoraSelection, SceneLoraMap, LoraSelectionSet } from "@/lib/schemas/lora";

/**
 * Which LoRAs apply to a scene.
 *
 * Kept in its own module with no runtime dependencies so both the server (during
 * generation) and the browser (to preview trigger words) can use the same rule.
 * Two implementations of "which LoRAs does this scene use" would drift, and the
 * preview would then lie about what is going to be generated.
 *
 * A scene either inherits the storyboard-wide selection or replaces it outright;
 * there is deliberately no merge.
 */
export function resolveSceneLoras(
  project: { loras?: LoraSelectionSet; sceneLoras?: SceneLoraMap },
  sceneId: string,
  kind: LoraKind,
): LoraSelection[] {
  const projectSelection = project.loras?.[kind] ?? [];
  const override = project.sceneLoras?.[sceneId];
  if (!override || override.mode !== "override") return projectSelection;
  return override[kind] ?? [];
}
