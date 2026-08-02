import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { bindConfigError } from "../lib/security/bind-policy.mjs";

/**
 * Launch `next start` on the configured interface.
 *
 * A launcher rather than an inline npm script because `$VAR` does not expand in
 * cmd.exe and `%VAR%` does not expand in sh, and this app is developed on
 * Windows but containerised on Alpine.
 *
 * Next's CLI is invoked through `process.execPath` rather than `npx`: Node 24
 * refuses to spawn a `.cmd` shim without a shell, and adding a shell would put
 * path quoting back in play.
 */
const host = process.env.STORYFORGE_BIND_HOST?.trim() || "127.0.0.1";
const port = process.env.PORT?.trim() || "3200";

// Checked here rather than only in the server, so an unsafe pair never opens a
// listening socket at all.
const error = bindConfigError(host, Boolean(process.env.STORYFORGE_ALLOWED_HOSTS?.trim()));
if (error) {
  console.error(error);
  process.exit(1);
}

const nextCli = createRequire(import.meta.url).resolve("next/dist/bin/next");

const child = spawn(process.execPath, [nextCli, "start", "-H", host, "-p", port], {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
