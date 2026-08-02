/**
 * Bind-address policy (SPEC-007A-lite FR-8).
 *
 * Plain JavaScript so the production launcher can run this check *before* it
 * spawns Next, keeping the listening socket from ever opening on an unsafe
 * interface. `instrumentation.ts` runs the same check for the container, which
 * has no launcher, and the unit tests import it directly.
 */

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

/**
 * @param {string} host
 * @returns {boolean}
 */
export function isLoopbackBind(host) {
  const value = host.trim().toLowerCase();
  return LOOPBACK_HOSTS.has(value) || value.startsWith("127.");
}

/**
 * Binding wider than loopback is only safe once the operator has named the
 * hostnames they expect, because the default allowlist covers loopback alone.
 *
 * @param {string} bindHost
 * @param {boolean} allowedHostsWasSet
 * @returns {string | null} the reason to refuse, or null when the pair is coherent
 */
export function bindConfigError(bindHost, allowedHostsWasSet) {
  if (isLoopbackBind(bindHost) || allowedHostsWasSet) return null;
  return (
    `STORYFORGE_BIND_HOST is set to "${bindHost}", which is not loopback, but ` +
    "STORYFORGE_ALLOWED_HOSTS was left at its default. Set STORYFORGE_ALLOWED_HOSTS " +
    "to the hostnames you expect to serve (for example your Tailscale name) before " +
    "binding beyond 127.0.0.1."
  );
}
