import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * App-wide defaults for a new project's models, LoRAs and step counts.
 *
 * The point is the LoRA stack: a dozen deliberate choices, each with a strength
 * and a trigger word, previously rebuilt by hand for every project. Two rules
 * carry the weight — an existing project is never re-pinned by a later change
 * to these, and a stack is only inherited where the model it was chosen for is
 * the model the project actually lands on.
 */

const dirs: string[] = [];

/**
 * What `tests/setup.ts` points the data directory at.
 *
 * Restored rather than unset after each case: deleting it would leave
 * `config.dataDir` on its production default, and the next module to read it
 * would be writing into the real `./projects`.
 */
const SHARED_DATA_DIR = process.env.STORYFORGE_DATA_DIR;

async function isolated() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "storyforge-defaults-"));
  dirs.push(dir);
  process.env.STORYFORGE_DATA_DIR = dir;
  // `config` reads the data directory once at import, so without this every
  // test would share one store — and it would be the real one under ./projects.
  vi.resetModules();

  const defaults = await import("@/lib/services/generation-defaults-service");
  const projects = await import("@/lib/services/project-service");
  const { MockWangpClient: Mock } = await import("@/lib/wangp/mock-client");
  const { setWangpClient: set } = await import("@/lib/wangp/factory");
  set(new Mock());
  return { defaults, projects };
}

afterEach(async () => {
  if (SHARED_DATA_DIR) process.env.STORYFORGE_DATA_DIR = SHARED_DATA_DIR;
  else delete process.env.STORYFORGE_DATA_DIR;
  vi.resetModules();
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const CONCEPT = { concept: "A courier crosses a flooded city.", requestedDurationSeconds: 60 };

describe("saving the defaults", () => {
  it("starts empty on a fresh install", async () => {
    const { defaults } = await isolated();
    const saved = await defaults.getGenerationDefaults();

    expect(saved.imageModel).toBeUndefined();
    expect(saved.videoModel).toBeUndefined();
    expect(saved.loras).toEqual({ image: [], video: [] });
  });

  it("round-trips models, steps and LoRAs", async () => {
    const { defaults } = await isolated();
    await defaults.saveGenerationDefaults({
      imageModel: "krea2_turbo_edit",
      videoModel: "ltxv_13B",
      imageSteps: 8,
      videoSteps: 30,
      loras: { image: [{ name: "look.safetensors", strength: 0.8 }], video: [] },
    });

    const saved = await defaults.getGenerationDefaults();
    expect(saved.imageModel).toBe("krea2_turbo_edit");
    expect(saved.videoModel).toBe("ltxv_13B");
    expect(saved.imageSteps).toBe(8);
    expect(saved.videoSteps).toBe(30);
    expect(saved.loras.image[0]?.name).toBe("look.safetensors");
  });

  /** An empty box is how a pin is cleared, and must not read as "unchanged". */
  it("clears a pin when it is set to empty", async () => {
    const { defaults } = await isolated();
    await defaults.saveGenerationDefaults({ imageModel: "krea2_turbo_edit" });
    await defaults.saveGenerationDefaults({ imageModel: "" });

    expect((await defaults.getGenerationDefaults()).imageModel).toBeUndefined();
  });

  it("leaves untouched fields alone", async () => {
    const { defaults } = await isolated();
    await defaults.saveGenerationDefaults({ imageModel: "krea2_turbo_edit", imageSteps: 8 });
    await defaults.saveGenerationDefaults({ videoModel: "ltxv_13B" });

    const saved = await defaults.getGenerationDefaults();
    expect(saved.imageModel).toBe("krea2_turbo_edit");
    expect(saved.imageSteps).toBe(8);
    expect(saved.videoModel).toBe("ltxv_13B");
  });

  it("refuses a step count outside the range a model accepts", async () => {
    const { defaults } = await isolated();
    await expect(defaults.saveGenerationDefaults({ imageSteps: 0 })).rejects.toThrow();
    await expect(defaults.saveGenerationDefaults({ imageSteps: 500 })).rejects.toThrow();
  });

  /** A bare filename, never a path: it is resolved inside WanGP's lora folder. */
  it("refuses a LoRA name that is a path", async () => {
    const { defaults } = await isolated();
    await expect(
      defaults.saveGenerationDefaults({
        loras: { image: [{ name: "../escape.safetensors", strength: 1 }], video: [] },
      }),
    ).rejects.toThrow();
  });
});

describe("what a new project inherits", () => {
  it("starts from the saved models and steps", async () => {
    const { defaults, projects } = await isolated();
    await defaults.saveGenerationDefaults({
      imageModel: "krea2_turbo_edit",
      imageSteps: 8,
      videoSteps: 30,
    });

    const project = await projects.createProject(CONCEPT);

    expect(project.imageModel).toBe("krea2_turbo_edit");
    expect(project.imageSteps).toBe(8);
    expect(project.videoSteps).toBe(30);
  });

  /** A choice about this project outranks a standing preference. */
  it("lets an explicit choice win", async () => {
    const { defaults, projects } = await isolated();
    await defaults.saveGenerationDefaults({ imageModel: "krea2_turbo_edit" });

    const project = await projects.createProject({ ...CONCEPT, imageModel: "flux_krea" });

    expect(project.imageModel).toBe("flux_krea");
  });

  /**
   * The rule that makes this safe to change at any time: a project owns its
   * settings from the moment it exists, so a later edit here cannot re-pin a
   * storyboard part-way through a render.
   */
  it("never reaches back into a project that already exists", async () => {
    const { defaults, projects } = await isolated();
    await defaults.saveGenerationDefaults({ imageModel: "krea2_turbo_edit" });
    const project = await projects.createProject(CONCEPT);

    await defaults.saveGenerationDefaults({ imageModel: "flux_krea", imageSteps: 44 });

    const reloaded = (await projects.getProjectRecord(project.id)).project;
    expect(reloaded.imageModel).toBe("krea2_turbo_edit");
    expect(reloaded.imageSteps).toBeUndefined();
  });

  it("leaves a project unpinned when nothing is configured", async () => {
    const { projects } = await isolated();
    const project = await projects.createProject(CONCEPT);

    expect(project.loras).toBeUndefined();
    expect(project.imageSteps).toBeUndefined();
  });
});
