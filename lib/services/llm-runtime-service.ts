import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "@/lib/config";
import { ValidationError } from "@/lib/errors";
import { logEvent } from "@/lib/telemetry";

/**
 * Control of the local LM Studio runtime.
 *
 * Planning and generation compete for the same GPU. LM Studio holds its model
 * resident well past the end of planning (its default idle TTL is an hour), so
 * on a single-GPU machine the next WanGP render finds no VRAM and dies with an
 * out-of-memory hint. Ejecting the planning model between phases is what makes
 * the two halves of the pipeline coexist.
 *
 * Status is read over LM Studio's REST API; load and unload go through its
 * `lms` CLI, which is the only interface that exposes them.
 */

const run = promisify(execFile);

export type LlmRuntimeStatus = {
  /** Whether runtime control is configured at all. */
  enabled: boolean;
  /** Whether LM Studio answered. */
  reachable: boolean;
  /** The model StoryForgeAI is configured to plan with. */
  configuredModel: string;
  /** Model ids currently resident in memory. */
  loadedModels: string[];
  /** Whether the configured planning model is one of them. */
  configuredModelLoaded: boolean;
};

type LmStudioModel = { id?: unknown; state?: unknown };

/**
 * LM Studio's REST API sits alongside the OpenAI-compatible one: the configured
 * base URL ends in `/v1`, the native API lives at `/api/v0` on the same origin.
 */
function restBase(): string | null {
  const base = config.openai.baseUrl;
  if (!base) return null;
  try {
    return new URL(base).origin;
  } catch {
    return null;
  }
}

export async function getLlmRuntimeStatus(): Promise<LlmRuntimeStatus> {
  const base = restBase();
  const status: LlmRuntimeStatus = {
    enabled: config.llmRuntime.enabled && base !== null,
    reachable: false,
    configuredModel: config.openai.model,
    loadedModels: [],
    configuredModelLoaded: false,
  };
  if (!status.enabled || !base) return status;

  try {
    const res = await fetch(`${base}/api/v0/models`, {
      // Never serve this from a cache. The whole point of the reading is that it
      // changes underneath us — the model may be loaded or unloaded from LM
      // Studio's own window between two calls.
      cache: "no-store",
      // A dead LM Studio must not hang the storyboard screen.
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return status;
    const body = (await res.json()) as { data?: LmStudioModel[] };
    const loaded = (body.data ?? [])
      .filter((m) => m.state === "loaded")
      .map((m) => (typeof m.id === "string" ? m.id : ""))
      .filter(Boolean);

    status.reachable = true;
    status.loadedModels = loaded;
    status.configuredModelLoaded = loaded.includes(status.configuredModel);
  } catch {
    // Unreachable is a normal state, not an error: LM Studio may simply be shut.
  }
  return status;
}

async function lms(args: string[]): Promise<string> {
  if (!config.llmRuntime.enabled) {
    throw new ValidationError(
      "LM Studio runtime control is disabled. Set OPENAI_BASE_URL to your LM Studio server.",
    );
  }
  try {
    // execFile, not exec: arguments are passed as an array with no shell, so
    // nothing here can be turned into shell injection. The model id comes from
    // configuration and is never taken from the request.
    const { stdout, stderr } = await run(config.llmRuntime.cliPath, args, {
      timeout: config.llmRuntime.timeoutMs,
      windowsHide: true,
    });
    return `${stdout}${stderr}`.trim();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/ENOENT/.test(message)) {
      throw new ValidationError(
        "Could not find the LM Studio CLI (`lms`). Install it with LM Studio, or set LMSTUDIO_CLI_PATH.",
      );
    }
    throw new ValidationError(`LM Studio CLI failed: ${message}`);
  }
}

/** Evict every loaded model, freeing the GPU for generation. */
export async function unloadPlanningModel(): Promise<LlmRuntimeStatus> {
  const output = await lms(["unload", "--all"]);
  logEvent("llm.runtime", { action: "unload", output: output.slice(0, 200) });
  return getLlmRuntimeStatus();
}

/**
 * Load the configured planning model.
 *
 * The model key is read from configuration rather than the request so a caller
 * cannot use this endpoint to load arbitrary models.
 */
export async function loadPlanningModel(): Promise<LlmRuntimeStatus> {
  const model = config.openai.model;
  if (!model) throw new ValidationError("No planning model is configured (OPENAI_MODEL).");
  const output = await lms(["load", model, "-y"]);
  logEvent("llm.runtime", { action: "load", model, output: output.slice(0, 200) });
  return getLlmRuntimeStatus();
}
