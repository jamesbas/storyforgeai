import { describe, it, expect, afterEach, vi } from "vitest";
import type { Project } from "@/lib/schemas/project";
import type { SceneDraft } from "@/lib/schemas/storyboard";
import { normaliseImagePrompt } from "@/lib/agents/media-prompt-normalise";
import { buildMediaPromptSpec } from "@/lib/agents/media-prompt-builder";
import { hasPunctuationArtifact, lintRendered } from "@/lib/agents/media-prompt-spec";
import { opensWithFraming } from "@/lib/agents/media-prompt-normalise";

/**
 * SPEC-003's actual goal: whichever path writes a prompt, it satisfies the same
 * semantic contract. A provider fallback must not quietly change the rules.
 */

async function composer() {
  vi.resetModules();
  process.env.MEDIA_PROMPT_COMPOSER_V2 = "true";
  return import("@/lib/agents/mock-agents");
}

const original = process.env.MEDIA_PROMPT_COMPOSER_V2;
afterEach(() => {
  if (original === undefined) delete process.env.MEDIA_PROMPT_COMPOSER_V2;
  else process.env.MEDIA_PROMPT_COMPOSER_V2 = original;
  vi.resetModules();
});

const project = { id: "p1", segmentCount: 3, segmentSeconds: 20, style: "cinematic", tone: "moody" } as Project;

function scene(overrides: Partial<SceneDraft> = {}): SceneDraft {
  return {
    id: "p1-scene-002",
    projectId: "p1",
    sceneNumber: 2,
    startTimeSeconds: 20,
    endTimeSeconds: 40,
    targetDurationSeconds: 20,
    title: "The turn",
    sceneObjective: "Commit",
    storyBeat: "The apprentice commits to the repair",
    visualDescription: "Wide shot of the workshop, low angle",
    actionDescription: "She seats the gear with a firm turn. The scarf whips left.",
    cameraMovement: "Slow push-in",
    transitionIn: "cut",
    transitionOut: "cut",
    continuityNotes: [],
    subjectFaceVisible: true,
    charactersPresent: [],
    wardrobeChanges: [],
    status: "draft",
    ...overrides,
  } as SceneDraft;
}

/** The facts a prompt must carry, whoever wrote it. */
function satisfiesImageContract(text: string) {
  return {
    opensWithFraming: opensWithFraming(text),
    clean: !hasPunctuationArtifact(text),
    noDuplicates: !lintRendered(text, "flux", "image", 0).some(
      (f) => f.code === "duplicate_sentence",
    ),
  };
}

describe("deterministic and model-authored prompts meet the same contract", () => {
  it("both open with shot size and camera height", async () => {
    const { buildImagePrompts } = await composer();
    const deterministic = buildImagePrompts(project, scene(), [], undefined, undefined, "flux");

    // A model that answered without framing, which the system prompt asks for
    // but cannot guarantee.
    const spec = buildMediaPromptSpec(project, scene(), undefined, undefined);
    const normalised = normaliseImagePrompt(
      "The apprentice leans into the movement, brass catching the light.",
      spec,
      "flux",
    );

    expect(satisfiesImageContract(deterministic.startFramePrompt).opensWithFraming).toBe(true);
    expect(satisfiesImageContract(normalised.text).opensWithFraming).toBe(true);
  });

  it("both derive the same framing from the same card", async () => {
    const spec = buildMediaPromptSpec(project, scene(), undefined, undefined);
    const { buildImagePrompts } = await composer();
    const deterministic = buildImagePrompts(project, scene(), [], undefined, undefined, "flux");
    const normalised = normaliseImagePrompt("A quiet moment at the bench.", spec, "flux");

    // The card says "Wide shot ... low angle", so both must say so.
    expect(deterministic.startFramePrompt.startsWith("Wide shot, low angle.")).toBe(true);
    expect(normalised.text.startsWith("Wide shot, low angle.")).toBe(true);
  });

  it("both come out free of duplicates and punctuation artifacts", async () => {
    const { buildImagePrompts } = await composer();
    const spec = buildMediaPromptSpec(project, scene(), undefined, undefined);
    const deterministic = buildImagePrompts(project, scene(), [], undefined, undefined, "flux");
    const normalised = normaliseImagePrompt(
      "Wide shot, low angle. The gear turns. The gear turns., again",
      spec,
      "flux",
    );

    for (const text of [deterministic.startFramePrompt, normalised.text]) {
      const contract = satisfiesImageContract(text);
      expect(contract.clean, text.slice(0, 60)).toBe(true);
      expect(contract.noDuplicates, text.slice(0, 60)).toBe(true);
    }
  });

  it("keeps dialogue verbatim on both paths", async () => {
    const { buildVideoPrompts } = await composer();
    const speaking = scene({
      dialogue: [{ character: "Ana", line: "Then we decide now, together." }],
    } as Partial<SceneDraft>);
    const deterministic = buildVideoPrompts(project, speaking, [], undefined, undefined, "ltx");
    expect(deterministic.videoPromptSegment).toContain('"Then we decide now, together."');
  });
});

/**
 * FR-5: a 5-second clip and a 20-second clip are not the same brief, and the
 * old builder wrote the same prompt for both.
 */
describe("duration changes what fits", () => {
  it("gives a longer segment a larger budget", async () => {
    const { buildVideoPrompts } = await composer();
    const short = buildVideoPrompts(
      project,
      scene({ targetDurationSeconds: 5, trimAtEndSeconds: undefined }),
      [],
      undefined,
      undefined,
      "ltx",
    );
    const long = buildVideoPrompts(
      project,
      scene({ targetDurationSeconds: 20, trimAtEndSeconds: undefined }),
      [],
      undefined,
      undefined,
      "ltx",
    );
    expect(short.videoPromptSegment).toContain("Over 5 seconds");
    expect(long.videoPromptSegment).toContain("Over 20 seconds");
  });

  it("warns when dialogue cannot fit the segment, on either path", () => {
    const spec = buildMediaPromptSpec(
      project,
      scene({
        targetDurationSeconds: 5,
        dialogue: [
          {
            character: "Ana",
            line: "We have gone over this a dozen times and I am not going to keep pretending that any of it changes what happens next.",
          },
        ],
      } as Partial<SceneDraft>),
      undefined,
      undefined,
    );
    expect(spec.dialogue).toHaveLength(1);
    // The line is kept whole; the warning is what tells the author it will rush.
    expect(spec.dialogue[0].line).toContain("changes what happens next");
  });
});
