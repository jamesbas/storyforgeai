import { promises as fs } from "node:fs";
import path from "node:path";
import type { LoraCatalog, LoraCatalogEntry } from "@/lib/schemas/lora";

/**
 * WanGP loads LoRA weights from these extensions only. The `.lset` files that
 * sit beside them are *presets* (the thing the unimplemented
 * `wangp_list_lora_presets` tool refers to), not weights, so excluding them here
 * keeps them out of the picker.
 */
const LORA_EXTENSIONS = new Set([".safetensors", ".sft"]);

/** Just enough of a model to route it to a LoRA directory. */
export type LoraModelIdentity = {
  modelType: string;
  family?: string;
  baseModelType?: string;
  supportsLora?: boolean;
};

type DirCache = { at: number; names: string[] };

const DIRECTORY_TTL_MS = 60_000;
const dirCache = new Map<string, DirCache>();
const catalogCache = new Map<string, { at: number; catalog: LoraCatalog }>();

/** Drop cached listings — used by tests and the explicit refresh in the UI. */
export function resetLoraCatalogCache(): void {
  dirCache.clear();
  catalogCache.clear();
}

async function listDirectories(root: string): Promise<string[]> {
  const cached = dirCache.get(root);
  if (cached && Date.now() - cached.at < DIRECTORY_TTL_MS) return cached.names;

  let names: string[] = [];
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    names = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    // A missing or unreadable root is a configuration problem, not a crash.
    names = [];
  }
  dirCache.set(root, { at: Date.now(), names });
  return names;
}

/**
 * Map a model to its LoRA folder by testing candidates against what is actually
 * on disk, rather than a hardcoded family table.
 *
 * Order matters. `base_model_type` is the most specific — `flux2_klein_9b` has
 * its own folder that `family: "flux2"` would miss — but it is not always a real
 * directory: the pinned video model reports `ltx2_22B`, which does not exist,
 * while its family `ltx2` does. Trying specific-then-general against the real
 * listing gets both right and needs no maintenance as families are added.
 */
export async function resolveLoraDirectory(
  root: string,
  identity: LoraModelIdentity,
): Promise<string | undefined> {
  const directories = await listDirectories(root);
  if (!directories.length) return undefined;

  const byLower = new Map(directories.map((name) => [name.toLocaleLowerCase(), name]));
  const candidates = [identity.baseModelType, identity.family, identity.modelType];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const hit = byLower.get(candidate.toLocaleLowerCase());
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Read the LoRA Manager sidecar for a weight file, if one exists.
 *
 * Records are Civitai exports: `name` is a friendly label and `trainedWords`
 * are the trigger words. Any failure degrades to "no metadata" because a
 * missing or malformed sidecar must not hide an installed LoRA.
 */
async function readSidecar(
  metadataRoot: string,
  directory: string,
  fileName: string,
): Promise<{ label?: string; triggerWords: string[] }> {
  if (!metadataRoot) return { triggerWords: [] };
  const base = fileName.replace(/\.[^.]+$/, "");
  const sidecar = path.join(metadataRoot, directory, `${base}.json`);
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(sidecar, "utf8"));
    if (!parsed || typeof parsed !== "object") return { triggerWords: [] };
    const record = parsed as Record<string, unknown>;
    const label = typeof record.name === "string" && record.name.trim() ? record.name.trim() : undefined;
    const triggerWords = Array.isArray(record.trainedWords)
      ? record.trainedWords.filter((w): w is string => typeof w === "string" && w.trim().length > 0)
      : [];
    return { label, triggerWords };
  } catch {
    return { triggerWords: [] };
  }
}

/**
 * List the LoRAs installed for a model.
 *
 * The WanGP MCP server exposes no LoRA inventory tool (confirmed against
 * v1.10.1), so this reads the store directly. Only immediate children are
 * considered and only bare filenames are returned — absolute paths never reach
 * the client, and WanGP wants filenames anyway.
 */
export async function listLocalLoras(
  root: string,
  metadataRoot: string,
  identity: LoraModelIdentity,
): Promise<LoraCatalog> {
  const { modelType } = identity;

  if (identity.supportsLora === false) {
    return { supported: false, modelType, reason: `${modelType} does not support LoRAs.` };
  }
  if (!root) {
    return {
      supported: false,
      modelType,
      reason:
        "WanGP does not expose LoRA discovery, and WANGP_LORA_ROOT is not configured. " +
        "Point it at WanGP's `loras` folder to enable LoRA selection.",
    };
  }

  const directory = await resolveLoraDirectory(root, identity);
  if (!directory) {
    return {
      supported: false,
      modelType,
      reason: `No LoRA folder found for ${modelType} under the configured LoRA root.`,
    };
  }

  // `directory` came from a readdir of `root`, so it cannot escape. Assert it
  // anyway: this is the one place a model-supplied string meets the filesystem.
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, directory);
  if (path.dirname(target) !== resolvedRoot) {
    return { supported: false, modelType, reason: "Resolved LoRA folder escaped the LoRA root." };
  }

  let files: string[];
  try {
    const entries = await fs.readdir(target, { withFileTypes: true });
    files = entries
      .filter((e) => e.isFile() && LORA_EXTENSIONS.has(path.extname(e.name).toLocaleLowerCase()))
      .map((e) => e.name);
  } catch {
    // An absent folder means "none installed yet", which is a supported empty
    // catalog rather than an error the user must action.
    return { supported: true, modelType, directory, loras: [] };
  }

  const loras: LoraCatalogEntry[] = [];
  for (const name of files.sort((a, b) => a.localeCompare(b))) {
    const { label, triggerWords } = await readSidecar(metadataRoot, directory, name);
    let sizeMb: number | undefined;
    try {
      sizeMb = Math.round((await fs.stat(path.join(target, name))).size / (1024 * 1024));
    } catch {
      sizeMb = undefined;
    }
    loras.push({ name, label: label ?? name, triggerWords, sizeMb });
  }

  return { supported: true, modelType, directory, loras };
}

/** Cached wrapper: a batch resolves the same catalog once per scene otherwise. */
export async function getLoraCatalog(
  root: string,
  metadataRoot: string,
  identity: LoraModelIdentity,
): Promise<LoraCatalog> {
  const key = `${root}|${metadataRoot}|${identity.modelType}`;
  const cached = catalogCache.get(key);
  if (cached && Date.now() - cached.at < DIRECTORY_TTL_MS) return cached.catalog;

  const catalog = await listLocalLoras(root, metadataRoot, identity);
  catalogCache.set(key, { at: Date.now(), catalog });
  return catalog;
}
