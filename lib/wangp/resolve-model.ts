import type { WangpModel } from "@/lib/schemas/wangp";
import { findPinned } from "@/lib/wangp/model-router";
import { logEvent } from "@/lib/telemetry";

/**
 * Resolve a model pin or fall back to automatic selection, and make the choice
 * visible.
 *
 * WanGP accepts a job for a model it does not have installed and downloads the
 * weights first — tens of gigabytes, with no progress signal on the MCP side.
 * A silent stall is the worst outcome, so an uninstalled selection is logged
 * explicitly.
 */
export function resolveModel(
  models: WangpModel[],
  pinned: string | undefined,
  fallback: () => WangpModel | null,
  purpose: string,
  /**
   * Off when the caller is only asking what *would* be chosen. A preview that
   * logged would fill the record with selections no job ever made.
   */
  options: { log?: boolean } = {},
): WangpModel {
  const log = options.log ?? true;
  const pin = findPinned(models, pinned);

  if (log && pinned && !pin) {
    logEvent("wangp.model.selected", {
      purpose,
      pinned: pinned,
      resolved: false,
      reason: "pinned_model_not_in_catalog",
    });
  }

  const model = pin ?? fallback();
  if (!model) throw new Error(`No suitable ${purpose} model available`);

  const availability = model.metadata.availability ?? "unknown";
  if (log) {
    logEvent("wangp.model.selected", {
      purpose,
      modelType: model.modelType,
      pinned: Boolean(pin),
      availability,
      ...(availability === "missing"
        ? { warning: "weights_not_installed_wangp_will_download_first" }
        : {}),
    });
  }

  return model;
}
