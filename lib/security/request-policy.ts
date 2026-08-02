/**
 * Request-policy rules for the network trust boundary (SPEC-007A-lite).
 *
 * Kept apart from `middleware.ts` and from `lib/config.ts` so the rules can be
 * unit tested directly and so the module stays Edge-safe — it reads nothing but
 * strings, with no `node:` imports.
 */

/** Methods that can change state. GET/HEAD/OPTIONS are safe to serve cross-site. */
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export type DenyReason = "host" | "cross_site";

export type PolicyRequest = {
  method: string;
  host: string | null;
  origin: string | null;
  secFetchSite: string | null;
};

/**
 * Split a comma-separated allowlist and admit each entry both bare and with the
 * port, so `STORYFORGE_ALLOWED_HOSTS=box.tailnet.ts.net` works whether or not
 * the browser includes `:3200` in the `Host` header.
 */
export function parseAllowedHosts(raw: string, port: string): Set<string> {
  const hosts = new Set<string>();
  for (const entry of raw.split(",")) {
    const value = entry.trim().toLowerCase();
    if (!value) continue;
    hosts.add(value);
    if (!value.includes(":") || value.startsWith("[")) hosts.add(`${value}:${port}`);
  }
  return hosts;
}

/** `[::1]:3200` must not be split on its colons the way `host:port` is. */
function stripPort(host: string): string {
  if (host.startsWith("[")) {
    const close = host.indexOf("]");
    return close === -1 ? host : host.slice(0, close + 1);
  }
  const colon = host.indexOf(":");
  return colon === -1 ? host : host.slice(0, colon);
}

export function isAllowedHost(host: string | null, allowed: ReadonlySet<string>): boolean {
  if (!host) return false;
  const value = host.trim().toLowerCase();
  if (!value) return false;
  return allowed.has(value) || allowed.has(stripPort(value));
}

/** An `Origin` is acceptable when its host component is on the same allowlist. */
function isAllowedOrigin(origin: string, allowed: ReadonlySet<string>): boolean {
  if (origin === "null") return false;
  try {
    return isAllowedHost(new URL(origin).host, allowed);
  } catch {
    return false;
  }
}

/**
 * Decide whether a request may proceed.
 *
 * `Sec-Fetch-Site` is preferred over `Origin` because page script cannot set it
 * — it is a forbidden header name, so a hostile page cannot forge `same-origin`.
 *
 * A request carrying neither header is allowed: that is the CLI/`tsx` case, and
 * the attack this guards against needs the operator's browser as its vehicle.
 * A non-browser client can already talk to the port directly.
 */
export function evaluateRequest(
  request: PolicyRequest,
  allowed: ReadonlySet<string>,
): { allowed: true } | { allowed: false; reason: DenyReason } {
  if (!isAllowedHost(request.host, allowed)) return { allowed: false, reason: "host" };

  if (!UNSAFE_METHODS.has(request.method.toUpperCase())) return { allowed: true };

  const site = request.secFetchSite?.trim().toLowerCase();
  if (site) {
    // `none` means no initiator — a typed URL or bookmark. A hostile page
    // cannot produce it; page-initiated requests are always same-origin,
    // same-site or cross-site. `same-site` is refused because a sibling host on
    // the same tailnet domain is not this app.
    return site === "same-origin" || site === "none"
      ? { allowed: true }
      : { allowed: false, reason: "cross_site" };
  }

  const origin = request.origin?.trim();
  if (origin && !isAllowedOrigin(origin, allowed)) {
    return { allowed: false, reason: "cross_site" };
  }

  return { allowed: true };
}
