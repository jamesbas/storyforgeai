import { describe, it, expect } from "vitest";
import type { ZodType, ZodTypeDef } from "zod";
import { computeSegmentation } from "@/lib/duration";
import {
  appendExecution,
  artifactExecutionSchema,
  latestExecution,
  redactDetail,
  MAX_EXECUTIONS_PER_ARTIFACT,
  type ArtifactExecution,
  type FailureReason,
} from "@/lib/schemas/provenance";
import { executeArtifact, providerCall } from "@/lib/agents/provenance";
import { intakeAgent } from "@/lib/agents/intake-agent";
import { storyArchitectAgent } from "@/lib/agents/story-architect-agent";
import { visualBibleAgent } from "@/lib/agents/visual-bible-agent";
import { worldBuilderAgent, directorAgent, variantExplorerAgent } from "@/lib/agents/canvas-agents";
import { audioDirectorAgent } from "@/lib/agents/audio-agents";
import { qcAgent } from "@/lib/agents/qc-agent";
import type { PlanningProvider, ProviderResult } from "@/lib/agents/llm/provider";
import type { Project } from "@/lib/schemas/project";
import type { Scene } from "@/lib/schemas/storyboard";
import type { SceneAttempt } from "@/lib/schemas/generation";

function makeProject(): Project {
  const seg = computeSegmentation(40);
  const now = new Date().toISOString();
  return {
    id: "prov-project",
    title: "Provenance Project",
    concept: "A diver finds a door on the seabed.",
    requestedDurationSeconds: 40,
    segmentSeconds: 20,
    segmentCount: seg.segmentCount,
    generatedDurationSeconds: seg.generatedDurationSeconds,
    finalTrimSeconds: seg.finalTrimSeconds,
    aspectRatio: "16:9",
    resolutionPreset: "standard",
    style: "cinematic",
    tone: "tense",
    creativeMode: "film_short",
    narrationRequired: false,
    dialogueRequired: false,
    musicRequired: false,
    sfxRequired: false,
    generationMode: "storyboard_only",
    modelStrategy: "auto",
    status: "draft",
    createdAt: now,
    updatedAt: now,
  };
}

/** A provider that always fails, with the reason under test. */
function failing(reason: FailureReason, detail?: string): PlanningProvider {
  return {
    name: "test-provider",
    generateJson: async () => null,
    generate: async <T,>(): Promise<ProviderResult<T>> => ({
      ok: false,
      reason,
      detail,
      provider: "test-provider",
      model: "test-model",
      format: "json_schema",
    }),
  };
}

/** A provider that answers with whatever the schema will accept. */
function answering(value: unknown): PlanningProvider {
  return {
    name: "test-provider",
    generateJson: async <T,>(
      _s: string,
      _u: string,
      schema: ZodType<T, ZodTypeDef, unknown>,
    ): Promise<T | null> => {
      const parsed = schema.safeParse(value);
      return parsed.success ? parsed.data : null;
    },
    generate: async <T,>(
      _s: string,
      _u: string,
      schema: ZodType<T, ZodTypeDef, unknown>,
    ): Promise<ProviderResult<T>> => {
      const parsed = schema.safeParse(value);
      return parsed.success
        ? { ok: true, value: parsed.data, provider: "test-provider", model: "test-model" }
        : { ok: false, reason: "schema_mismatch", provider: "test-provider", model: "test-model" };
    },
  };
}

/**
 * Every agent falls back to a deterministic builder, and before provenance that
 * fallback was invisible: the artifact looked the same whether a model wrote it
 * or a template did.
 */
describe("the wrapper that records how an artifact was made", () => {
  it("records an llm success as ok", async () => {
    const collected: ArtifactExecution[] = [];
    const { value, execution } = await executeArtifact<string>({
      artifact: "thing",
      provider: answering("x"),
      onExecution: (e) => collected.push(e),
      llm: async () => ({ ok: true, value: "from-model", provider: "p", model: "m", format: "f" }),
      fallback: () => "from-builder",
    });

    expect(value).toBe("from-model");
    expect(execution).toMatchObject({ source: "llm", status: "ok", model: "m", format: "f" });
    expect(execution.fallbackReason).toBeUndefined();
    expect(collected).toHaveLength(1);
    expect(() => artifactExecutionSchema.parse(execution)).not.toThrow();
  });

  it("records demo mode as deterministic but not degraded", async () => {
    const { value, execution } = await executeArtifact<string>({
      artifact: "thing",
      provider: null,
      fallback: () => "from-builder",
    });

    expect(value).toBe("from-builder");
    // Nobody asked for a model, so nothing was lost.
    expect(execution).toMatchObject({
      source: "deterministic",
      status: "ok",
      fallbackReason: "provider_disabled",
    });
  });

  const reasons: FailureReason[] = [
    "sdk_missing",
    "request_failed",
    "timeout",
    "empty_response",
    "unparseable_json",
    "schema_mismatch",
    "format_unsupported",
  ];

  it.each(reasons)("records a %s failure as degraded with the reason kept", async (reason) => {
    const { value, execution } = await executeArtifact<string>({
      artifact: "thing",
      provider: failing(reason),
      llm: providerCall(failing(reason), "s", "u", artifactExecutionSchema) as never,
      fallback: () => "from-builder",
    });

    expect(value).toBe("from-builder");
    expect(execution).toMatchObject({
      source: "deterministic",
      status: "degraded",
      fallbackReason: reason,
    });
  });

  it("sends a structurally valid but unacceptable answer to the builder", async () => {
    const { value, execution } = await executeArtifact<string>({
      artifact: "thing",
      provider: answering("short"),
      llm: async () => ({ ok: true, value: "short", provider: "p" }),
      validate: () => "short_collection",
      fallback: () => "from-builder",
    });

    expect(value).toBe("from-builder");
    expect(execution).toMatchObject({ status: "degraded", fallbackReason: "short_collection" });
  });

  it("treats a thrown provider error as a failure rather than losing the run", async () => {
    const { value, execution } = await executeArtifact<string>({
      artifact: "thing",
      provider: failing("request_failed"),
      llm: async () => {
        throw new Error("socket hang up");
      },
      fallback: () => "from-builder",
    });

    expect(value).toBe("from-builder");
    expect(execution.fallbackReason).toBe("request_failed");
    expect(execution.detail).toContain("socket hang up");
  });

  it("degrades to reason unknown for a provider with no envelope", async () => {
    const bare: PlanningProvider = { name: "bare", generateJson: async () => null };
    const { execution } = await executeArtifact<string>({
      artifact: "thing",
      provider: bare,
      llm: providerCall(bare, "s", "u", artifactExecutionSchema) as never,
      fallback: () => "from-builder",
    });

    expect(execution).toMatchObject({ status: "degraded", fallbackReason: "unknown" });
  });
});

describe("what a record is allowed to contain", () => {
  it("strips data urls, keys and endpoints from the one free-text field", () => {
    const nasty =
      "failed for data:image/png;base64,AAAABBBBCCCC using api_key=sk-abcdef1234567890 " +
      "against https://internal.example.com/v1/chat";
    const safe = redactDetail(nasty)!;

    expect(safe).not.toMatch(/base64/);
    expect(safe).not.toMatch(/sk-abcdef/);
    expect(safe).not.toMatch(/internal\.example\.com/);
    expect(safe).toContain("[redacted]");
  });

  it("bounds the detail length", () => {
    expect(redactDetail("x".repeat(500))!.length).toBeLessThanOrEqual(201);
  });

  it("keeps no secret in a serialized record", async () => {
    const { execution } = await executeArtifact<string>({
      artifact: "thing",
      provider: failing("request_failed", "key sk-livesecret0000 at data:image/png;base64,ZZZZZZZZ"),
      llm: async () => ({
        ok: false,
        reason: "request_failed",
        detail: "key sk-livesecret0000 at data:image/png;base64,ZZZZZZZZ",
        provider: "test-provider",
      }),
      fallback: () => "from-builder",
    });

    const serialized = JSON.stringify(execution);
    expect(serialized).not.toContain("sk-livesecret");
    expect(serialized).not.toContain("base64");
  });

  it("has no field outside the allow-list", async () => {
    const { execution } = await executeArtifact<string>({
      artifact: "thing",
      provider: null,
      fallback: () => "x",
    });

    const allowed = [
      "executionId",
      "correlationId",
      "artifact",
      "scope",
      "source",
      "status",
      "provider",
      "model",
      "format",
      "promptVersion",
      "builderVersion",
      "fallbackReason",
      "detail",
      "evidence",
      "attempted",
      "startedAt",
      "finishedAt",
      "durationMs",
    ];
    for (const key of Object.keys(execution)) expect(allowed).toContain(key);
  });
});

describe("retention", () => {
  const record = (artifact: string, id: string): ArtifactExecution => ({
    executionId: id,
    artifact,
    source: "llm",
    status: "ok",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 1,
  });

  it("keeps only the newest few per artifact", () => {
    let all: ArtifactExecution[] | undefined;
    for (let i = 0; i < 12; i += 1) all = appendExecution(all, record("storyboard", `e${i}`));

    expect(all).toHaveLength(MAX_EXECUTIONS_PER_ARTIFACT);
    expect(all!.at(-1)!.executionId).toBe("e11");
  });

  it("does not let one artifact evict another", () => {
    let all: ArtifactExecution[] | undefined;
    all = appendExecution(all, record("brief", "brief-1"));
    for (let i = 0; i < 12; i += 1) all = appendExecution(all, record("storyboard", `e${i}`));

    expect(latestExecution(all, "brief")?.executionId).toBe("brief-1");
    expect(latestExecution(all, "storyboard")?.executionId).toBe("e11");
  });

  it("reads nothing for an artifact that has no record", () => {
    expect(latestExecution(undefined, "storyboard")).toBeUndefined();
    expect(latestExecution([], "storyboard")).toBeUndefined();
  });
});

describe("each migrated agent reports itself", () => {
  const project = makeProject();

  it("records the brief, story plan and visual bible in demo mode", async () => {
    const collected: ArtifactExecution[] = [];
    const ctx = { project, onExecution: (e: ArtifactExecution) => collected.push(e) };

    await intakeAgent(ctx, null);
    await storyArchitectAgent(ctx, null);
    await visualBibleAgent(ctx, null);

    expect(collected.map((e) => e.artifact)).toEqual(["brief", "story_plan", "visual_bible"]);
    for (const execution of collected) {
      expect(execution.source).toBe("deterministic");
      expect(execution.status).toBe("ok");
      expect(execution.builderVersion).toBeTruthy();
    }
  });

  it("marks a story plan with the wrong beat count as degraded", async () => {
    const collected: ArtifactExecution[] = [];
    // One beat when the project wants two.
    const provider = answering({
      projectId: project.id,
      title: "A Door Below",
      logline: "A diver finds a door.",
      emotionalProgression: ["curious"],
      segmentBeats: ["only one"],
    });

    await storyArchitectAgent(
      { project, onExecution: (e) => collected.push(e) },
      provider,
    );

    expect(collected[0]).toMatchObject({
      artifact: "story_plan",
      status: "degraded",
      fallbackReason: "short_collection",
    });
  });

  it("records canvas plans and the variant set", async () => {
    const collected: ArtifactExecution[] = [];
    const ctx = { onExecution: (e: ArtifactExecution) => collected.push(e) };

    await worldBuilderAgent(project, null, ctx);
    await directorAgent(project, null, ctx);
    await variantExplorerAgent(project, null, ctx);

    expect(collected.map((e) => e.artifact)).toEqual([
      "world_bible",
      "directorial_plan",
      "variants",
    ]);
  });

  it("records the audio plan", async () => {
    const collected: ArtifactExecution[] = [];
    await audioDirectorAgent(
      project,
      [{ id: "s1", sceneNumber: 1, durationSeconds: 20 }],
      null,
      { onExecution: (e) => collected.push(e) },
    );

    expect(collected[0]).toMatchObject({ artifact: "audio_plan", source: "deterministic" });
  });

  it("says which evidence QC actually looked at", async () => {
    const collected: ArtifactExecution[] = [];
    const scene = {
      id: "s1",
      sceneNumber: 1,
      title: "t",
      prompts: {
        startFramePrompt: "start",
        endFramePrompt: "end",
        videoPromptSegment: "video",
        videoNegativePrompt: "",
        imageNegativePrompt: "",
        promptQualityChecklist: ["subject is legible"],
      },
    } as unknown as Scene;
    const attempt = {
      id: "a1",
      sceneId: "s1",
      attemptNumber: 1,
      videoPath: "v.mp4",
      startImagePath: "s.png",
      endImagePath: "e.png",
      settingsIds: [],
      approved: false,
      createdAt: new Date().toISOString(),
    } as SceneAttempt;

    await qcAgent(scene, attempt, null, { expectVideo: true }, {
      onExecution: (e) => collected.push(e),
    });

    // No provider means nothing looked at the frames at all.
    expect(collected[0]).toMatchObject({
      artifact: "s1.qc",
      scope: "s1",
      evidence: { mode: "deterministic", attachments: 0 },
    });
  });
});
