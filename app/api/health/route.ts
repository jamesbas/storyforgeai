import { logEvent } from "@/lib/telemetry";

export const dynamic = "force-dynamic";

export function GET() {
  logEvent("health.check", {});
  return new Response("ok", {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
