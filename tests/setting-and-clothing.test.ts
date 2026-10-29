import { describe, expect, it } from "vitest";
import { projectSetting, settingSuffix } from "@/lib/agents/setting-anchor";
import { gateImagePrompt, statedClothing } from "@/lib/agents/prompt-gate";
import { explicitnessDirective } from "@/lib/agents/explicitness";
import { VISUAL_BIBLE_SYSTEM, visualBibleAgent } from "@/lib/agents/visual-bible-agent";
import { plainClothing } from "@/lib/agents/clothing-wording";
import type { AgentContext } from "@/lib/agents/types";
import { attachScenePrompts } from "@/lib/agents/prompt-agents";
import {
  buildCreativeBrief,
  buildSceneDrafts,
  buildStoryPlan,
  buildVisualBible,
} from "@/lib/agents/mock-agents";
import { createProject } from "@/lib/services/project-service";
import type { CreativePlans } from "@/lib/agents/creative-context";
import type { PlanningProvider } from "@/lib/agents/llm/provider";
import type { Project } from "@/lib/schemas/project";

/**
 * A strip club rendered as a trailer park, and patrons rendered without shirts.
 *
 * Frames written to be concise dropped where the scene was, and the explicit
 * directive told the model everyone who touches the dancer is naked.
 */

const CLUB =
  "The setting is an upscale strip club interior with dim lighting dominated by soft purple " +
  "and pink neon hues.";
const plans = (rules: string[]) =>
  ({ worldBible: { universeRules: rules, locations: [{ name: "Main Stage", description: "A stage." }] } }) as unknown as CreativePlans;

describe("the project's setting", () => {
  it("is read from the world bible's own statement, as a short clause", () => {
    expect(projectSetting(plans(["Patrons sit at tables.", CLUB]))).toBe(
      "Setting: an upscale strip club interior with dim lighting dominated by soft purple and pink neon hues.",
    );
  });

  it("is not guessed from a location when the bible states no setting", () => {
    expect(projectSetting(plans(["Patrons sit at tables."]))).toBeUndefined();
    expect(projectSetting(undefined)).toBeUndefined();
    expect(projectSetting(plans([]))).toBeUndefined();
  });

  it("is limited in length", () => {
    const long = `The setting is ${Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ")}.`;
    expect(projectSetting(plans([long]))!.split(/\s+/).length).toBeLessThanOrEqual(27);
  });

  it("reads naturally from a 'takes place' statement", () => {
    expect(projectSetting(plans(["The story takes place in one city apartment."]))).toBe(
      "Setting: one city apartment.",
    );
  });

  it("keeps only the place, dropping framing adverbs and negations", () => {
    expect(
      projectSetting(plans(["The scene takes place entirely within a single small hotel guest room."])),
    ).toBe("Setting: a single small hotel guest room.");
    expect(
      projectSetting(plans(["The setting is strictly a single, enclosed private room; no windows or exits are visible."])),
    ).toBe("Setting: a single, enclosed private room.");
    expect(
      projectSetting(plans(["Set in a bedroom with no fantasy or sci-fi elements."])),
    ).toBe("Setting: a bedroom.");
  });

  it("is left out when the statement itself walks through several places", () => {
    expect(
      projectSetting(plans(["The story takes place in one continuous sequence: exterior night field, then interior bay."])),
    ).toBeUndefined();
    expect(
      projectSetting(plans(["The setting is an urban bar transitioning to its back hallway and bathroom."])),
    ).toBeUndefined();
  });

  /**
   * A story that moves between unrelated places has no one setting, and stating
   * one in every frame would put the kitchen on the cliff road.
   */
  it("is left out when the bible's places do not belong to it", () => {
    const town = {
      worldBible: {
        universeRules: ["The setting is a small coastal town in winter."],
        locations: [
          { name: "Harbor", description: "A cold harbor with fishing boats and gulls." },
          { name: "Kitchen", description: "A cramped kitchen with a stove and a radio." },
          { name: "Cliff Road", description: "A winding road above the sea, lined with fence posts." },
        ],
      },
    } as unknown as CreativePlans;
    expect(projectSetting(town)).toBeUndefined();
  });

  it("is kept when every place hangs together with it, directly or through another place", () => {
    const club = {
      worldBible: {
        universeRules: [CLUB],
        locations: [
          { name: "Main Stage", description: "A circular platform lit in purple and pink neon." },
          { name: "Front Row Seating", description: "Bar-height tables beside the edge of the stage." },
          { name: "Club Perimeter", description: "A dim area of blurred patrons around the club." },
        ],
      },
    } as unknown as CreativePlans;
    expect(projectSetting(club)).toMatch(/^Setting: an upscale strip club interior/);
  });
});

describe("adding the setting to a frame", () => {
  const setting = projectSetting(plans([CLUB]));

  it("adds it to a frame that never says where it is", () => {
    const frame = "Medium close-up. A muscular man stands behind a blonde woman, his hands on her hips.";
    expect(settingSuffix(frame, setting)).toBe(` ${setting}`);
  });

  it("leaves a frame that already names the venue alone", () => {
    const frame =
      "Medium wide shot. A woman at the pole of a dim strip club, purple neon on the chrome stage.";
    expect(settingSuffix(frame, setting)).toBe("");
  });

  it("adds nothing when there is no setting", () => {
    expect(settingSuffix("Any frame at all.", undefined)).toBe("");
  });
});

describe("prompts written with the setting known", () => {
  async function run(rules: string[], answer: string) {
    const project: Project = {
      ...(await createProject({ concept: "A dancer works a club.", requestedDurationSeconds: 40 })),
      imageModel: "krea2_turbo",
      sceneContinuity: "cut",
      style: "",
      tone: "",
    };
    const [draft] = buildSceneDrafts(
      project, buildStoryPlan(project), buildCreativeBrief(project), buildVisualBible(project),
    );
    const provider: PlanningProvider = {
      name: "setting-test",
      async generateJson(system, _user, schema) {
        return system.includes("Image Prompt Agent")
          ? schema.parse({ startFramePrompt: answer, endFramePrompt: answer, imageNegativePrompt: "blur" })
          : schema.parse({ videoPromptSegment: "She dances.", videoNegativePrompt: "flicker", promptQualityChecklist: [] });
      },
    };
    const [scene] = await attachScenePrompts(project, [{ ...draft!, charactersPresent: [] }], provider, {
      plans: plans(rules),
    });
    return { scene: scene!, draft: draft! };
  }

  it("carries the venue into frames written without it", async () => {
    const { draft } = await run([CLUB], "placeholder");
    const frame = `Medium close-up, eye level. ${draft.actionDescription.trim().replace(/\.?$/, ".")} A man stands close behind her.`;
    const { scene } = await run([CLUB], frame);
    expect(scene.prompts.startFramePrompt).toContain("Setting: an upscale strip club interior");
    expect(scene.prompts.endFramePrompt).toContain("Setting: an upscale strip club interior");
    expect(scene.prompts.startFramePrompt.match(/Setting:/g)).toHaveLength(1);
  });

  it("says nothing extra when the bible states no setting", async () => {
    const { draft } = await run(["Patrons sit at tables."], "placeholder");
    const frame = `Medium close-up, eye level. ${draft.actionDescription.trim().replace(/\.?$/, ".")}`;
    const { scene } = await run(["Patrons sit at tables."], frame);
    expect(scene.prompts.startFramePrompt).not.toContain("Setting:");
  });
});

describe("who the explicit directive undresses", () => {
  const project = { audience: "adults only", tone: "erotic", concept: "x", style: "" } as unknown as Project;
  const image = explicitnessDirective(project, "image");
  const video = explicitnessDirective(project, "video");

  it("still undresses everyone in a sex act", () => {
    expect(image).toMatch(/Everyone taking part in the act is naked/);
    expect(image).toMatch(/penetration, oral contact or hands on genitals/);
  });

  it("lets a patron who touches or tips a dancer keep the clothes the card gives him", () => {
    expect(image).toMatch(/Touching, fondling, tipping or dancing near someone is not the act/);
    expect(image).toMatch(/or whose clothing the scene card or the visual bible states/);
    expect(video).toMatch(/touching, fondling and tipping are not the act/);
  });

  it("asks for complete garments and rules out the wording drawn as no shirt", () => {
    expect(image).toMatch(/garment, colour and fastening/);
    expect(image).toMatch(/never "an open shirt"/);
  });
});

describe("clothing the card gives somebody", () => {
  const scene = (action: string) =>
    ({
      visualDescription: "A club stage.",
      actionDescription: action,
      continuityNotes: [],
    }) as unknown as Parameters<typeof statedClothing>[0];

  it("reads what the card says people wear", () => {
    expect(
      statedClothing(scene("A patron wearing a dark button-down shirt and jeans reaches up.")),
    ).toContain("dark button-down shirt and jeans");
  });

  it("keeps a patron dressed while the dancer is bare, where the bible gave him no garments", () => {
    const card = {
      ...scene("TLBr3f is fully naked. A large man wearing a dark button-down shirt cups her breasts."),
      storyBeat: "The first touch.",
    } as unknown as Parameters<typeof gateImagePrompt>[2]["scene"];
    const prompt =
      "Medium close-up, eye level. TLBr3f stands fully naked beside a large man wearing a dark " +
      "button-down shirt who cups her breasts; the club glows purple behind them, and she holds his gaze.";
    const bare = { scene: card, participants: ["TLBr3f"], explicit: true, establishedWardrobe: { start: "nude", end: "nude" } };
    expect(gateImagePrompt(prompt, "start", bare)).toContain("wardrobe_contradicts_act");
    const withCard = {
      ...bare,
      establishedWardrobe: {
        start: `nude ${statedClothing(card)}`,
        end: `nude ${statedClothing(card)}`,
      },
    };
    expect(gateImagePrompt(prompt, "start", withCard)).not.toContain("wardrobe_contradicts_act");
  });

  it("still takes back a garment the card never gave anyone", () => {
    const card = {
      ...scene("TLBr3f is fully naked. A large man cups her breasts."),
      storyBeat: "The first touch.",
    } as unknown as Parameters<typeof gateImagePrompt>[2]["scene"];
    const prompt =
      "Medium close-up, eye level. TLBr3f stands fully naked beside a large man wearing black " +
      "silk trousers who cups her breasts; the club glows purple behind them, and she holds his gaze.";
    const ctx = {
      scene: card, participants: ["TLBr3f"], explicit: true,
      establishedWardrobe: { start: `nude ${statedClothing(card)}`, end: `nude ${statedClothing(card)}` },
    };
    expect(gateImagePrompt(prompt, "start", ctx)).toContain("wardrobe_contradicts_act");
  });
});

describe("the visual bible's clothing for people who are not in the cast", () => {
  it("rewords clothing an image model draws as none", () => {
    expect(
      plainClothing(
        "muscular Asian man wearing an open shirt that reveals his biceps and allows access to " +
          "pockets for cash, seated beside the large black man",
      ),
    ).toBe("muscular Asian man wearing a buttoned shirt, seated beside the large black man");
    expect(plainClothing("a man in a dark button-down shirt over a bare chest")).toBe(
      "a man in a dark button-down shirt",
    );
    expect(plainClothing("a bartender in an unbuttoned shirt, revealing his chest, polishing a glass")).toBe(
      "a bartender in a buttoned shirt, polishing a glass",
    );
  });

  it("leaves ordinary clothing, deliberate nudity and described anatomy alone", () => {
    for (const text of [
      "a man in an open jacket and a grey tee",
      "a man in an open-collared linen shirt",
      "a shirtless boxer taping his hands",
      "Black man in sweatpants initially; he removes them, revealing his large cock clearly visible against his skin.",
      "a man in a loose shirt and slacks, socks pulled down to his ankles revealing bare feet",
    ]) {
      expect(plainClothing(text)).toBe(text);
    }
  });

  it("is applied to everyone but the pinned cast", async () => {
    const bible = {
      projectId: "p", artDirection: "a", colorPalette: ["c"], lightingRules: ["l"], cameraStyle: "s",
      locations: [], props: [], negativeRules: [],
      characters: [
        { name: "Mara", description: "pinned, wearing an open shirt that reveals her collarbone" },
        { name: "Patron", description: "a man wearing an open shirt that reveals his biceps" },
      ],
    };
    const provider = {
      name: "bible-test",
      async generateJson() { return bible; },
    } as unknown as PlanningProvider;
    const result = await visualBibleAgent(
      {
        project: { id: "p" } as Project,
        cast: [{ id: "c", name: "Mara", description: "library description", wardrobe: "" }],
      } as unknown as AgentContext,
      provider,
    );
    const by = Object.fromEntries(result.characters.map((c) => [c.name, c.description]));
    expect(by.Patron).toBe("a man wearing a buttoned shirt");
    expect(by.Mara).toBe("library description");
  });

  it("is asked to be complete and specific", () => {
    expect(VISUAL_BIBLE_SYSTEM).toMatch(/complete, specific garments with colours and fastenings/);
    expect(VISUAL_BIBLE_SYSTEM).toMatch(/never describe clothing as open, unbuttoned, revealing/);
  });
});
