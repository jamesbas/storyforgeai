/**
 * Server startup hook.
 *
 * Fails the boot when the bind address and the `Host` allowlist disagree, so an
 * unsafe network boundary is a startup error rather than something discovered
 * later by whoever finds the open port.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { config } = await import("@/lib/config");
  const { bindConfigError, isLoopbackBind } = await import("@/lib/security/bind-policy.mjs");
  const { parseAllowedHosts } = await import("@/lib/security/request-policy");

  const error = bindConfigError(config.access.bindHost, config.access.allowedHostsWasSet);
  if (error) throw new Error(error);

  const allowed = parseAllowedHosts(config.access.allowedHosts, config.access.port);
  console.log(
    JSON.stringify({
      event: "access.boundary",
      bindHost: config.access.bindHost,
      loopback: isLoopbackBind(config.access.bindHost),
      allowedHostCount: allowed.size,
    }),
  );

  // SPEC-008 FR-3: anything left mid-flight by the previous process is
  // reconciled before a drainer can touch it, so a restart cannot resubmit.
  if (config.flags.durableTasks) {
    const { reconcileStartup } = await import("@/lib/tasks/startup");
    await reconcileStartup();
  }
}
