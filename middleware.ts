import { NextResponse, type NextRequest } from "next/server";
import { evaluateRequest, parseAllowedHosts, type DenyReason } from "@/lib/security/request-policy";

/**
 * The network trust boundary (SPEC-007A-lite).
 *
 * Two things are closed here. A `Host` outside the allowlist is refused, which
 * defeats DNS rebinding — an attacker's domain re-resolving to 127.0.0.1 becomes
 * same-origin to the browser, so CORS stops applying and only the `Host` header
 * still gives the game away. And a cross-site state-changing request is refused,
 * because a plain HTML form POST needs no preflight and several routes here take
 * no request body at all.
 *
 * Reads `process.env` rather than `lib/config.ts` to stay Edge-safe.
 */
const PORT = process.env.PORT?.trim() || "3200";
const ALLOWED_HOSTS = parseAllowedHosts(
  process.env.STORYFORGE_ALLOWED_HOSTS?.trim() || "localhost,127.0.0.1,[::1]",
  PORT,
);

function deny(request: NextRequest, reason: DenyReason) {
  // Never echo the offending Host or Origin: it confirms what the caller
  // guessed, and it is the one thing an attacker is probing for.
  console.warn(
    JSON.stringify({
      event: "access.denied",
      reason,
      method: request.method,
      path: request.nextUrl.pathname,
    }),
  );
  return new NextResponse("Forbidden", {
    status: 403,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

export function middleware(request: NextRequest) {
  const verdict = evaluateRequest(
    {
      method: request.method,
      host: request.headers.get("host"),
      origin: request.headers.get("origin"),
      secFetchSite: request.headers.get("sec-fetch-site"),
    },
    ALLOWED_HOSTS,
  );

  return verdict.allowed ? NextResponse.next() : deny(request, verdict.reason);
}

export const config = {
  /**
   * Everything except Next's own build output and the favicon. Media routes and
   * page routes are both in scope: a rebinding attacker reading project data is
   * exactly the case the Host check exists for.
   */
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
