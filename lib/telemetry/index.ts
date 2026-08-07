/**
 * Structured JSON telemetry. Fire-and-forget; never throws into a request path
 * (generic-build-spec Section 5.5).
 */

export type TelemetryEvent =
  | "project.created"
  | "project.imported"
  | "project.concept_image_added"
  | "project.concept_image_removed"
  | "project.concept_visuals"
  | "project.concept_fidelity"
  | "canvas_queue.enqueued"
  | "scene.video_only"
  | "canvas_queue.cancelled"
  | "canvas_queue.failed"
  | "project.updated"
  | "project.deleted"
  | "project.restored"
  | "project.load_failed"
  | "storyboard.generated"
  | "storyboard.exported"
  | "agent.run"
  | "agent.run_started"
  | "agent.run_finished"
  | "agent.llm.failed"
  | "agent.fallback"
  | "prompt.composed"
  | "task.created"
  | "task.transition"
  | "task.cancel_requested"
  | "task.retry"
  | "task.stop_tracking"
  | "task.reconciled"
  | "task.quarantined"
  | "task.drain_skipped"
  | "scene_queue.skipped_existing"
  | "llm.runtime"
  | "wangp.discovery"
  | "wangp.model.selected"
  | "wangp.health.failed"
  | "wangp.job.submitted"
  | "wangp.job.polled"
  | "wangp.reference_images.trimmed"
  | "wangp.negative.folded"
  | "wangp.h3_format.applied"
  | "wangp.ref2va.composed"
  | "wangp.ref2va.short_prompt"
  | "wangp.steps.resolved"
  | "wangp.resolution.resolved"
  | "wangp.resolution.clamped"
  | "scene.qc"
  | "qc.mode"
  | "qc.image_skipped"
  | "image.skipped"
  | "agent.llm.images_dropped"
  | "scene.continuity"
  | "scene.keyframe_preview"
  | "scene.keyframe_preview_cleared"
  | "scene.seed_cleared"
  | "scene.frame_imported"
  | "face_swap.applied"
  | "face_swap.manual"
  | "face_swap.reverted"
  | "face_swap.skipped"
  | "face_swap.reference_ignored"
  | "lora.dropped"
  | "scene_queue.enqueued"
  | "scene_queue.cancelled"
  | "scene_queue.failed"
  | "scene_queue.gpu_freed"
  | "audio_cue.generated"
  | "assembly.completed"
  | "assembly.prerequisite_failed"
  | "variant_set.repaired"
  | "character.created"
  | "character.updated"
  | "character.deleted"
  | "character.reference_image_set"
  | "health.check";

export function logEvent(event: TelemetryEvent, data: Record<string, unknown> = {}): void {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...data,
    });
    console.log(line);
  } catch {
    // Telemetry must never break the caller.
  }
}
