import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "@/lib/config";
import { logEvent } from "@/lib/telemetry";
import { redactDetail } from "@/lib/schemas/provenance";
import type { WangpRestartOutcome } from "@/lib/schemas/schedule";
import { getWangpClient } from "@/lib/wangp/factory";
import { getWangpStatus, type WangpStatus } from "@/lib/services/wangp-service";
import { isGenerationBusy } from "@/lib/services/generation-busy";

/**
 * Restart a launcher-managed WanGP to free its GPU memory (§8.6, FR-15a).
 *
 * WanGP can keep the last image or video model resident after a batch, and MCP
 * has no call that releases it. A storyboard run after a render then finds the
 * card full and the planning model cannot load. Restarting the server is how
 * this machine's batch workflow already frees the card, so this reuses the
 * launcher's own `-Action Restart` rather than reimplementing process control.
 *
 * Never fails the caller: every outcome is a value, because the storyboard run
 * that wanted the memory does not need WanGP itself.
 */

export type WangpRestartResult = {
  outcome: WangpRestartOutcome;
  seconds: number;
  detail?: string;
};

type ExecResult = { code: number; output: string };

export type RestartDeps = {
  exec?: (file: string, args: string[], timeoutMs: number) => Promise<ExecResult>;
  status?: () => Promise<WangpStatus>;
  sleep?: (ms: number) => Promise<void>;
  isMock?: () => boolean;
  launcherPath?: string;
  pollMs?: number;
};

export function defaultLauncherPath(): string {
  return (
    config.wangp.launcherPath ||
    path.join(process.cwd(), "wan2gp-mcp-launcher", "Wan2GP-MCP-Launcher.ps1")
  );
}

/** Whether a restart can happen at all — for the queue's row hint (§7.3). */
export async function wangpRestartAvailable(launcherPath = defaultLauncherPath()): Promise<boolean> {
  if (!config.scheduler.wangpRestart) return false;
  if (getWangpClient().mode === "mock") return false;
  return fs
    .access(launcherPath)
    .then(() => true)
    .catch(() => false);
}

/**
 * The bind host and port StoryForge dials. Passed explicitly so a Tailscale
 * outage at 3 AM cannot make the launcher fall back to 127.0.0.1.
 */
export function bindFromUrl(url: string): { host: string; port: string } | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname === "localhost" ? "127.0.0.1" : parsed.hostname;
    const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    if (!host) return null;
    return { host, port };
  } catch {
    return null;
  }
}

const runExecFile: NonNullable<RestartDeps["exec"]> = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    // execFile, no shell: the script path is configuration and the arguments
    // come from WANGP_MCP_URL. Nothing from a request reaches this line.
    execFile(file, args, { windowsHide: true, timeout: timeoutMs }, (error, stdout, stderr) => {
      const code =
        error && typeof (error as { code?: unknown }).code === "number"
          ? ((error as { code: number }).code)
          : error
            ? 1
            : 0;
      resolve({ code, output: `${stdout ?? ""}${stderr ?? ""}` });
    });
  });

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function restartWangp(deps: RestartDeps = {}): Promise<WangpRestartResult> {
  const began = Date.now();
  const elapsed = () => Math.round((Date.now() - began) / 1000);
  const launcherPath = deps.launcherPath ?? defaultLauncherPath();
  const isMock = deps.isMock ?? (() => getWangpClient().mode === "mock");
  const status = deps.status ?? getWangpStatus;
  const sleep = deps.sleep ?? wait;
  const pollMs = deps.pollMs ?? 5_000;

  const finish = (result: WangpRestartResult): WangpRestartResult => {
    const safe = { ...result, detail: redactDetail(result.detail) };
    logEvent("scheduler.wangp_restart", { outcome: safe.outcome, seconds: safe.seconds, detail: safe.detail });
    return safe;
  };

  if (!config.scheduler.wangpRestart) {
    return finish({ outcome: "skipped", seconds: 0, detail: "Turned off (SCHEDULER_WANGP_RESTART=false)." });
  }
  if (isMock()) {
    return finish({ outcome: "skipped", seconds: 0, detail: "WanGP is in mock mode." });
  }
  const script = await fs.readFile(launcherPath, "utf8").catch(() => null);
  if (script === null) {
    return finish({ outcome: "skipped", seconds: 0, detail: "The WanGP launcher script was not found." });
  }
  // The launcher kills the whole WanGP process tree, including any job on it.
  if (isGenerationBusy()) {
    return finish({ outcome: "skipped", seconds: 0, detail: "Generation was still running." });
  }
  const bind = bindFromUrl(config.wangp.url);
  if (!bind) {
    return finish({ outcome: "skipped", seconds: 0, detail: "WANGP_MCP_URL could not be parsed." });
  }

  const args = [
    "-NoLogo",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    launcherPath,
    "-Action",
    "Restart",
    // Without it the script ends on Read-Host and hangs until the timeout.
    "-NoPause",
    "-BindAddress",
    bind.host,
    "-Port",
    bind.port,
    ...(/\bNoClipboard\b/.test(script) ? ["-NoClipboard"] : []),
  ];

  const timeoutMs = config.wangp.restartTimeoutMs;
  const { code, output } = await (deps.exec ?? runExecFile)("powershell.exe", args, timeoutMs);
  const notManaged = /No launcher-managed/i.test(output);

  // The exit code proves nothing: the launcher exits 0 even when WanGP dies
  // during startup. Healthy within the timeout is the only success.
  const deadline = began + timeoutMs;
  const polls = Math.max(1, Math.ceil(Math.max(0, deadline - Date.now()) / pollMs));
  for (let poll = 0; poll <= polls; poll += 1) {
    const current = await status().catch(() => null);
    if (current?.ok && current.filesystemReads !== false) {
      if (notManaged) {
        return finish({
          outcome: "not_managed",
          seconds: elapsed(),
          detail: "WanGP wasn't started by the launcher, so it was left running.",
        });
      }
      return finish({ outcome: "restarted", seconds: elapsed() });
    }
    if (poll === polls || Date.now() + pollMs > deadline) break;
    await sleep(pollMs);
  }

  return finish({
    outcome: "unhealthy",
    seconds: elapsed(),
    detail: notManaged
      ? "WanGP wasn't started by the launcher and is not answering."
      : `WanGP did not come back healthy after the restart${code ? ` (launcher exit ${code})` : ""}.`,
  });
}
