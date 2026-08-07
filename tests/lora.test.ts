import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSettingsManifest } from "@/lib/wangp/settings";
import {
  listLocalLoras,
  resolveLoraDirectory,
  resetLoraCatalogCache,
} from "@/lib/wangp/lora-catalog";
import {
  pruneSceneLoras,
  reconcileLoras,
  resolveSceneLoras,
  validateLoras,
} from "@/lib/services/lora-service";
import { loraSelectionSchema } from "@/lib/schemas/lora";
import type { LoraCatalog } from "@/lib/schemas/lora";
import type { WangpModelSchema } from "@/lib/schemas/wangp";

/**
 * LoRA selection, from discovery through to the settings manifest.
 *
 * The WanGP MCP server exposes no LoRA inventory (verified against v1.10.1), so
 * discovery is a filesystem read and these fixtures stand in for WanGP's
 * `loras/<family>` store. The directory names and the `family` /
 * `base_model_type` values mirror a live server.
 */

let root: string;
let metadataRoot: string;

beforeEach(async () => {
  resetLoraCatalogCache();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sf-loras-"));
  metadataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sf-loras-meta-"));

  await fs.mkdir(path.join(root, "flux2_klein_9b"), { recursive: true });
  await fs.mkdir(path.join(root, "ltx2"), { recursive: true });
  await fs.mkdir(path.join(root, "old_ltx2_22B"), { recursive: true });
  await fs.mkdir(path.join(root, "ltx2", "nested"), { recursive: true });

  await fs.writeFile(path.join(root, "flux2_klein_9b", "portrait.safetensors"), "x");
  await fs.writeFile(path.join(root, "flux2_klein_9b", "OPAQUEHASH.safetensors"), "x");
  await fs.writeFile(path.join(root, "ltx2", "motion.safetensors"), "x");
  await fs.writeFile(path.join(root, "ltx2", "extra.sft"), "x");
  // Presets and stray files sit beside the weights and must not be offered.
  await fs.writeFile(path.join(root, "ltx2", "motion.lset"), "x");
  await fs.writeFile(path.join(root, "ltx2", "notes.json"), "{}");
  await fs.writeFile(path.join(root, "ltx2", "nested", "deep.safetensors"), "x");
});

afterAll(async () => {
  resetLoraCatalogCache();
});

const flux = { modelType: "flux2_klein_9b", family: "flux2", baseModelType: "flux2_klein_9b" };
const ltx = { modelType: "ltx2_22B_distilled_1_1", family: "ltx2", baseModelType: "ltx2_22B" };

describe("mapping a model to its LoRA directory", () => {
  it("prefers the base model, which has its own folder", async () => {
    expect(await resolveLoraDirectory(root, flux)).toBe("flux2_klein_9b");
  });

  /**
   * The pinned video model reports `base_model_type: "ltx2_22B"`, which is not a
   * real directory — an `old_ltx2_22B` folder exists and would be the wrong
   * answer. Falling through to `family` is what gets this right.
   */
  it("falls back to the family when the base model has no folder", async () => {
    expect(await resolveLoraDirectory(root, ltx)).toBe("ltx2");
  });

  it("falls back to the model type when neither family nor base model match", async () => {
    expect(await resolveLoraDirectory(root, { modelType: "ltx2" })).toBe("ltx2");
  });

  it("matches case-insensitively", async () => {
    expect(await resolveLoraDirectory(root, { modelType: "FLUX2_KLEIN_9B" })).toBe("flux2_klein_9b");
  });

  it("returns nothing when no folder matches", async () => {
    expect(await resolveLoraDirectory(root, { modelType: "hunyuan", family: "hunyuan" })).toBeUndefined();
  });
});

describe("reading the LoRA store", () => {
  it("lists only weight files, ignoring presets and nested folders", async () => {
    const catalog = await listLocalLoras(root, metadataRoot, ltx);
    expect(catalog.supported).toBe(true);
    if (!catalog.supported) return;

    expect(catalog.directory).toBe("ltx2");
    expect(catalog.loras.map((l) => l.name).sort()).toEqual(["extra.sft", "motion.safetensors"]);
  });

  it("labels a LoRA from its sidecar and surfaces trigger words", async () => {
    await fs.mkdir(path.join(metadataRoot, "flux2_klein_9b"), { recursive: true });
    await fs.writeFile(
      path.join(metadataRoot, "flux2_klein_9b", "OPAQUEHASH.json"),
      JSON.stringify({ name: "Portrait Booster V2", trainedWords: ["pbv2"] }),
    );

    const catalog = await listLocalLoras(root, metadataRoot, flux);
    if (!catalog.supported) throw new Error("expected a supported catalog");

    const enriched = catalog.loras.find((l) => l.name === "OPAQUEHASH.safetensors");
    expect(enriched?.label).toBe("Portrait Booster V2");
    expect(enriched?.triggerWords).toEqual(["pbv2"]);

    // A file with no sidecar still lists, falling back to its filename.
    const plain = catalog.loras.find((l) => l.name === "portrait.safetensors");
    expect(plain?.label).toBe("portrait.safetensors");
    expect(plain?.triggerWords).toEqual([]);
  });

  it("treats an absent folder as an empty catalog rather than an error", async () => {
    await fs.mkdir(path.join(root, "qwen"), { recursive: true });
    const catalog = await listLocalLoras(root, metadataRoot, { modelType: "qwen" });
    expect(catalog).toMatchObject({ supported: true, loras: [] });
  });

  it("explains itself when the model cannot take LoRAs", async () => {
    const catalog = await listLocalLoras(root, metadataRoot, {
      modelType: "flux2_klein_9b",
      supportsLora: false,
    });
    expect(catalog.supported).toBe(false);
    if (!catalog.supported) expect(catalog.reason).toMatch(/does not support LoRAs/i);
  });

  it("explains itself when no LoRA root is configured", async () => {
    const catalog = await listLocalLoras("", metadataRoot, flux);
    expect(catalog.supported).toBe(false);
    if (!catalog.supported) expect(catalog.reason).toMatch(/WANGP_LORA_ROOT/);
  });
});

describe("selection safety", () => {
  it.each(["../evil.safetensors", "sub/evil.safetensors", "sub\\evil.safetensors", ".hidden"])(
    "rejects %s",
    (name) => {
      expect(loraSelectionSchema.safeParse({ name, strength: 1 }).success).toBe(false);
    },
  );

  it("accepts a bare filename and defaults strength to 1", () => {
    const parsed = loraSelectionSchema.parse({ name: "motion.safetensors" });
    expect(parsed).toEqual({ name: "motion.safetensors", strength: 1 });
  });
});

const catalogOf = (names: string[]): LoraCatalog => ({
  supported: true,
  modelType: "ltx2_22B_distilled_1_1",
  directory: "ltx2",
  loras: names.map((name) => ({ name, label: name, triggerWords: [] })),
});

describe("validating a selection against a catalog", () => {
  it("canonicalises a name that differs only by case", () => {
    const result = validateLoras(
      [{ name: "MOTION.safetensors", strength: 0.8 }],
      catalogOf(["motion.safetensors"]),
    );
    expect(result).toEqual([{ name: "motion.safetensors", strength: 0.8 }]);
  });

  it("rejects a LoRA that is not installed", () => {
    expect(() =>
      validateLoras([{ name: "ghost.safetensors", strength: 1 }], catalogOf(["motion.safetensors"])),
    ).toThrow(/not installed/i);
  });

  it("short-circuits an empty selection even when the catalog is unusable", () => {
    expect(validateLoras([], { supported: false, modelType: "x", reason: "nope" })).toEqual([]);
  });
});

describe("reconciling at generation time", () => {
  /**
   * The model actually used can differ from the pin — a scene with character
   * references forces a reference-capable model — so a stranded LoRA is dropped
   * rather than failing the scene mid-batch.
   */
  it("drops incompatible LoRAs instead of throwing", () => {
    const result = reconcileLoras(
      [
        { name: "motion.safetensors", strength: 1 },
        { name: "ghost.safetensors", strength: 1 },
      ],
      catalogOf(["motion.safetensors"]),
      { sceneId: "scene-1", modelType: "ltx2", kind: "video" },
    );
    // Trigger words ride along from the catalog entry; see lora-trigger-words.test.ts.
    expect(result).toEqual([
      {
        name: "motion.safetensors",
        strength: 1,
        triggerWords: [],
        availableTriggerWords: [],
      },
    ]);
  });

  it("drops everything when the resolved model has no catalog", () => {
    const result = reconcileLoras(
      [{ name: "motion.safetensors", strength: 1 }],
      { supported: false, modelType: "flux", reason: "no folder" },
      { sceneId: "scene-1", modelType: "flux", kind: "video" },
    );
    expect(result).toEqual([]);
  });
});

describe("resolving which LoRAs a scene uses", () => {
  const project = {
    loras: {
      image: [{ name: "look.safetensors", strength: 1 }],
      video: [{ name: "motion.safetensors", strength: 1 }],
    },
    sceneLoras: {
      "scene-2": {
        mode: "override" as const,
        image: [],
        video: [{ name: "action.safetensors", strength: 0.5 }],
      },
      "scene-3": { mode: "inherit" as const, image: [], video: [] },
    },
  };

  it("inherits the storyboard selection by default", () => {
    expect(resolveSceneLoras(project, "scene-1", "video")).toEqual([
      { name: "motion.safetensors", strength: 1 },
    ]);
  });

  it("replaces rather than merges when a scene overrides", () => {
    expect(resolveSceneLoras(project, "scene-2", "video")).toEqual([
      { name: "action.safetensors", strength: 0.5 },
    ]);
    // The override's empty image list wins over the project's selection.
    expect(resolveSceneLoras(project, "scene-2", "image")).toEqual([]);
  });

  it("treats an explicit inherit as no override", () => {
    expect(resolveSceneLoras(project, "scene-3", "image")).toEqual([
      { name: "look.safetensors", strength: 1 },
    ]);
  });

  it("drops overrides for scenes that no longer exist", () => {
    expect(pruneSceneLoras(project.sceneLoras, ["scene-2"])).toEqual({
      "scene-2": project.sceneLoras["scene-2"],
    });
    expect(pruneSceneLoras(project.sceneLoras, [])).toBeUndefined();
  });
});

function schemaWith(names: string[], defaults: Record<string, unknown> = {}): WangpModelSchema {
  return {
    modelType: "test_model",
    defaultSettings: defaults,
    fields: names.map((name) => ({ name, type: "string" })),
  };
}

describe("writing LoRAs into the settings manifest", () => {
  it("aligns multipliers to the activated list by index", () => {
    const manifest = buildSettingsManifest(
      schemaWith(["prompt", "activated_loras", "loras_multipliers"]),
      {
        sceneId: "scene-1",
        purpose: "video_segment",
        prompt: "a lighthouse",
        loras: [
          { name: "a.safetensors", strength: 1 },
          { name: "b.safetensors", strength: 0.35 },
        ],
      },
    );

    expect(manifest.settings.activated_loras).toEqual(["a.safetensors", "b.safetensors"]);
    expect(manifest.settings.loras_multipliers).toBe("1 0.35");
  });

  /**
   * WanGP's published defaults are its *saved UI state*, so they carry whatever
   * LoRAs were last selected in another application. Leaving the field alone
   * would let a project inherit them and render differently for no visible
   * reason, so it is always written.
   */
  it("clears LoRAs inherited from WanGP's saved settings when none are selected", () => {
    const manifest = buildSettingsManifest(
      schemaWith(["prompt", "activated_loras", "loras_multipliers"], {
        activated_loras: ["left_over.safetensors", "adapter.safetensors"],
        loras_multipliers: "1",
      }),
      { sceneId: "scene-1", purpose: "video_segment", prompt: "a lighthouse" },
    );

    expect(manifest.settings.activated_loras).toEqual([]);
    expect(manifest.settings.loras_multipliers).toBe("");
  });

  /**
   * `setIf` silently ignores fields a schema does not declare. For LoRAs that
   * would render something plausible with no LoRA applied and nothing to
   * debug, so this refuses instead.
   */
  it("refuses rather than silently dropping a selection the model cannot accept", () => {
    expect(() =>
      buildSettingsManifest(schemaWith(["prompt"]), {
        sceneId: "scene-1",
        purpose: "video_segment",
        prompt: "a lighthouse",
        loras: [{ name: "a.safetensors", strength: 1 }],
      }),
    ).toThrow(/accepts no LoRAs/i);
  });

  it("stays quiet when the model has no LoRA field and nothing was selected", () => {
    const manifest = buildSettingsManifest(schemaWith(["prompt"]), {
      sceneId: "scene-1",
      purpose: "video_segment",
      prompt: "a lighthouse",
    });
    expect(manifest.settings.activated_loras).toBeUndefined();
  });
});
