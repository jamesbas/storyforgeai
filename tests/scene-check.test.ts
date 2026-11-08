import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ZodType, ZodTypeDef } from "zod";

/**
 * The service reads its model through `getPlanningProvider`; this stands in for
 * it. `null` answers model nothing (the reviewer returned nothing usable).
 */
const reviewer = vi.hoisted(() => ({ answer: null as unknown }));
vi.mock("@/lib/agents/llm/provider", async (original) => ({
  ...(await original<typeof import("@/lib/agents/llm/provider")>()),
  getPlanningProvider: () => ({
    name: "fake-reviewer",
    // Only the scene check is answered; anything else the render queue asks is declined.
    generateJson: async (system: string) =>
      system.startsWith("You are the Scene Check reviewer") ? reviewer.answer : null,
  }),
}));
import {
  buildSceneCheckInput,
  ruleFindings,
  runDeepCheck,
  runQuickCheck,
  sceneCheckInputHash,
  sceneCheckSources,
  sceneFrames,
  verifiedFindings,
  type SceneCheckInput,
  type SceneCheckSources,
} from "@/lib/agents/scene-check";
import { proposeFix, readsAsRewrite } from "@/lib/agents/scene-check-fix";
import { createProject, generateStoryboard, getProjectRecord, updateScenePrompts } from "@/lib/services/project-service";
import {
  acceptSceneFinding,
  applySceneCheckFix,
  checkSceneNow,
  checkThenRender,
  enqueueSceneChecks,
  getSceneCheckProgress,
  previewSceneCheckFix,
  summariseSceneChecks,
} from "@/lib/services/scene-check-service";
import { cancelQueue, getQueue } from "@/lib/services/scene-queue";
import { repository } from "@/lib/db/store";
import { setWangpClient } from "@/lib/wangp/factory";
import { MockWangpClient } from "@/lib/wangp/mock-client";
import { sceneCheckStatus, type ModelFinding, type SceneCheck } from "@/lib/schemas/scene-check";
import type { GenerateOptions, PlanningProvider } from "@/lib/agents/llm/provider";
import type { ProjectRecord } from "@/lib/schemas/storyboard";

/**
 * Scene Check: an on-demand review of chosen scenes. What it must never do is
 * report a problem it cannot quote, call a scene passed when nothing reviewed
 * it, or pass a scene whose prompts changed after it was checked.
 */

const LEROY =
  "Heavyset Black man in his mid-fifties with a thick gut and broad chest; dark espresso-brown skin";

beforeEach(() => {
  setWangpClient(new MockWangpClient());
  reviewer.answer = null;
});

async function project(): Promise<ProjectRecord> {
  const created = await createProject({
    concept: "TLB waits on the hotel bed while Leroy kneels at its foot.",
    requestedDurationSeconds: 30,
    sceneContinuity: "cut",
    generationMode: "keyframes_only",
  });
  const record = await generateStoryboard(created.id);
  const storyboard = record.storyboard!;
  const updated: ProjectRecord = {
    ...record,
    storyboard: {
      ...storyboard,
      visualBible: {
        ...storyboard.visualBible,
        characters: [...storyboard.visualBible.characters, { name: "Leroy", description: LEROY }],
      },
      scenes: storyboard.scenes.map((scene, index) => index === 0 ? {
        ...scene,
        actionDescription: "Leroy kneels at the foot of the bed.",
        frameVisibility: { start: ["Leroy"], end: ["Leroy"] },
        prompts: {
          ...scene.prompts,
          startFramePrompt: "Medium shot. Leroy, heavyset in his mid-fifties with a thick gut and broad chest, kneels at the foot of the bed.",
          endFramePrompt: "Medium shot. Leroy, a heavyset Black man in his fifties, kneels at the foot of the bed.",
        },
      } : scene),
    },
  };
  await repository.update(record.project.id, updated);
  return updated;
}

function sources(record: ProjectRecord): SceneCheckSources {
  return sceneCheckSources(record, record.storyboard!.scenes[0]!.id, [])!;
}

function provider(answer: (system: string, options?: GenerateOptions) => unknown): PlanningProvider {
  return {
    name: "fake",
    generateJson: async <T,>(system: string, _user: string, schema: ZodType<T, ZodTypeDef, unknown>, options?: GenerateOptions) => {
      const value = answer(system, options);
      return value === null ? null : schema.parse(value);
    },
  };
}

const finding = (overrides: Partial<ModelFinding>): ModelFinding => ({
  code: "action_missing", category: "action", severity: "warning", certainty: "likely",
  field: "endFramePrompt", evidence: [{ source: "card", excerpt: "kneels at the foot of the bed" }],
  explanation: "x", ...overrides,
});

describe("what a check reads", () => {
  it("keeps the quick input to the scene itself, and adds the story and neighbours when deep", async () => {
    const record = await project();
    const quick = buildSceneCheckInput(sources(record), "quick");
    const deep = buildSceneCheckInput(sources(record), "deep");
    expect(quick.story).toBeUndefined();
    expect(quick.neighbours).toBeUndefined();
    expect(deep.neighbours?.next?.sceneNumber).toBe(2);
    expect(quick.people.map((person) => person.name)).toContain("Leroy");
    // A keyframes-only project has no clip to review.
    expect(quick.prompts.videoPromptSegment).toBeUndefined();
  });

  it("goes out of date when a prompt changes, and a deep check also when the frames do", async () => {
    const record = await project();
    const base = sources(record);
    const edited = {
      ...base, scene: { ...base.scene, prompts: { ...base.scene.prompts, endFramePrompt: "Changed." } },
    };
    expect(sceneCheckInputHash(buildSceneCheckInput(base, "quick")))
      .toBe(sceneCheckInputHash(buildSceneCheckInput(base, "quick")));
    expect(sceneCheckInputHash(buildSceneCheckInput(edited, "quick")))
      .not.toBe(sceneCheckInputHash(buildSceneCheckInput(base, "quick")));
    const rerendered = { ...base, frames: { start: "new.png" } };
    expect(sceneCheckInputHash(buildSceneCheckInput(rerendered, "quick")))
      .toBe(sceneCheckInputHash(buildSceneCheckInput(base, "quick")));
    expect(sceneCheckInputHash(buildSceneCheckInput(rerendered, "deep")))
      .not.toBe(sceneCheckInputHash(buildSceneCheckInput(base, "deep")));
  });

  it("looks at a preview before the attempt it may replace", () => {
    expect(sceneFrames({
      attempts: { s: [{ startImagePath: "a.png", endImagePath: "b.png", approved: false } as never] },
      previews: { s: { endFramePath: "p.png" } as never },
    }, "s")).toEqual({ start: "a.png", end: "p.png" });
  });

  it("reports the missing skin tone as a rule finding, as an error, on the frame that lacks it", async () => {
    const rules = ruleFindings(sources(await project()));
    const identity = rules.find((rule) => rule.code === "identity_missing");
    expect(identity).toMatchObject({ field: "startFramePrompt", severity: "error", origin: "rule" });
    expect(rules.some((rule) => rule.code === "identity_missing" && rule.field === "endFramePrompt")).toBe(false);
  });
});

describe("keeping the model honest", () => {
  let input: SceneCheckInput;
  beforeEach(async () => { input = buildSceneCheckInput(sources(await project()), "quick"); });

  it("drops a finding whose quotation is not in the input", () => {
    const { kept, dropped } = verifiedFindings([
      finding({ evidence: [{ source: "endFramePrompt", excerpt: "he juggles three flaming torches" }] }),
    ], input, "model");
    expect(kept).toEqual([]);
    expect(dropped).toBe(1);
  });

  it("keeps a real quotation even when the model names the wrong source", () => {
    const { kept } = verifiedFindings([
      finding({ evidence: [{ source: "endFramePrompt", excerpt: "heavyset in his mid-fifties with a thick gut" }] }),
    ], input, "model");
    expect(kept).toHaveLength(1);
    expect(kept[0]!.evidence[0]!.source).toBe("startFramePrompt");
  });

  it("treats thin evidence as information, not an error", () => {
    const { kept } = verifiedFindings([finding({ certainty: "underspecified", severity: "error" })], input, "model");
    expect(kept[0]!.severity).toBe("info");
  });

  it("drops a finding about a prompt this project does not render", () => {
    expect(verifiedFindings([finding({ field: "videoPromptSegment" })], input, "model").kept).toEqual([]);
  });
});

describe("running a check", () => {
  it("never reads as passed when the reviewer returned nothing", async () => {
    const record = await project();
    const input = buildSceneCheckInput(sources(record), "quick");
    const check = await runQuickCheck({
      input, rules: [], provider: provider(() => null), sceneId: "s",
    });
    expect(check.coverage).toBe("failed");
    expect(sceneCheckStatus(check, check.inputHash)).toBe("incomplete");
  });

  it("merges the model's findings with the rules and keeps acceptances for the same inputs", async () => {
    const record = await project();
    const src = sources(record);
    const input = buildSceneCheckInput(src, "quick");
    const rules = ruleFindings(src);
    const first = await runQuickCheck({
      input, rules, sceneId: "s", provider: provider(() => ({ findings: [finding({})] })),
    });
    expect(first.coverage).toBe("complete");
    expect(first.findings.map((f) => f.origin).sort()).toEqual(["model", "rule"]);
    const accepted: SceneCheck = {
      ...first,
      findings: first.findings.map((f) => ({ ...f, accepted: { at: "now", inputHash: first.inputHash } })),
    };
    expect(sceneCheckStatus(accepted, accepted.inputHash)).toBe("passed");
    const again = await runQuickCheck({
      input, rules, sceneId: "s", previous: accepted, provider: provider(() => ({ findings: [finding({})] })),
    });
    expect(again.findings.every((f) => f.accepted)).toBe(true);
    expect(sceneCheckStatus(again, "something-else")).toBe("out_of_date");
  });

  it("looks at the frames only when a vision model and frames exist, and says when it could not", async () => {
    const input = buildSceneCheckInput(sources(await project()), "deep");
    const seen: number[] = [];
    const answer = provider((_system, options) => {
      seen.push(options?.images?.length ?? 0);
      return options?.images?.length
        ? { findings: [finding({ field: "startImage", code: "identity_rendered_wrong", category: "identity",
          evidence: [{ source: "people:Leroy", excerpt: "dark espresso-brown skin" }] })] }
        : { findings: [] };
    });

    const withVision = await runDeepCheck({
      input, rules: [], provider: answer, images: ["data:image/png;base64,AA"], visionConfigured: true, sceneId: "s",
    });
    expect(withVision.mode).toBe("text+vision");
    expect(withVision.coverage).toBe("complete");
    expect(withVision.findings[0]).toMatchObject({ origin: "vision", field: "startImage" });

    const blind = await runDeepCheck({
      input, rules: [], provider: answer, images: [], visionConfigured: false, sceneId: "s",
    });
    expect(blind.mode).toBe("text");
    expect(blind.detail).toMatch(/no vision model/i);
    expect(seen).toEqual([0, 1, 0]);
  });

  it("is partial when the frame review fails", async () => {
    const input = buildSceneCheckInput(sources(await project()), "deep");
    const check = await runDeepCheck({
      input, rules: [], images: ["data:image/png;base64,AA"], visionConfigured: true, sceneId: "s",
      provider: provider((_system, options) => (options?.images?.length ? null : { findings: [] })),
    });
    expect(check.coverage).toBe("partial");
    expect(sceneCheckStatus(check, check.inputHash)).toBe("incomplete");
  });
});

describe("proposing a fix", () => {
  it("rejects a rewrite and accepts a repair", () => {
    const before = "Medium shot. Leroy, heavyset in his mid-fifties with a thick gut, kneels at the foot of the bed.";
    expect(readsAsRewrite(before, before.replace("Leroy,", "Leroy, a Black man,"))).toBe(false);
    expect(readsAsRewrite(before, "A cinematic wide shot of an empty hotel room at dusk.")).toBe(true);
  });

  it("edits only the written part and puts the appended sheet back unchanged", async () => {
    const input = buildSceneCheckInput(sources(await project()), "quick");
    const body = "Medium shot. Leroy kneels at the foot of the bed in the warm light.";
    const sheet = " Character continuity — Leroy: Heavyset Black man.";
    const proposal = await proposeFix({
      input,
      finding: { ...finding({}), id: "f", origin: "model", evidence: [] },
      currentPrompts: { startFramePrompt: undefined, endFramePrompt: body + sheet, endFrameEditPrompt: undefined, videoPromptSegment: undefined },
      currentCard: { sceneObjective: "", storyBeat: "", visualDescription: "", actionDescription: "", cameraMovement: "" },
      sceneId: "s",
      provider: provider(() => ({ revised: body.replace("kneels", "kneels low"), summary: "Lowered him." })),
    });
    expect(proposal).toMatchObject({ kind: "prompt", field: "endFramePrompt" });
    expect("after" in proposal && proposal.after.endsWith(sheet)).toBe(true);
  });
});

describe("the service", () => {
  it("checks only the scenes asked for, and stores a result that knows it is incomplete", async () => {
    const record = await project();
    const [first, second] = record.storyboard!.scenes;
    await enqueueSceneChecks(record.project.id, [first!.id], "quick");
    for (let i = 0; i < 100 && getSceneCheckProgress(record.project.id).active; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const stored = await getProjectRecord(record.project.id);
    expect(stored.sceneChecks?.[first!.id]?.quick).toBeDefined();
    expect(stored.sceneChecks?.[second!.id]).toBeUndefined();
    const status = await summariseSceneChecks(stored);
    // Rule findings are open, so it reads as issues — never as passed.
    expect(status[first!.id]!.quick).toBe("issues");
    expect(status[second!.id]!.quick).toBe("not_checked");
  });

  it("fixes the missing skin tone mechanically, applies it like a hand edit, and then reads as out of date", async () => {
    const record = await project();
    const sceneId = record.storyboard!.scenes[0]!.id;
    const check = await checkSceneNow(record.project.id, sceneId, "quick");
    const identity = check.findings.find((f) => f.code === "identity_missing")!;

    const preview = await previewSceneCheckFix(record.project.id, sceneId, "quick", identity.id);
    expect(preview.method).toBe("rebuild");
    expect(preview.after).toContain("Leroy (a Black man with dark espresso-brown skin)");

    await applySceneCheckFix(record.project.id, {
      kind: preview.kind, sceneId, field: preview.field, after: preview.after, sourceHash: preview.sourceHash,
    });
    const after = await getProjectRecord(record.project.id);
    expect(after.storyboard!.scenes[0]!.prompts.startFramePrompt).toContain("(a Black man");
    expect((await summariseSceneChecks(after))[sceneId]!.quick).toBe("out_of_date");
  });

  it("refuses a fix previewed against text that has since changed", async () => {
    const record = await project();
    const sceneId = record.storyboard!.scenes[0]!.id;
    const check = await checkSceneNow(record.project.id, sceneId, "quick");
    const preview = await previewSceneCheckFix(
      record.project.id, sceneId, "quick", check.findings.find((f) => f.code === "identity_missing")!.id,
    );
    await updateScenePrompts(record.project.id, sceneId, { startFramePrompt: "Someone edited this by hand." });
    await expect(applySceneCheckFix(record.project.id, {
      kind: preview.kind, sceneId, field: preview.field, after: preview.after, sourceHash: preview.sourceHash,
    })).rejects.toThrow(/changed after the fix was previewed/);
  });

  it("records an acceptance against the inputs it was given for", async () => {
    const record = await project();
    const sceneId = record.storyboard!.scenes[0]!.id;
    const check = await checkSceneNow(record.project.id, sceneId, "quick");
    const updated = await acceptSceneFinding(record.project.id, sceneId, "quick", check.findings[0]!.id, true);
    expect(updated.sceneChecks![sceneId]!.quick!.findings[0]!.accepted?.inputHash).toBe(check.inputHash);
  });

  /** "Check first" on a rerun: the scene missing his skin tone waits; the clean one renders. */
  it("holds a scene with an open error and queues the rest for the rerun", async () => {
    reviewer.answer = { findings: [] };
    const record = await project();
    const [held, clean] = record.storyboard!.scenes;
    await checkThenRender(record.project.id, [held!.id, clean!.id], "quick", "keyframes");
    for (let i = 0; i < 200 && getSceneCheckProgress(record.project.id).followUp?.state === "waiting"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const followUp = getSceneCheckProgress(record.project.id).followUp!;
    expect(followUp.state).toBe("queued");
    expect(followUp.held?.map((scene) => scene.sceneId)).toEqual([held!.id]);
    expect(followUp.held?.[0]?.reason).toMatch(/^identity_missing/);
    expect(followUp.queued).toBe(1);
    expect(getQueue(record.project.id).entries.map((entry) => entry.sceneId)).toEqual([clean!.id]);
    cancelQueue(record.project.id);
  });

  /** Rule findings alone are not a review: a scene nobody could vouch for is not rendered. */
  it("holds a scene whose review returned nothing usable", async () => {
    const record = await project();
    const clean = record.storyboard!.scenes[1]!;
    await checkThenRender(record.project.id, [clean.id], "quick", "keyframes");
    for (let i = 0; i < 200 && getSceneCheckProgress(record.project.id).followUp?.state === "waiting"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const followUp = getSceneCheckProgress(record.project.id).followUp!;
    expect(followUp.queued).toBe(0);
    expect(followUp.held?.[0]?.reason).toMatch(/nothing usable/);
  });

  it("keeps an acceptance made while the scene was being re-checked", async () => {
    const record = await project();
    const sceneId = record.storyboard!.scenes[0]!.id;
    const first = await checkSceneNow(record.project.id, sceneId, "quick");
    // The acceptance lands on the stored record after the re-check has read it.
    await acceptSceneFinding(record.project.id, sceneId, "quick", first.findings[0]!.id, true);
    await checkSceneNow(record.project.id, sceneId, "quick");
    const stored = (await getProjectRecord(record.project.id)).sceneChecks![sceneId]!.quick!;
    expect(stored.findings.find((f) => f.id === first.findings[0]!.id)?.accepted).toBeDefined();
  });
});
