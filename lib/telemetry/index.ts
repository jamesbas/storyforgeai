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
  | "wangp.discovery"
  | "wangp.job.submitted"
  | "wangp.job.polled"
  | "scene.qc"
  | "assembly.completed"
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
