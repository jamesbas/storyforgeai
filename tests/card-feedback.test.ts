import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPlanningProvider, type PlanningProvider } from "@/lib/agents/llm/provider";
import { cardEditFrom, wardrobeChangeFor } from "@/lib/agents/card-feedback";
import { repository } from "@/lib/db/store";
import type { CardFeedbackProposal } from "@/lib/schemas/card-feedback";
import type { Character } from "@/lib/schemas/character";
import type { ProjectRecord } from "@/lib/schemas/storyboard";
import { createProject, generateStoryboard, getProjectRecord, updateSceneCard } from "@/lib/services/project-service";
import { applyCardFeedback, previewCardFeedback } from "@/lib/services/card-feedback-service";
import { getAgentRun, resetAgentRuns } from "@/lib/services/agent-runs";
import { getQueue } from "@/lib/services/scene-queue";
import { POST, PUT } from "@/app/api/projects/[projectId]/feedback/cards/route";

vi.mock("@/lib/agents/llm/provider", async (original) => ({
  ...await original<typeof import("@/lib/agents/llm/provider")>(),
  getPlanningProvider: vi.fn(() => null),
}));
vi.mock("@/lib/services/scene-queue", () => ({
  getQueue: vi.fn(() => ({ active: false, entries: [], remaining: 0 })),
}));

const action = "Mara picks up the phone from the table.";
const correctedAction = "Mara picks up the cup from the table and drinks.";
const start = "Medium shot, eye level. Mara stands beside a table.";
const end = "Medium shot, eye level. Mara holds the phone.";

function proposal(overrides: Partial<CardFeedbackProposal> = {}): CardFeedbackProposal {
  return {
    summary: "Mara picks up the cup, not the phone.",
    revisions: [{ field: "actionDescription", after: correctedAction, reason: "The cup is what she reaches for." }],
    frameVisibility: { changed: false, start: ["Mara"], end: ["Mara"] },
    dialogue: { changed: false, lines: [] },
    wardrobe: { changed: false, changes: [] },
    ...overrides,
  };
}

function model(answer: unknown = proposal()): PlanningProvider {
  return {
    name: "test-card-feedback",
    generateJson: vi.fn(async (_system, _user, schema) => answer === null ? null : schema.parse(answer)),
  };
}

async function seeded(): Promise<ProjectRecord> {
  const project = await createProject({
    concept: "Mara picks up a cup from the table.",
    requestedDurationSeconds: 30,
    sceneContinuity: "cut",
    generationMode: "video_segments",
  });
  const record = await generateStoryboard(project.id);
  const scenes = record.storyboard!.scenes.map((scene) => ({
    ...scene,
    actionDescription: action,
    frameVisibility: { start: ["Mara"], end: ["Mara"] },
    dialogue: [],
    prompts: { ...scene.prompts, startFramePrompt: start, endFramePrompt: end },
  }));
  const updated = { ...record, storyboard: { ...record.storyboard!, scenes } };
  await repository.update(project.id, updated);
  return updated;
}

beforeEach(() => {
  resetAgentRuns();
  vi.mocked(getPlanningProvider).mockReturnValue(null);
  vi.mocked(getQueue).mockReturnValue({ active: false, entries: [], remaining: 0 });
});
afterEach(() => vi.restoreAllMocks());

describe("correcting scene cards from feedback", () => {
  it("previews each picked card in story order without saving anything", async () => {
    const record = await seeded();
    const provider = model();
    vi.mocked(getPlanningProvider).mockReturnValue(provider);
    const [first, second] = record.storyboard!.scenes;
    const response = await POST(new Request("http://localhost/cards", {
      method: "POST",
      body: JSON.stringify({ sceneIds: [second!.id, first!.id], feedback: "She picks up the cup, not the phone." }),
    }), { params: Promise.resolve({ projectId: record.project.id }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const preview = await response.json();

    expect(preview.scenes.map((s: { sceneNumber: number }) => s.sceneNumber)).toEqual([1, 2]);
    expect(preview.scenes[0].changes).toEqual([
      expect.objectContaining({ field: "actionDescription", before: action, after: correctedAction }),
    ]);
    expect(preview.scenes[0].edit).toEqual({ sceneId: first!.id, card: { actionDescription: correctedAction }, wardrobe: null });
    const payload = JSON.parse(vi.mocked(provider.generateJson).mock.calls[0]![1]);
    expect(payload).toMatchObject({
      feedback: "She picks up the cup, not the phone.",
      card: { actionDescription: action, frameVisibility: { start: ["Mara"], end: ["Mara"] } },
      wardrobe: { changesAtThisScene: [] },
    });
    expect(await getProjectRecord(record.project.id)).toEqual(record);
    expect(getAgentRun(record.project.id)).toBeNull();
  });

  it("saves the accepted cards and wardrobe together, then rewrites only the ticked prompts from them", async () => {
    const record = await seeded();
    vi.mocked(getPlanningProvider).mockReturnValue(model(proposal({
      wardrobe: { changed: true, changes: [{ who: "Mara", wardrobe: "a red wool dress", mode: "between" }] },
    })));
    const scene = record.storyboard!.scenes[0]!;
    const preview = await previewCardFeedback(record.project.id, { sceneIds: [scene.id], feedback: "Cup, and a red dress." });
    vi.mocked(getPlanningProvider).mockReturnValue(null);

    const response = await PUT(new Request("http://localhost/cards", {
      method: "PUT",
      body: JSON.stringify({ sourceHash: preview.sourceHash, targets: ["end"], edits: preview.scenes.map((s) => s.edit) }),
    }), { params: Promise.resolve({ projectId: record.project.id }) });
    expect(response.status).toBe(200);
    const { record: after, promptsRewritten } = await response.json() as { record: ProjectRecord; promptsRewritten: boolean };

    expect(promptsRewritten).toBe(true);
    const saved = after.storyboard!.scenes[0]!;
    expect(saved.actionDescription).toBe(correctedAction);
    expect(after.project.wardrobeChanges?.[scene.id]).toEqual([{ subject: "Mara", wardrobe: "a red wool dress", mode: "between" }]);
    expect(saved.prompts.startFramePrompt).toBe(start);
    expect(saved.prompts.endFramePrompt).not.toBe(end);
    expect(after.storyboard!.scenes[1]!.actionDescription).toBe(action);
    expect(after.history!.map((h) => h.action)).toEqual(expect.arrayContaining([
      "scene.card_edited", "scene.wardrobe_changed", "scene.prompts_rewritten",
    ]));
  });

  it("warns that a wardrobe change carries into later scenes that are not rewritten", async () => {
    const record = await seeded();
    vi.mocked(getPlanningProvider).mockReturnValue(model(proposal({
      revisions: [],
      wardrobe: { changed: true, changes: [{ who: "Mara", wardrobe: "a red wool dress", mode: "between" }] },
    })));
    const preview = await previewCardFeedback(record.project.id, {
      sceneIds: [record.storyboard!.scenes[0]!.id], feedback: "She wears a red dress.",
    });
    expect(preview.warnings).toContainEqual(expect.stringMatching(/carry forward into scenes? 2/));
  });

  it("refuses to apply a preview after the project changed, saving nothing", async () => {
    const record = await seeded();
    vi.mocked(getPlanningProvider).mockReturnValue(model());
    const scene = record.storyboard!.scenes[0]!;
    const preview = await previewCardFeedback(record.project.id, { sceneIds: [scene.id], feedback: "The cup." });
    await updateSceneCard(record.project.id, scene.id, { title: "Edited by hand" });
    const before = await getProjectRecord(record.project.id);
    await expect(applyCardFeedback(record.project.id, {
      sourceHash: preview.sourceHash, targets: ["start", "end", "video"], edits: preview.scenes.map((s) => s.edit),
    })).rejects.toThrow(/changed after this preview/);
    expect(await getProjectRecord(record.project.id)).toEqual(before);
  });

  it("lists a scene the model cannot correct and still previews the rest", async () => {
    const record = await seeded();
    const provider = model();
    vi.mocked(provider.generateJson).mockResolvedValueOnce(null);
    vi.mocked(getPlanningProvider).mockReturnValue(provider);
    const [first, second] = record.storyboard!.scenes;
    const preview = await previewCardFeedback(record.project.id, { sceneIds: [first!.id, second!.id], feedback: "The cup." });
    expect(preview.failed).toEqual([expect.objectContaining({ sceneId: first!.id, error: expect.stringMatching(/no usable card correction/) })]);
    expect(preview.scenes.map((s) => s.sceneId)).toEqual([second!.id]);
  });
});

describe("card edit contracts", () => {
  const cast = [{ id: "c1", name: "Mara Okafor" }, { id: "c2", name: "Jon Lee" }] as unknown as Character[];

  it("pins a wardrobe change to a cast member by full or unique first name, and keeps anyone else as a subject", () => {
    expect(wardrobeChangeFor({ who: "mara okafor", wardrobe: "a coat", mode: "between" }, cast))
      .toEqual({ characterId: "c1", wardrobe: "a coat", mode: "between" });
    expect(wardrobeChangeFor({ who: "Jon", wardrobe: "a coat", mode: "within" }, cast))
      .toEqual({ characterId: "c2", wardrobe: "a coat", mode: "within" });
    expect(wardrobeChangeFor({ who: "the bartender", wardrobe: "an apron", mode: "between" }, cast))
      .toEqual({ subject: "the bartender", wardrobe: "an apron", mode: "between" });
  });

  it("keeps only real changes and rejects a field revised twice", async () => {
    const scene = (await seeded()).storyboard!.scenes[0]!;
    const unchanged = proposal({
      revisions: [{ field: "actionDescription", after: action, reason: "Already right." }],
      frameVisibility: { changed: true, start: ["Mara"], end: ["Mara"] },
      dialogue: { changed: true, lines: [] },
    });
    expect(cardEditFrom(scene, unchanged, cast, [])).toEqual({ sceneId: scene.id, card: null, wardrobe: null });
    const twice = proposal({ revisions: [...proposal().revisions, ...proposal().revisions] });
    expect(() => cardEditFrom(scene, twice, cast, [])).toThrow(/twice/);
  });

  it("proposes a dialogue mode with the lines, and silence when feedback removes them all", async () => {
    const base = (await seeded()).storyboard!.scenes[0]!;
    const speaking = { ...base, dialogueMode: "full" as const, dialogue: [{ character: "Mara", line: "Not now." }] };
    const emptied = cardEditFrom(speaking, proposal({ revisions: [], dialogue: { changed: true, lines: [] } }), cast, []);
    expect(emptied.card).toEqual({ dialogue: [], dialogueMode: "silent" });
    const shorter = cardEditFrom(speaking, proposal({
      revisions: [],
      dialogue: { changed: true, lines: [{ character: "Mara", line: "Later." }], mode: "brief" },
    }), cast, []);
    expect(shorter.card).toEqual({ dialogue: [{ character: "Mara", line: "Later." }], dialogueMode: "brief" });
    // Silence beside lines contradicts itself; the lines win.
    const contradictory = cardEditFrom(speaking, proposal({
      revisions: [],
      dialogue: { changed: true, lines: [{ character: "Mara", line: "Later." }], mode: "silent" },
    }), cast, []);
    expect(contradictory.card).toEqual({ dialogue: [{ character: "Mara", line: "Later." }] });
  });
});
