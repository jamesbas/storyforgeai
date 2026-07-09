import { describe, it, expect } from "vitest";
import { evaluateQc } from "@/lib/agents/qc-agent";
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
