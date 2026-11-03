import { ValidationError } from "@/lib/errors";
import type { WangpModelSchema } from "@/lib/schemas/wangp";
import type { ManifestOverrides } from "@/lib/wangp/settings";

type ModelIdentity = { modelType: string; baseModelType?: string };

export function isQwen21Model(model: ModelIdentity): boolean {
  return [model.modelType, model.baseModelType].some((type) =>
    type !== undefined && /^qwen_image_21(?:_|$)/i.test(type),
  );
}

export function isStandardQwen21Model(model: ModelIdentity): boolean {
  return isQwen21Model(model) &&
    ![model.modelType, model.baseModelType].some((type) => type && /(?:^|_)turbo(?:_|$)/i.test(type));
}

/** Standard checkpoint only; the distilled Turbo schedule and CFG remain model-owned. */
export function qwen21ImageOverrides(
  model: ModelIdentity,
  schema: WangpModelSchema,
): Pick<ManifestOverrides, "guidanceScale" | "sampleSolver" | "customSettings"> {
  if (!isStandardQwen21Model(model)) return {};
  const guidance = schema.fields.find((field) => field.name === "guidance_scale");
  if (!guidance && !("guidance_scale" in schema.defaultSettings)) {
    throw new ValidationError(`Model ${model.modelType} does not declare Guidance (CFG).`);
  }
  if ((guidance?.min !== undefined && guidance.min > 5) ||
      (guidance?.max !== undefined && guidance.max < 5) ||
      (guidance?.allowed && !guidance.allowed.includes(5))) {
    throw new ValidationError(`Model ${model.modelType} does not accept Guidance (CFG) 5.`);
  }
  return {
    guidanceScale: 5,
    sampleSolver: "default",
    customSettings: { qwen21_kv_cache: "INT8" },
  };
}
