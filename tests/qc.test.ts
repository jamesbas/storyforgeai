import { describe, it, expect, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { writeFile, rm } from "node:fs/promises";
import type { ZodType, ZodTypeDef } from "zod";
import { evaluateQc, loadQcImages } from "@/lib/agents/qc-agent";
import type { GenerateOptions, PlanningProvider } from "@/lib/agents/llm/provider";
import type { Scene } from "@/lib/schemas/storyboard";
import type { SceneAttempt } from "@/lib/schemas/generation";
import { qcResultSchema } from "@/lib/schemas/generation";

const scene = {
  prompts: { promptQualityChecklist: ["continuity", "clear subject"] },
} as unknown as Scene;

function attempt(overrides: Partial<SceneAttempt>): SceneAttempt {
  return {
    id: "a1",
    sceneId: "s1",
    attemptNumber: 1,
    settingsIds: [],
    approved: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("QC evaluation", () => {
  it("passes when start image and video are present", () => {
    const result = evaluateQc(scene, attempt({ startImagePath: "s.png", videoPath: "v.mp4" }));
    expect(() => qcResultSchema.parse(result)).not.toThrow();
    expect(result.passed).toBe(true);
    expect(result.severity).toBe("none");
    expect(result.matchedRequirements).toContain("continuity");
  });

  it("fails and flags a major issue when the video is missing", () => {
    const result = evaluateQc(scene, attempt({ startImagePath: "s.png" }));
    expect(result.passed).toBe(false);
    expect(result.severity).toBe("major");
    expect(result.issues.some((i) => /video/i.test(i))).toBe(true);
    expect(result.regenerationInstructions).toBeDefined();
  });
});

/**
 * The agent used to be told to spot visual artifacts while being handed file
 * paths and no pixels. Models noticed, silently switched to diffing prompt
 * strings, and returned confident verdicts about renders they had never seen —
 * which flipped scenes to `needs_review` on invented evidence.
 */
describe("what the QC agent is actually shown", () => {
  /** Load the agent fresh so the configured vision model takes effect. */
  async function loadAgent(visionModel: string) {
    vi.resetModules();
    vi.stubEnv("OPENAI_VISION_MODEL", visionModel);
    return import("@/lib/agents/qc-agent");
  }

  function recorder() {
    const calls: { system: string; user: string; images: readonly string[] }[] = [];
    const provider: PlanningProvider = {
      name: "test",
      generateJson: async <T,>(
        system: string,
        user: string,
        _schema: ZodType<T, ZodTypeDef, unknown>,
        options?: GenerateOptions,
      ) => {
        calls.push({ system, user, images: options?.images ?? [] });
        return null as T | null;
      },
    };
    return { calls, provider };
  }

  /** A real file on disk, since the agent reads and encodes it. */
  async function frame() {
    const file = path.join(os.tmpdir(), `qc-${Date.now()}-${Math.random()}.png`);
    await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    return file;
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("never claims to see images when no vision model is configured", async () => {
    const { qcAgent } = await loadAgent("");
    const { calls, provider } = recorder();
    const start = await frame();

    try {
      await qcAgent(scene, attempt({ startImagePath: start }), provider, { expectVideo: false });

      const [call] = calls;
      expect(call!.images).toHaveLength(0);
      expect(call!.system).toMatch(/no images are attached/i);
      // A path reads as evidence the media was supplied. It was not.
      expect(call!.user).not.toContain(start);
      expect(call!.user).toContain("Review prompts only");
    } finally {
      await rm(start, { force: true });
    }
  });

  it("sends the keyframes and grades visually when a vision model is set", async () => {
    const { qcAgent } = await loadAgent("qwen-vl");
    const { calls, provider } = recorder();
    const start = await frame();
    const end = await frame();

    try {
      await qcAgent(scene, attempt({ startImagePath: start, endImagePath: end }), provider, {
        expectVideo: false,
      });

      const [call] = calls;
      expect(call!.images).toHaveLength(2);
      expect(call!.images[0]).toMatch(/^data:image\/png;base64,/);
      expect(call!.system).toMatch(/attached images/i);
      expect(call!.user).not.toContain("Review prompts only");
    } finally {
      await rm(start, { force: true });
      await rm(end, { force: true });
    }
  });

  /** A vision model configured but frames unreadable must not fake a visual pass. */
  it("drops to text-only when the frames cannot be read", async () => {
    const { qcAgent } = await loadAgent("qwen-vl");
    const { calls, provider } = recorder();

    await qcAgent(scene, attempt({ startImagePath: "C:\\nope\\missing.png" }), provider, {
      expectVideo: false,
    });

    expect(calls[0]!.images).toHaveLength(0);
    expect(calls[0]!.system).toMatch(/no images are attached/i);
  });

  it("falls back to the deterministic verdict when the model declines", async () => {
    const { qcAgent } = await loadAgent("");
    const { provider } = recorder();

    const result = await qcAgent(scene, attempt({ startImagePath: "s.png" }), provider, {
      expectVideo: false,
    });

    expect(result.passed).toBe(true);
    expect(result.severity).toBe("none");
  });
});

describe("reading keyframes for a vision model", () => {
  it("skips a path it cannot read rather than failing the scene", async () => {
    expect(await loadQcImages(["C:\\nope\\missing.png"])).toEqual([]);
  });

  it("skips a file type no vision model accepts", async () => {
    expect(await loadQcImages(["C:\\out\\clip.mp4"])).toEqual([]);
  });

  it("encodes a readable frame as a data URL", async () => {
    const file = path.join(os.tmpdir(), `qc-${Date.now()}.png`);
    await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    try {
      const [url] = await loadQcImages([file]);
      expect(url).toMatch(/^data:image\/png;base64,/);
    } finally {
      await rm(file, { force: true });
    }
  });
});
