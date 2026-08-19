import { describe, it, expect } from "vitest";
import type { ZodType, ZodTypeDef } from "zod";
import { castPromptSuffix, castSheet, castSystemDirective } from "@/lib/agents/cast";
import { explicitnessDirective, isExplicitProject, isExplicitScene } from "@/lib/agents/explicitness";
import { gateFramePair, gateImagePrompt, repairImagePrompt } from "@/lib/agents/prompt-gate";
import { lintRendered } from "@/lib/agents/media-prompt-spec";
import { attachScenePrompts } from "@/lib/agents/prompt-agents";
import { storyArchitectAgent } from "@/lib/agents/story-architect-agent";
import { isTightShot } from "@/lib/media/seam";
import type { ArtifactExecution } from "@/lib/schemas/provenance";
import type { PlanningProvider } from "@/lib/agents/llm/provider";
import type { SceneDraft } from "@/lib/schemas/storyboard";
import type { Character } from "@/lib/schemas/character";
import type { Project } from "@/lib/schemas/project";

/**
 * Prompts for explicit work.
 *
 * A scene written as a sexual act produced a prompt that named no anatomy, and
 * ended with an instruction to keep her clothes on. Three separate causes: the
 * agent was never told the piece was explicit, wardrobe had no way to express
 * its own absence, and a head-to-toe description was appended to a close-up.
 */

const MARA: Character = {
  id: "char-mara",
  name: "Mara",
  description: "Mara: A woman in her fifties with honey-blonde hair.",
  facialDescription: "Green eyes and a broad mouth.",
  wardrobe: "short black silk robe",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "p1",
    title: "T",
    concept: "c",
    style: "erotic art film",
    tone: "erotic",
    audience: "adults only, explicit content",
    segmentSeconds: 8,
    segmentCount: 1,
    ...overrides,
  } as Project;
}

const ACTION = "Mara straddles Mark and takes his penis inside her, riding him slowly.";

function scene(overrides: Partial<SceneDraft> = {}): SceneDraft {
  return {
    id: "scene-1",
    projectId: "p1",
    sceneNumber: 1,
    startTimeSeconds: 0,
    endTimeSeconds: 8,
    targetDurationSeconds: 8,
    title: "On the bed",
    sceneObjective: "She takes the lead.",
    storyBeat: "They reach the bed.",
    visualDescription: "Mara and Mark on a bed in warm lamplight.",
    actionDescription: ACTION,
    cameraMovement: "Slow push-in",
    transitionIn: "cut",
    transitionOut: "cut",
    continuityNotes: [],
    subjectFaceVisible: true,
    charactersPresent: ["Mara"],
    wardrobeChanges: [],
    status: "planned",
    ...overrides,
  } as SceneDraft;
}

const COY =
  "Medium shot, eye level. Mara and Mark share an intimate embrace in warm lamplight, " +
  "their union tastefully implied as the camera lingers on the soft glow of the room.";

const CONCRETE =
  "Medium shot, eye level. Mara straddles Mark on the bed in warm lamplight, his cock " +
  "(penis) fully inserted in her pussy (vagina), her labia stretched around his shaft, her " +
  "thighs either side of his hips, her breasts lifted, mouth open, skin sweat-slick.";

/** The prompt this project actually shipped for scene 10, verbatim. */
const SHIPPED_ORAL =
  "Medium close-up, low angle, 35mm lens. A muscular Black man in his 30s wearing black silk " +
  "trousers performs oral sex on Mara; his mouth is pressed against her soft skin between " +
  "her thighs. Mara lies back on white wrinkled linens, reaching down to grasp the man's " +
  "hair with her bright blue manicured nails.";

/** And the three-hander, whose act is carried entirely by the verb "engages". */
const SHIPPED_VAN =
  "Medium shot, eye level, inside the dark van, showing the full rhythmic motion of the three " +
  "bodies. Mara is pinned on her back against the van wall, her body lifting slightly with " +
  "each heavy thrust as the first man engages her from the front and the second man engages " +
  "her from behind in a continuous dual rhythm.";

/** Answers the image agent with a fixed pair of frames, recording every call. */
function imageProvider(frames: () => string) {
  const calls: { system: string }[] = [];
  const provider: PlanningProvider = {
    name: "test",
    generateJson: async <T,>(
      system: string,
      _user: string,
      _schema: ZodType<T, ZodTypeDef, unknown>,
    ) => {
      calls.push({ system });
      if (!system.startsWith("You are the Image Prompt Agent")) return null as T | null;
      const text = frames();
      return {
        startFramePrompt: text,
        endFramePrompt: text,
        imageNegativePrompt: "blurry",
      } as unknown as T;
    },
  };
  const imageCalls = () => calls.filter((c) => c.system.startsWith("You are the Image Prompt Agent"));
  return { calls, imageCalls, provider };
}

describe("telling the agent the work is explicit", () => {
  it("recognises an explicit audience", () => {
    expect(isExplicitProject(project())).toBe(true);
  });

  it("recognises an explicit tone even with a general audience", () => {
    expect(isExplicitProject(project({ audience: "adults", tone: "raw and carnal" }))).toBe(true);
  });

  it("says nothing for work that is not explicit", () => {
    const tame = project({ audience: "families", tone: "inspirational" });
    expect(isExplicitProject(tame)).toBe(false);
    expect(explicitnessDirective(tame, "image")).toBe("");
  });

  /** The preset descriptions existed and reached no model. */
  it("carries the preset's own wording to the model", () => {
    expect(explicitnessDirective(project(), "image")).toContain(
      "Nothing is softened, implied or cut away from",
    );
  });

  it("names euphemism as the failure to avoid", () => {
    const directive = explicitnessDirective(project(), "image");
    expect(directive).toContain("the point of contact");
    expect(directive).toMatch(/renders nouns/);
  });

  it("asks the clip prompt for movement rather than a held frame", () => {
    expect(explicitnessDirective(project(), "video")).toMatch(/rhythm, direction, depth and pace/);
  });

  /**
   * The instruction that was already there and was answered with "his mouth is
   * pressed against her soft skin between her thighs". Every instruction in
   * this prompt that the model does obey ships with a worked example; this one
   * did not.
   */
  it("states the frame contract as required elements with an example", () => {
    const directive = explicitnessDirective(project(), "image");
    for (const element of [
      "The position, named",
      "What is inside what",
      "How far in",
      "genital anatomy visible from this angle",
      "Where skin meets skin",
      "Wetness and sheen",
      "Breasts and nipples",
    ]) {
      expect(directive).toContain(element);
    }
    expect(directive).toMatch(/A finished frame reads like this/);
  });

  /** A checkpoint knows one vocabulary or the other, and rarely both. */
  it("asks for both registers so either model finds the word it knows", () => {
    const directive = explicitnessDirective(project(), "image");
    expect(directive).toContain("his cock (penis)");
    expect(directive).toContain("her pussy (vagina)");
  });

  /** A still has no rhythm, and the shipped prompt spent itself describing one. */
  it("forbids rhythm and repetition in a still", () => {
    const directive = explicitnessDirective(project(), "image");
    expect(directive).toMatch(/A still cannot show rhythm/);
    expect(directive).toContain("with each thrust");
  });

  /**
   * The unconditional rule earlier in the prompt dressed the man performing
   * oral sex in black silk trousers, and an outfit outranks the act.
   */
  it("overrides the rule that dresses everyone outside the cast", () => {
    const directive = explicitnessDirective(project(), "image");
    expect(directive).toMatch(/Everyone taking part in the act is naked/);
    expect(directive).toMatch(/overrides the instruction/);
  });

  it("tells the planning agents a label is not a description", () => {
    const directive = explicitnessDirective(project(), "plan");
    expect(directive).toMatch(/Naming the category is not describing it/);
    expect(directive).toContain("he engages her from behind");
  });

  /**
   * The planning agents write the card the render prompt is built from, so an
   * act described obliquely there cannot be recovered downstream.
   */
  it("tells the planning agents to describe the act, not the mood around it", () => {
    const directive = explicitnessDirective(project(), "plan");
    expect(directive).toMatch(/must describe the act/);
    expect(directive).toMatch(/fade out, cut away/);
    expect(directive).toContain("they come together");
  });

  it("does not tell a planning agent to write a still frame", () => {
    expect(explicitnessDirective(project(), "plan")).not.toMatch(/one still frame/);
  });

  it("stays silent for tame work whatever the caller asks for", () => {
    const tame = project({ audience: "families", tone: "inspirational" });
    for (const kind of ["image", "video", "plan"] as const) {
      expect(explicitnessDirective(tame, kind)).toBe("");
    }
  });
});

describe("nudity as a wardrobe state", () => {
  /** The defect: the last line of an explicit prompt put her clothes back on. */
  it("states the absence instead of wearing it", () => {
    const sheet = castSheet([MARA], true, { "char-mara": "nude" });
    expect(sheet).toContain("completely naked with no clothing.");
    expect(sheet).not.toContain("wearing nude");
  });

  it("accepts the other ways of saying it", () => {
    for (const word of ["naked", "Fully nude", "undressed", "no clothing"]) {
      expect(castSheet([MARA], true, { "char-mara": word })).toContain("completely naked");
    }
  });

  /** Bound to the person, not stated after them, so it cannot drift to another body. */
  it("leaves a real outfit alone", () => {
    expect(castSheet([MARA], true)).toContain(", dressed in short black silk robe.");
  });

  /** "Robe open" is not nudity, and reads correctly as an outfit. */
  it("does not mistake a partial state for nudity", () => {
    const sheet = castSheet([MARA], true, { "char-mara": "black silk robe, open" });
    expect(sheet).toContain(", dressed in black silk robe, open.");
  });

  /** A planning agent is writing the record, and keeps the explicit form. */
  it("keeps the standalone clause for planning agents", () => {
    expect(castSheet([MARA], false)).toContain("Wearing exactly: short black silk robe.");
  });
});

/**
 * The sheet has a total budget rather than a per-person allowance, because a
 * per-person one grows with the cast: at a fixed 220 characters each, a
 * six-hander is back to the 1500 characters that failed.
 */
describe("keeping the sheet the same size however big the cast", () => {
  const long = (name: string) => ({
    ...MARA,
    id: `char-${name}`,
    name,
    description: `${name} is a person. ${"Every detail of their appearance recorded at length. ".repeat(12)}`,
  });

  const sheetFor = (count: number) =>
    castSheet(
      Array.from({ length: count }, (_, i) => long(`Person${i}`)),
      true,
    );

  /** What matters is the share each person gets, not the total, which a long
   *  wardrobe can inflate on its own. */
  it("gives each person less as the cast grows", () => {
    const perPersonAtTwo = sheetFor(2).length / 2;
    const perPersonAtSix = sheetFor(6).length / 6;
    expect(perPersonAtSix).toBeLessThan(perPersonAtTwo * 0.8);
  });

  /** A crowd is trimmed, but never past the point of identifying anybody. */
  it("keeps every person identifiable in a crowd", () => {
    const sheet = sheetFor(6);
    for (let i = 0; i < 6; i += 1) expect(sheet).toContain(`Person${i}:`);
    expect(sheet).toContain("is a person");
  });

  it("still spends generously on a single figure", () => {
    expect(sheetFor(1).length).toBeGreaterThan(200);
  });
});

describe("scaling the sheet to the shot", () => {
  const photographed = { ...MARA, referenceImages: ["mara.png"] };

  it("keeps the full description when text is the only identity signal", () => {
    const sheet = castSheet([MARA], true, undefined, { tightShot: true });
    expect(sheet).toContain("honey-blonde hair");
  });

  /** With a photograph carrying the likeness, the inventory is out of frame. */
  it("trims to name and wardrobe on a close-up with a reference photo", () => {
    const sheet = castSheet([photographed], true, undefined, { tightShot: true });
    expect(sheet).not.toContain("honey-blonde hair");
    expect(sheet).toContain("Mara:");
    expect(sheet).toContain("Wearing exactly: short black silk robe.");
  });

  it("keeps the description on a wider shot", () => {
    const sheet = castSheet([photographed], true, undefined, { tightShot: false });
    expect(sheet).toContain("honey-blonde hair");
  });

  /** A written face competes with a framing that crops the head. */
  it("withholds the face when the shot does not show one", () => {
    const noFace = { ...MARA, referenceImages: undefined };
    expect(castSheet([noFace], true, undefined, { faceVisible: false })).not.toContain("Green eyes");
    expect(castSheet([noFace], true, undefined, { faceVisible: true })).toContain("Green eyes");
  });

  it("still gives planning agents the whole description", () => {
    expect(castSheet([photographed], false, undefined, { tightShot: true })).toContain(
      "honey-blonde hair",
    );
  });
});

describe("reading the shot size of a prompt", () => {
  it("treats a close-up and tighter as tight", () => {
    expect(isTightShot("Close-up, low angle. A tight shot of...")).toBe(true);
    expect(isTightShot("Extreme close-up of her hands.")).toBe(true);
  });

  it("does not treat a medium or wider as tight", () => {
    expect(isTightShot("Wide shot, eye level. Four men at a table.")).toBe(false);
    expect(isTightShot("Medium shot of the pair.")).toBe(false);
  });
});

describe("the doubled name", () => {
  /** The stored description opened with the name, and the sheet added it again. */
  it("does not write the name twice", () => {
    expect(castPromptSuffix([MARA])).toContain("Mara: A woman in her fifties");
    expect(castPromptSuffix([MARA])).not.toContain("Mara: Mara:");
  });
});

/**
 * Scoping the cast sheet to the scene made the render directive vanish along
 * with it: a scene the pinned cast is absent from got an empty directive, so
 * nothing told the agent to describe the people who *were* there. Four men at a
 * poker table came back as a pair of hands.
 */
describe("people who are not in the pinned cast", () => {
  it("still asks for a description when the scene has no pinned cast", () => {
    const directive = castSystemDirective([], true);
    expect(directive).toMatch(/must be described in your own/);
    expect(directive).toMatch(/specific named garments/);
  });

  it("asks for it alongside the cast rules when there is a cast", () => {
    expect(castSystemDirective([MARA], true)).toMatch(/must be described in your own/);
  });

  /**
   * Length is what went wrong: one character described at four times another's
   * length was rendered twice while the other was dropped.
   */
  it("asks for those descriptions to be compact and evenly weighted", () => {
    const directive = castSystemDirective([MARA], true);
    expect(directive).toMatch(/compact clause/);
    expect(directive).toMatch(/roughly the same length/);
    expect(directive).toMatch(/same clause as the person/);
  });

  /** Planning agents describe everyone anyway; this is a render-prompt rule. */
  it("says nothing to a planning agent with no cast", () => {
    expect(castSystemDirective([])).toBe("");
  });});

/**
 * A project can be adult without saying so in its two dropdowns, and it is the
 * scene that gets rendered rather than the project.
 */
describe("recognising explicit work the settings do not announce", () => {
  it("reads a concept that says what happens", () => {
    const byConcept = project({
      audience: "adults",
      tone: "warm",
      style: "cinematic",
      concept: "Two lovers, naked, through one night.",
    });
    expect(isExplicitProject(byConcept)).toBe(true);
  });

  it("reads the scene when the project as a whole is tame", () => {
    const tame = project({ audience: "adults", tone: "warm", style: "cinematic", concept: "c" });
    expect(isExplicitProject(tame)).toBe(false);
    expect(isExplicitScene(scene())).toBe(true);
    expect(explicitnessDirective(tame, "image", scene())).toContain("Name the anatomy");
  });

  it("still says nothing for a tame scene in a tame project", () => {
    const tame = project({ audience: "families", tone: "inspirational", style: "cinematic" });
    const gentle = scene({
      actionDescription: "She walks to the window and opens it.",
      visualDescription: "A woman alone in a kitchen.",
      storyBeat: "She decides to leave.",
      sceneObjective: "Show the decision.",
    });
    expect(isExplicitScene(gentle)).toBe(false);
    expect(explicitnessDirective(tame, "image", gentle)).toBe("");
  });
});

/**
 * The gap this closes: everything upstream instructs, and nothing checked the
 * answer. The first version of the gate asked only whether the prompt held any
 * explicit word at all, and both prompts below passed it.
 */
describe("the acceptance gate on the finished keyframe prompt", () => {
  const ctx = {
    scene: scene(),
    participants: ["Mara"],
    explicit: true,
    establishedWardrobe: { start: "", end: "" },
  };

  it("passes a prompt that shows the act at that instant", () => {
    expect(gateImagePrompt(CONCRETE, "end", ctx)).toEqual([]);
  });

  it("rejects a prompt that keeps the mood and drops the act", () => {
    const codes = gateImagePrompt(COY, "end", ctx);
    expect(codes).toContain("action_dropped");
    expect(codes).toContain("euphemism");
    expect(codes).toContain("anatomy_unnamed");
    expect(codes).toContain("position_unstated");
  });

  /**
   * The prompt that shipped. It labels the act and describes nothing a model
   * can draw, and the man is in trousers while he does it.
   */
  it("rejects an act that is named but never depicted", () => {
    const oral = scene({
      storyBeat: "The man performs oral sex on Mara as she lies on the bed.",
      actionDescription:
        "The man continues his oral sex on Mara, his movements steady. Mara reaches down to " +
        "grasp the man's hair.",
      visualDescription: "A close-up of the man's mouth against Mara's skin.",
    });
    const codes = gateImagePrompt(SHIPPED_ORAL, "end", { ...ctx, scene: oral });
    expect(codes).toContain("anatomy_unnamed");
    expect(codes).toContain("contact_unstated");
    expect(codes).toContain("wardrobe_contradicts_act");
  });

  /** "Engages her from behind" reads as description and states nothing. */
  it("rejects the verb that stands in for the act", () => {
    const codes = gateImagePrompt(SHIPPED_VAN, "end", ctx);
    expect(codes).toContain("euphemism");
    expect(codes).toContain("anatomy_unnamed");
  });

  /** A still cannot show a rhythm, so asking for one wastes the whole prompt. */
  it("rejects rhythm and repetition in a still frame", () => {
    expect(gateImagePrompt(SHIPPED_VAN, "end", ctx)).toContain("motion_in_still");
  });

  it("leaves an outfit the wardrobe actually established alone", () => {
    const dressed = `${CONCRETE} She wears a short black silk robe, open.`;
    const established = { start: "short black silk robe", end: "short black silk robe" };
    expect(gateImagePrompt(dressed, "end", { ...ctx, establishedWardrobe: established })).toEqual(
      [],
    );
  });

  it("rejects a prompt that leaves a person in the scene unnamed", () => {
    const withoutHer = CONCRETE.replace(/Mara/g, "a woman");
    expect(gateImagePrompt(withoutHer, "end", ctx)).toContain("participant_missing");
  });

  it("rejects an empty answer the schema was happy with", () => {
    expect(gateImagePrompt("A still.", "end", ctx)).toEqual(["prompt_blank"]);
  });

  /**
   * An explicit project still contains scenes of people arriving somewhere,
   * and demanding penetration vocabulary there would be worse than useless.
   */
  it("asks none of it of a scene with no act in it", () => {
    const arrival = scene({
      storyBeat: "She parks outside the bar.",
      visualDescription: "A woman in a car on a wet street at night.",
      actionDescription: "Mara kills the engine and looks at the door.",
      sceneObjective: "Arrive.",
    });
    const prompt =
      "Wide shot, eye level. Mara sits in a parked car on a wet street at night, killing the " +
      "engine and looking at the bar door through the windscreen.";
    expect(gateImagePrompt(prompt, "start", { ...ctx, scene: arrival })).toEqual([]);
  });

  /** Euphemism is only a fault where the work asked to be explicit. */
  it("does not police wording on work that is not explicit", () => {
    const tame = { ...ctx, explicit: false };
    expect(gateImagePrompt(CONCRETE, "end", tame)).toEqual([]);
    expect(gateImagePrompt(COY, "end", tame)).not.toContain("euphemism");
  });
});

/**
 * A live scene from a 1.75 run. The model wrote a fully explicit prompt and the
 * gate rejected it anyway: it named contact as "deep in Mara's mouth" and
 * "press against her vulva", and position as "leans over her", none of which
 * the first vocabulary recognised. The repair then appended the card's action,
 * the same action's sentences again, and the story beat's paraphrase of it, so
 * the render was told the same thing three times.
 */
describe("the scene that came back repeating itself", () => {
  const card = scene({
    actionDescription:
      "Man 1 thrusts rhythmically into her vagina. Simultaneously, the second man leans over " +
      "her, his hands on either side of her head, guiding his cock into her mouth for a blowjob.",
    visualDescription:
      "Medium shot showing both men as they engage in a rhythmic, coordinated sequence with Mara.",
    storyBeat:
      "The first man thrusts into her while the second man leans over and guides his cock into " +
      "Mara's mouth.",
  });
  const ctx = {
    scene: card,
    participants: ["Mara"],
    explicit: true,
    establishedWardrobe: { start: "", end: "" },
  };

  const written =
    "Medium shot, eye level. Blowjob: The second heavy-set black man in his 40s has his cock " +
    "(penis) deep in Mara's mouth; Man 1 is visible below as he thrusts his cock (penis) into " +
    "her pussy (vagina). Exactly three people are in frame: one woman and two men. Mara's lips " +
    "are stretched wide around the glistening shaft of the man's cock (penis), with moisture " +
    "glinting where they meet; Man 1's hands grip her hips as his balls press against her vulva. " +
    "Her eyes are squeezed shut, her skin is flushed and sweat-slicked, and her breasts are " +
    "visible at the bottom of the frame.";

  /** The whole defect: this prompt was already correct and was repaired anyway. */
  it("accepts the prompt the model actually wrote", () => {
    expect(gateImagePrompt(written, "end", ctx)).toEqual([]);
  });

  /**
   * This prompt shipped as a close-up, and was recorded here as one. Nothing
   * then checked whether a close-up could hold the three people it names, and
   * it cannot — which is the fault the frame-capacity check was added for.
   */
  it("catches the close-up this scene was originally written as", () => {
    const asShipped = written.replace("Medium shot", "Close-up");
    expect(gateImagePrompt(asShipped, "end", ctx)).toEqual(["framing_too_tight"]);
  });

  it("reads contact and position as they are really written", () => {
    const noContact = written.replace(/deep in Mara's mouth/, "close to Mara");
    expect(gateImagePrompt(written, "end", ctx)).not.toContain("contact_unstated");
    expect(gateImagePrompt(written, "end", ctx)).not.toContain("position_unstated");
    // Still catches a prompt that genuinely states neither.
    expect(noContact).toContain("close to Mara");
  });

  /**
   * Defence in depth: even when a repair is warranted, nothing may be said
   * twice. A diffusion model weights a repeated sentence twice, which is the
   * opposite of what the repair is for.
   */
  it("never restates the action when it does have to repair", () => {
    const coy =
      "Close-up, eye level. Mara and the two men are locked together in the dim amber light, " +
      "their union tastefully implied as the camera lingers on their faces.";
    const codes = gateImagePrompt(coy, "end", ctx);
    expect(codes).toContain("anatomy_unnamed");

    const repaired = repairImagePrompt(coy, "end", codes, ctx);
    expect(repaired.match(/thrusts rhythmically into her vagina/g)).toHaveLength(1);
    expect(repaired.match(/guiding his cock into her mouth/g)).toHaveLength(1);
  });

  /** The story beat is the action reworded, so putting it back adds nothing. */
  it("drops a restatement the prompt already carries in other words", () => {
    const coy = "Close-up, eye level. The three of them move together in the dim amber light.";
    const repaired = repairImagePrompt(coy, "end", gateImagePrompt(coy, "end", ctx), ctx);
    expect(repaired).not.toContain("The first man thrusts into her while");
  });

  /** The warning the storyboard screen showed, asserted at its source. */
  it("leaves no repeated sentence for the prompt checker to flag", () => {
    const coy =
      "Close-up, eye level. Mara and the two men are locked together in the dim amber light, " +
      "their union tastefully implied as the camera lingers on their faces.";
    const repaired = repairImagePrompt(coy, "end", gateImagePrompt(coy, "end", ctx), ctx);
    const codes = lintRendered(repaired, "flux", "image", 0).map((finding) => finding.code);
    expect(codes).not.toContain("duplicate_sentence");
  });
});

/**
 * The undressing scene is the one place clothing in an explicit frame is
 * correct. Live: a start frame properly showing pyjamas and two clothed men
 * had "Every participant is completely naked" appended to it, so one prompt
 * asserted both.
 */
describe("the scene where the clothes are still coming off", () => {
  const card = scene({
    actionDescription:
      "The two men pull her pyjama top and shorts down past her hips until she is nude.",
    visualDescription: "The men strip Mara on the rumpled bedding.",
    storyBeat: "They undress her.",
  });
  const dressed =
    "Medium shot, eye level. Two men in dark navy trousers and charcoal t-shirts pull at the " +
    "fabric of Mara's cream silk pyjama shorts while she lies back on the rumpled bedding, " +
    "her breasts half covered and her pussy (vagina) not yet exposed, straddled by the nearer man.";

  const base = {
    scene: card,
    participants: ["Mara"],
    explicit: true,
    establishedWardrobe: { start: "", end: "" },
  };

  it("does not call the old outfit a contradiction", () => {
    const codes = gateImagePrompt(dressed, "start", { ...base, wardrobeChange: true });
    expect(codes).not.toContain("wardrobe_contradicts_act");
  });

  /** Any other scene, the same garments are the failure they always were. */
  it("still flags invented clothing on a scene with no costume change", () => {
    const codes = gateImagePrompt(dressed, "start", { ...base, wardrobeChange: false });
    expect(codes).toContain("wardrobe_contradicts_act");
  });

  /**
   * Undressing is not an act, and asking this frame to name genitals is a
   * demand the scene cannot meet. Live: this exact card was rejected for
   * `anatomy_unnamed` and `contact_unstated`, and the repair then pasted "The
   * two men grab her pajama top and shorts, pulling the fabric down…" into a
   * close-up — a three-step process in a single frame.
   */
  it("does not ask an undressing scene to name genital anatomy", () => {
    const shipped =
      "Close-up, eye level. Mara is entirely nude, lying on the rumpled white sheets; her " +
      "cream silk pyjama top and shorts are bunched at her ankles. Her bare breasts and pinkish " +
      "nipples are visible above her soft midsection. The hands of the two men grip her hips and " +
      "waist. She looks up with wide eyes, her mouth open. Sweat-slicked skin glistens under the " +
      "warm amber light.";
    const codes = gateImagePrompt(shipped, "end", { ...base, wardrobeChange: true });

    expect(codes).not.toContain("anatomy_unnamed");
    expect(codes).not.toContain("contact_unstated");
    expect(codes).not.toContain("position_unstated");
    expect(repairImagePrompt(shipped, "end", codes, base)).not.toContain("Shown at the last");
  });

  /** A card that does reach an act is still held to all three. */
  it("still asks for them once the scene reaches an act", () => {
    const act = scene({
      actionDescription: "He pushes his cock into her while she kneels on the bed.",
      visualDescription: "The two of them on the bed.",
      storyBeat: "They begin.",
    });
    const vague = "Close-up, eye level. Mara and the man are together on the rumpled bed.";
    expect(gateImagePrompt(vague, "end", { ...base, scene: act })).toContain("anatomy_unnamed");
  });
});

/**
 * Under `reuse_end_frame` a scene's start frame is the previous scene's end
 * frame: inherited, never rendered, and the agent is told to open the prompt at
 * what that picture already shows. Live, scene 5's start frame correctly
 * described scene 4's closing state and was flagged `action_dropped` for it,
 * which then pasted the card's action into it.
 */
describe("the start frame a scene inherits", () => {
  const card = scene({
    actionDescription:
      "Her eyelids snap open as she realises two men are looming over her from the shadows. " +
      "She gasps, her chest rising rapidly.",
    visualDescription: "She wakes to find them standing over the bed.",
    storyBeat: "She wakes.",
  });
  const base = {
    scene: card,
    participants: ["Mara"],
    explicit: true,
    establishedWardrobe: { start: "", end: "" },
  };

  /** Verbatim from the previous scene's end frame. */
  const carried =
    "Close-up, eye level. Mara lies nude on the rumpled white sheets, her pyjama top and " +
    "shorts bunched at her ankles, the hands of the two men gripping her hips and waist.";

  it("is not asked for an action it must not show", () => {
    expect(gateImagePrompt(carried, "start", { ...base, inheritsOpening: true })).not.toContain(
      "action_dropped",
    );
  });

  it("is still asked for it when the scene renders its own opening", () => {
    expect(gateImagePrompt(carried, "start", { ...base, inheritsOpening: false })).toContain(
      "action_dropped",
    );
  });

  /** The action still has to land somewhere, and the end frame is where. */
  it("holds the end frame to the action either way", () => {
    expect(gateImagePrompt(carried, "end", { ...base, inheritsOpening: true })).toContain(
      "action_dropped",
    );
  });
});

/**
 * A fault only the pair shows. Live: a start frame reading "Exactly two people
 * are in frame" against an end frame reading "Exactly three", on a card that
 * named two men throughout — and the end frame is what the next scene inherits.
 */
/**
 * A gain no clip will carry, and nothing else.
 *
 * The first version flagged any change in population, which rejected a scene
 * whose card reads "the two men walk across the floor as they approach the
 * bed" (one to three) and another reading "walk towards the door… the empty
 * room" (three to one). Both are scripted, and both were marked degraded.
 */
describe("the two frames disagreeing about who is there", () => {
  const one = "Medium shot, eye level. Exactly one person is in frame: Mara.";
  const two = "Medium shot, eye level. Exactly two people are in frame: Mara and a man.";
  const three =
    "Medium shot, eye level. Exactly three people are in frame: Mara, one man, and another man.";

  const keyframesOnly = { clipCarriesArrivals: false };
  const withClip = { clipCarriesArrivals: true };

  /** No clip exists to walk them in, so the end frame duplicates whoever is there. */
  it("catches a gain the clip cannot carry", () => {
    expect(gateFramePair(two, three, keyframesOnly)).toEqual(["headcount_mismatch"]);
  });

  /** The clip walks them in, which is what the render path already assumes. */
  it("allows an arrival when a clip will carry it", () => {
    expect(gateFramePair(one, three, withClip)).toEqual([]);
  });

  /** Nobody is duplicated by leaving, so a departure is never a fault. */
  it("allows a departure either way", () => {
    expect(gateFramePair(three, one, keyframesOnly)).toEqual([]);
    expect(gateFramePair(three, two, withClip)).toEqual([]);
  });

  it("passes a scene that keeps its population", () => {
    expect(gateFramePair(three, three, keyframesOnly)).toEqual([]);
  });

  /** Not every prompt states a count, and an unstated one claims nothing. */
  it("says nothing when either frame omits the count", () => {
    expect(gateFramePair("Medium shot of a woman at a window.", three, keyframesOnly)).toEqual([]);
    expect(gateFramePair(two, "Close-up of her hands.", keyframesOnly)).toEqual([]);
  });
});

/**
 * A third of the card's content words cannot tell a paraphrase from a drop.
 * Live, it rejected "pulling the blankets away to reveal her skin" against a
 * card reading "whip the blankets away, exposing her skin".
 */
describe("a prompt that says the same thing in other words", () => {
  const card = scene({
    actionDescription:
      "With a sudden, forceful movement, they whip the blankets away from Mara, exposing her " +
      "skin to the cool air of the room.",
    visualDescription: "The bed, the blankets, the two men.",
    storyBeat: "They uncover her.",
  });
  const ctx = {
    scene: card,
    participants: ["Mara"],
    explicit: true,
    establishedWardrobe: { start: "", end: "" },
  };
  const faithful =
    "Medium shot, low angle. Two men are pulling the thick cream blankets away from Mara; the " +
    "fabric billows mid-air as it is pulled back to reveal her skin and her silk pyjama shorts.";

  /** It may still flag, but it must not edit. */
  it("is never repaired by pasting the card over it", () => {
    expect(repairImagePrompt(faithful, "end", ["action_dropped"], ctx)).toBe(faithful);
  });

  /** A genuinely missing part is still put back, so the repair is not disabled. */
  it("still names anatomy the prompt never named", () => {
    const act = scene({
      actionDescription: "He pushes his cock into her pussy while she kneels.",
      visualDescription: "The two of them.",
      storyBeat: "They begin.",
    });
    const vague = "Close-up, eye level. Mara and the man are together on the rumpled bed.";
    const repaired = repairImagePrompt(vague, "end", ["anatomy_unnamed"], { ...ctx, scene: act });
    expect(repaired).toContain("cock");
  });
});

describe("what actually comes out of the image agent", () => {
  it("gives a coy model one retry, telling it what was rejected", async () => {
    const { imageCalls, provider } = imageProvider(() => COY);
    await attachScenePrompts(project(), [scene()], provider, { cast: [MARA] });

    expect(imageCalls()).toHaveLength(2);
    const retry = imageCalls()[1]!.system;
    expect(retry).toContain("Your previous answer was rejected");
    expect(retry).toContain(ACTION);
  });

  it("takes the answer and stops when the first one is faithful", async () => {
    const { imageCalls, provider } = imageProvider(() => CONCRETE);
    const executions: ArtifactExecution[] = [];
    await attachScenePrompts(project(), [scene()], provider, {
      cast: [MARA],
      onExecution: (e) => executions.push(e),
    });

    expect(imageCalls()).toHaveLength(1);
    const image = executions.find((e) => e.artifact === "scene-1.image_prompt")!;
    expect(image.source).toBe("llm");
    expect(image.status).toBe("ok");
  });

  /** The failure that had no evidence in it: shipping the coy version quietly. */
  it("puts the scene's own words back when the model stays coy, and says it did", async () => {
    const { provider } = imageProvider(() => COY);
    const executions: ArtifactExecution[] = [];
    const scenes = await attachScenePrompts(project(), [scene()], provider, {
      cast: [MARA],
      onExecution: (e) => executions.push(e),
    });

    for (const prompt of [scenes[0]!.prompts.startFramePrompt, scenes[0]!.prompts.endFramePrompt]) {
      expect(prompt).toContain("straddles Mark");
      expect(prompt).toContain("penis");
    }
    expect(scenes[0]!.prompts.startFramePrompt).toContain("first instant");
    expect(scenes[0]!.prompts.endFramePrompt).toContain("last instant");

    const image = executions.find((e) => e.artifact === "scene-1.image_prompt")!;
    expect(image.source).toBe("hybrid");
    expect(image.status).toBe("degraded");
    expect(image.detail).toContain("euphemism");
  });

  /**
   * Clothing on a participant is appended last and outranks the act. It cannot
   * be argued away in the positive prompt, where naming it embeds it.
   */
  it("sends a garment it never established to the negative prompt", async () => {
    const dressed = () =>
      "Medium shot, eye level. A man in black silk trousers performs oral sex on Mara, his " +
      "mouth against her soft skin, as she lies back and grasps his hair with her nails.";
    const { provider } = imageProvider(dressed);
    const scenes = await attachScenePrompts(project(), [scene()], provider, { cast: [MARA] });

    expect(scenes[0]!.prompts.imageNegativePrompt).toContain("trousers");
    expect(scenes[0]!.prompts.startFramePrompt).toContain("completely naked");
  });

  /**
   * A provider failure used to hand the render a template nobody had checked.
   * The template cannot author an explicit prompt, but it must not lose the
   * concrete words it was given.
   */
  it("keeps the action in both frames when there is no provider at all", async () => {
    const scenes = await attachScenePrompts(project(), [scene()], null, { cast: [MARA] });
    const { startFramePrompt, endFramePrompt } = scenes[0]!.prompts;

    expect(startFramePrompt).toContain("straddles Mark");
    expect(endFramePrompt).toContain("straddles Mark");
    expect(startFramePrompt).toContain("the act itself in frame");

    const ctx = {
      scene: scene(),
      participants: ["Mara"],
      explicit: true,
      establishedWardrobe: { start: MARA.wardrobe!, end: MARA.wardrobe! },
    };
    expect(gateImagePrompt(startFramePrompt, "start", ctx)).toEqual([]);
    expect(gateImagePrompt(endFramePrompt, "end", ctx)).toEqual([]);
  });
});

/**
 * The Story Architect writes the beats the storyboard elaborates, and was the
 * one planning agent never told the piece was explicit.
 */
describe("what the Story Architect is told", () => {
  it("gets the planning directive on explicit work", async () => {
    const { calls, provider } = imageProvider(() => COY);
    await storyArchitectAgent({ project: project() }, provider);
    expect(calls[0]!.system).toMatch(/must describe the act/);
  });

  it("gets nothing extra on work that is not explicit", async () => {
    const { calls, provider } = imageProvider(() => COY);
    const tame = project({ audience: "families", tone: "inspirational", style: "cinematic" });
    await storyArchitectAgent({ project: tame }, provider);
    expect(calls[0]!.system).not.toMatch(/must describe the act/);
  });
});
