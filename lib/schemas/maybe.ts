import { z } from "zod";

/**
 * An optional field that survives OpenAI's strict JSON Schema mode.
 *
 * Strict mode refuses a bare `.optional()`, and a schema it refuses never
 * reaches the server as `json_schema` at all — the request silently falls back
 * to unconstrained text, which is how a small local model ends up returning
 * plausible JSON with the wrong keys.
 *
 * `.nullish()` is accepted, and the transform folds the `null` a model may now
 * send back to `undefined`. Stored records and inferred types are therefore
 * unchanged: an absent value stays absent rather than becoming an explicit null.
 */
export function maybe<T extends z.ZodTypeAny>(schema: T) {
  return schema.nullish().transform((value) => value ?? undefined);
}
