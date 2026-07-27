/**
 * Structured JSON telemetry. Fire-and-forget; never throws into a request path
 * (generic-build-spec Section 5.5).
 */

export type TelemetryEvent =
  | "project.created"
  | "project.updated"
  | "storyboard.generated"
  | "storyboard.exported"
  | "agent.run"
  | "agent.llm.failed"
  | "wangp.discovery"
  | "wangp.model.selected"
  | "wangp.health.failed"
  | "wangp.job.submitted"
  | "wangp.job.polled"
  | "scene.qc"
  | "audio_cue.generated"
  | "assembly.completed"
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
    // eslint-disable-next-line no-console
    console.log(line);
  } catch {
    // Telemetry must never break the caller.
  }
}
