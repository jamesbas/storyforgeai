import { describe, it, expect, vi } from "vitest";
import { MockWangpClient } from "@/lib/wangp/mock-client";
import { familyOf } from "@/lib/wangp/family";
import { clipLengthGuidance } from "@/lib/wangp/clip-length";
import { buildSettingsManifest } from "@/lib/wangp/settings";
import { ref2vaAcceleratedMinutes, ref2vaEstimateMinutes } from "@/lib/wangp/render-estimate";
import { inheritedOpeningDirective, videoPromptDirective } from "@/lib/agents/model-directives";
import { echoesInstructions } from "@/lib/agents/media-prompt-normalise";
import {
  countWords,
  h3ReferenceTaskType,
  isH3ReferencePrompt,
  renderH3ReferencePrompt,
  stripH3ReferencePrompt,
  summariseFrame,
  unvoicedSubjects,
  usesH3ReferenceFormat,
  visibleFrameContent,
  voiceProblems,
  NO_OTHER_SPEECH,
  SPEECH_LIMIT,
  DIALOGUE_COMPLETE,
  type H3ReferenceSubject,
} from "@/lib/agents/h3-reference-prompt";
import { markDialogue, markSceneDialogue } from "@/lib/agents/h3-prompt";
import type { WangpModel, WangpModelSchema } from "@/lib/schemas/wangp";

/**
 * MiniMax H3 reference mode.
 *
 * Ref2VA supplies its keyframes as references rather than positionally, so the
 * two things worth proving are that the manifest never sends a field this
 * checkpoint does not declare, and that the prose numbers the references in the
 * order WanGP will emit them. Everything downstream of a wrong number still
 * renders — it just renders the wrong picture as the wrong thing.
 */

const MARA = { name: "Mara", description: "Late thirties, dark curls.", pictureIndex: 3 };
const H3_OMNI_MODEL_TYPES = ["minimax_h3_fasth3_omni", "minimax_h3_fasth3_omni_nvfp4"];

describe("the directive the prompt agents are given", () => {
  const reference = videoPromptDirective("minimax_ref2va", {
    segmentSeconds: 14,
    nativeAudio: true,
  });
  const keyframe = videoPromptDirective("minimax", { segmentSeconds: 15, nativeAudio: true });

  it("does not tell reference mode its frames are pinned", () => {
    // Ref2VA declares no image_start or image_end at all, so describing the
    // frames as pinned would have the agent write for conditioning that never
    // arrives — and leave the endpoints unstated, fixed by nothing.
    expect(keyframe).toContain("first-and-last-frame mode");
    expect(reference).not.toContain("first-and-last-frame mode");
    expect(reference).toContain("reference mode");
  });

  it("tells reference mode not to re-describe an opening it is handed", () => {
    // The renderer names both frames itself. A body that also describes the
    // opening in its own words competes with the picture, and the words win.
    expect(keyframe).toContain("Describe that path, not the endpoints");
    expect(reference).toContain("do not re-describe the opening composition");
    expect(reference).toContain("the first thing that changes");
  });

  it("asks for characters to be named and described, since that binds the photograph", () => {
    expect(reference).toContain("Name each character");
  });

  it("keeps everything the two variants genuinely share", () => {
    for (const directive of [reference, keyframe]) {
      expect(directive).toContain("one continuous shot with no cuts");
      expect(directive).toContain("no negative prompt");
      expect(directive).toContain("no minimum length");
      expect(directive).toContain("videoSoundscape");
    }
  });

  it("asks for the shape without handing over a name for it", () => {
    // Given the phrase, a model writes "the robot performs its dominant
    // action:" and the video model renders that sentence as description.
    for (const directive of [reference, keyframe]) {
      expect(directive).not.toMatch(/dominant action|secondary movement/i);
      expect(directive).toContain("one thing that happens");
    }
  });
});

describe("catching an instruction a model narrated anyway", () => {
  it("flags the phrasings that mean the brief leaked into the prose", () => {
    expect(echoesInstructions("The Robot performs its dominant action: it tilts its head.")).toEqual(
      ["dominant action"],
    );
    expect(echoesInstructions("As a secondary movement, it reaches down.")).toEqual([
      "secondary movement",
    ]);
    expect(echoesInstructions("The prompt should convey warmth.")).toHaveLength(1);
  });

  it("leaves ordinary prose alone", () => {
    expect(echoesInstructions("She tilts her head and reaches for the brush.")).toEqual([]);
    // "action" and "movement" are perfectly good words on their own.
    expect(echoesInstructions("The action moves left as the crowd movement slows.")).toEqual([]);
  });
});

describe("a scene that opens on the previous scene's final frame", () => {
  // Under reuse_end_frame the start frame is not rendered from this scene's
  // start-frame prompt, so an agent left to write an opening describes a shot
  // that was never supplied — and the prose is what gets rendered.
  it("tells the agent not to write an opening, and what the frame holds", () => {
    const directive = inheritedOpeningDirective("Close-up of a woman at a rain-streaked window.");
    expect(directive).toContain("does not open on its own start-frame prompt");
    expect(directive).toContain("Close-up of a woman at a rain-streaked window.");
    expect(directive).toContain("Do not describe the opening");
  });

  it("says nothing when there is no previous frame to describe", () => {
    expect(inheritedOpeningDirective(undefined)).toBe("");
    expect(inheritedOpeningDirective("   ")).toBe("");
  });
});

describe("family split", () => {
  it("separates the two H3 variants", () => {
    expect(familyOf("minimax_h3_ref2va")).toBe("minimax_ref2va");
    expect(familyOf("minimax_h3_fl2va_pruned")).toBe("minimax");
  });

  it.each(H3_OMNI_MODEL_TYPES)("treats %s as reference mode", (modelType) => {
    expect(familyOf(modelType)).toBe("minimax_ref2va");
    expect(familyOf(modelType, "minimax_h3")).toBe("minimax_ref2va");
    expect(familyOf(modelType.toUpperCase())).toBe("minimax_ref2va");
    expect(usesH3ReferenceFormat(familyOf(modelType))).toBe(true);
  });

  it("anchors the variant token to the H3 lineage", () => {
    expect(familyOf("some_ref2va_thing")).toBe("unknown");
    expect(familyOf("something_else", "minimax_h3_ref2va")).toBe("minimax_ref2va");
    expect(familyOf("some_omni_thing")).toBe("unknown");
    expect(familyOf("wan_omni")).toBe("wan");
    expect(familyOf("something_else", "MiniMax_H3_FastH3_Omni")).toBe("minimax_ref2va");
  });

  it("treats both variants' window sizes as stitch points rather than hard caps", () => {
    expect(clipLengthGuidance("minimax_ref2va")?.maxFrames).toBeUndefined();
    expect(clipLengthGuidance("minimax")?.maxFrames).toBeUndefined();
  });

  it("routes the format to the reference variant alone", () => {
    expect(usesH3ReferenceFormat("minimax_ref2va")).toBe(true);
    expect(usesH3ReferenceFormat("minimax")).toBe(false);
  });
});

describe("LoRAs on the reference variant", () => {
  const schema: WangpModelSchema = {
    modelType: "minimax_h3_ref2va",
    defaultSettings: { prompt: "", image_prompt_type: "", multi_prompts_gen_type: "PG" },
    fields: [{ name: "prompt", type: "string" }],
  } as unknown as WangpModelSchema;

  const build = (loras: { name: string; strength: number }[]) =>
    buildSettingsManifest(schema, {
      sceneId: "s1",
      purpose: "video_segment",
      prompt: "x",
      loras,
      // WanGP publishes `capabilities.lora` for this checkpoint even though its
      // schema omits the fields, and that flag is now what decides.
      loraCapable: true,
    });

  it("writes the standard LoRA settings omitted from its schema", () => {
    const manifest = build([{ name: "minimax_h3_turbo_4step", strength: 0.75 }]);
    expect(manifest.settings.activated_loras).toEqual(["minimax_h3_turbo_4step"]);
    expect(manifest.settings.loras_multipliers).toBe("0.75");
  });

  it("stays silent when nothing is selected", () => {
    expect(() => build([])).not.toThrow();
  });
});

describe("the six-section prompt", () => {
  const rendered = renderH3ReferencePrompt({
    body: 'Mara turns from the window and says, "We should go."',
    style: "Warm naturalistic interior, shallow depth of field.",
    summary: "A woman turns from a window and speaks.",
    subjects: [MARA],
    hasStart: true,
    hasEnd: true,
    soundscape: "Rain on glass, a chair creaking.",
    score: "Low strings, slow.",
  });

  it("emits the sections in the guide's order", () => {
    const order = [
      "subject_definitions:",
      "summary:",
      "retention_analysis:",
      "detailed_description:",
      "overall_soundscape:",
      "non_diegetic_music:",
    ];
    const positions = order.map((section) => rendered.indexOf(section));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  /**
   * The guide breaks after the four prose labels and keeps the two audio fields
   * on the label line. No blank line anywhere: Wan2GP reads one as a
   * sliding-window separator and would split the scene into two generations.
   */
  it("lays the sections out the way the guide writes them", () => {
    expect(rendered).toContain("subject_definitions:\n");
    expect(rendered).toContain("summary:\n");
    expect(rendered).toContain("retention_analysis:\n");
    expect(rendered).toContain("detailed_description:\n");
    expect(rendered).toContain("overall_soundscape: Rain on glass");
    expect(rendered).toContain("non_diegetic_music: Low strings, slow.");
    expect(rendered).not.toContain("\n\n");
  });

  it("anchors both ends in the description itself, not only the bookkeeping", () => {
    // A build that named the anchors only in subject_definitions and
    // retention_analysis reached its closing frame correctly and opened on
    // something invented.
    const description = rendered.slice(rendered.indexOf("detailed_description:"));
    expect(description).toContain("begins from <Picture 1>");
    expect(description).toContain("established by <Picture 2>");
  });

  it("says which picture the shot starts and ends on in the summary", () => {
    const summary = rendered.slice(rendered.indexOf("summary:"), rendered.indexOf("retention"));
    expect(summary).toContain("begins from <Picture 1> and ends on <Picture 2>");
  });

  it("says when each anchor applies, not merely that it is preserved", () => {
    expect(rendered).toContain("at the start of the shot");
    expect(rendered).toContain("at the end of the shot");
  });

  it("names the task type both halves of the job", () => {
    expect(rendered).toContain("[keyframe completion + reference generation]");
    expect(h3ReferenceTaskType(true, false)).toBe("[keyframe completion]");
    expect(h3ReferenceTaskType(false, true)).toBe("[reference generation]");
  });

  it("gives anchors their own entry and cites a character's photo inside its subject", () => {
    expect(rendered).toContain("<Picture 1> is the first frame");
    expect(rendered).toContain("<Picture 2> is the last frame");
    // The character's photograph is picture 3, but must not get a standalone
    // entry of its own — that would offer the photo's setting as composition.
    expect(rendered).toContain("<Subject 1> is Mara");
    expect(rendered).toContain("<Picture 3>");
    expect(rendered).not.toMatch(/<Picture 3> is the (first|last) frame/);
  });

  it("uses photographs for identity, not to overwrite anchored wardrobe or pose", () => {
    const prompt = renderH3ReferencePrompt({
      body: "Mara lifts a cup.",
      subjects: [{ ...MARA, description: "Mara wears a red evening gown and stands upright." }],
      hasStart: true,
      hasEnd: true,
      startFrameDescription: "Mara sits beside a table in grey coveralls.",
      endFrameDescription: "Mara sits beside a table in grey coveralls, holding a cup.",
    });
    expect(prompt).not.toContain("red evening gown");
    expect(prompt).not.toContain("stands upright");
    expect(prompt).toContain("defines their facial identity");
    expect(prompt).toContain("Pose and clothing follow the frame anchors");
    expect(prompt).toContain("grey coveralls");
  });

  it("states retention per label", () => {
    expect(rendered).toContain("fully_preserved");
    expect(rendered).toContain("attribute_transfer");
  });

  /** The guide separates a retention marker from its reason with a hyphen. */
  it("separates each retention marker from its reason the way the guide does", () => {
    const analysis = rendered.slice(
      rendered.indexOf("retention_analysis:"),
      rendered.indexOf("detailed_description:"),
    );
    expect(analysis).toContain("fully_preserved - ");
    expect(analysis).toContain("attribute_transfer - ");
    expect(analysis).not.toContain("—");
  });

  /** `detailed_description` states what the whole video is before [Shot 1]. */
  it("opens the description with the target-video statement", () => {
    const description = rendered.slice(rendered.indexOf("detailed_description:"));
    expect(description).toContain("The target video is a single continuous shot");
    expect(description.indexOf("The target video is")).toBeLessThan(
      description.indexOf("[Shot 1]"),
    );
  });

  it("puts the style sentences before the shot marker", () => {
    const description = rendered.slice(rendered.indexOf("detailed_description:"));
    expect(description.indexOf("Warm naturalistic")).toBeLessThan(description.indexOf("[Shot 1]"));
  });

  it("marks spoken lines so they are performed rather than described", () => {
    expect(rendered).toContain("<d>[English] We should go.</d>");
  });

  it("writes N/A for an absent audio layer", () => {
    const silent = renderH3ReferencePrompt({
      body: "A held shot of an empty road.",
      subjects: [],
      hasStart: true,
      hasEnd: true,
    });
    expect(silent).toContain("overall_soundscape: N/A");
    expect(silent).toContain("non_diegetic_music: N/A");
  });

  it("says what each anchor picture shows, not only that it is an anchor", () => {
    // A label alone tells the model a picture is the opening frame but nothing
    // about what matching it would look like.
    const described = renderH3ReferencePrompt({
      body: "She turns from the window.",
      subjects: [],
      hasStart: true,
      hasEnd: true,
      startFrameDescription: "Wide shot, eye level, a woman stands at a rain-streaked window.",
      endFrameDescription: "Close-up of her eyes as she turns away.",
    });
    expect(described).toContain("showing a woman stands at a rain-streaked window.");
    expect(described).toContain("showing close-up of her eyes as she turns away.");
    // Repeated in the description, where the opening is actually built from.
    const body = described.slice(described.indexOf("detailed_description:"));
    expect(body).toContain("A woman stands at a rain-streaked window");
    expect(body).toContain("Nothing happens before the first change");
  });

  it("holds the subject's pose, not just the framing", () => {
    // A keyframe already showing a tilted head was described as opening with
    // the subject still, and the prose won.
    expect(rendered).toContain("the subject's exact pose in that frame");
  });

  it("keeps the anchor line clean when no description is available", () => {
    const bare = renderH3ReferencePrompt({
      body: "She turns from the window.",
      subjects: [],
      hasStart: true,
      hasEnd: true,
    });
    expect(bare).toContain("<Picture 1> is the first frame of [Shot 1].");
  });

  it("trims a keyframe prompt to a clause rather than restating the scene", () => {
    // Not the first sentence: a keyframe prompt must open with shot size and
    // camera height, so its first sentence names a lens and nothing else.
    expect(summariseFrame("Medium close-up, eye level, 35mm lens. Mike sits at the table.")).toBe(
      "Medium close-up, eye level, 35mm lens. Mike sits at the table",
    );
    expect(summariseFrame(undefined)).toBe("");
    expect(summariseFrame("a b c d e", 3)).toBe("a b c");
  });

  it("recovers plain prose when the format has to be taken back off", () => {
    const plain = stripH3ReferencePrompt(rendered);
    expect(isH3ReferencePrompt(plain)).toBe(false);
    // The anchoring sentences name pictures a non-reference model is not sent,
    // so they go rather than travel as instructions about nothing.
    expect(plain).not.toContain("<Picture 1>");
    expect(plain).not.toContain("[Shot 1]");
    expect(plain).toContain('"We should go."');
    // The audio layers are direction, so they survive the fallback.
    expect(plain).toContain("Rain on glass");
  });

  it("counts words without imposing a minimum length", () => {
    expect(countWords("one two three")).toBe(3);
    expect(countWords("   ")).toBe(0);
  });
});

/**
 * What an anchor picture is said to show.
 *
 * Taken from a live clip whose first thirteen seconds were the keyframe
 * prompt's style, audience and camera wording read aloud in the character's
 * voice, before her one line.
 */
describe("describing an anchor picture to H3", () => {
  const START =
    "Medium close-up, eye level with a slight downward tilt from behind and to the left of TLBr3f, " +
    "fifty millimeter lens. erotic art film style, raw and carnal mood. Intended audience: adults " +
    "only, explicit content. Center-frame she stands on weathered coastal hardwood decking, her bare " +
    "back three-quarters turned toward camera. Exactly two people are in frame: one woman standing " +
    "center-frame and one man face-down left background.";
  const END =
    "Medium wide shot, high angle, fifty millimeter lens, from behind and to the right of TLBr3f on " +
    "weathered coastal hardwood decking. erotic art film style, raw and carnal mood. She walks briskly " +
    "away from camera toward a white condo door. Exactly one person is in frame: a woman walking " +
    "center-frame to the door. Wardrobe continuity — TLBr3f is completely naked with no clothing.";

  it("keeps what the picture contains and drops what was written for the image model", () => {
    expect(visibleFrameContent(START)).toBe(
      "Center-frame she stands on weathered coastal hardwood decking, her bare back three-quarters " +
        "turned toward camera.",
    );
    expect(visibleFrameContent(END)).toBe("She walks briskly away from camera toward a white condo door.");
  });

  it("keeps the contents of an opening that also places the camera", () => {
    expect(visibleFrameContent("Full shot, eye level, 50mm: Mara walks along the surf line.")).toBe(
      "Mara walks along the surf line.",
    );
    expect(visibleFrameContent("Wide shot, eye level, a woman stands at a window.")).toBe(
      "A woman stands at a window.",
    );
    expect(visibleFrameContent("Medium shot of Mara at a rain-streaked window.")).toBe(
      "Medium shot of Mara at a rain-streaked window.",
    );
  });

  it("leaves a sentence that only sounds like the look alone", () => {
    expect(visibleFrameContent("Mara laughs. She is in a playful mood.")).toBe(
      "Mara laughs. She is in a playful mood.",
    );
  });

  it("puts none of the image model's directions into the prompt", () => {
    const prompt = renderH3ReferencePrompt({
      body: 'TLBr3f says, "Come on."',
      subjects: [{ name: "TLBr3f", pictureIndex: 3, audioIndex: 1 }],
      hasStart: true,
      hasEnd: true,
      startFrameDescription: START,
      endFrameDescription: END,
      dialogue: [{ character: "TLBr3f", line: "Come on." }],
    });
    for (const leaked of ["Intended audience", "carnal mood", "millimeter", "Exactly two people", "Wardrobe continuity"]) {
      expect(prompt).not.toContain(leaked);
    }
    expect(prompt).toContain("showing center-frame she stands on weathered coastal hardwood decking");
  });
});

describe("the soundscape when a voice is sent", () => {
  const render = (audioIndex: number | undefined, soundscape?: string) =>
    renderH3ReferencePrompt({
      body: 'Mara says, "Go."',
      subjects: [{ ...MARA, audioIndex }],
      hasStart: true,
      hasEnd: true,
      soundscape,
    });

  it("asks for silence between the marked lines", () => {
    expect(render(1, "Footsteps on wood")).toContain(
      `overall_soundscape: Footsteps on wood. ${NO_OTHER_SPEECH}`,
    );
    expect(render(1)).toContain(`overall_soundscape: ${NO_OTHER_SPEECH}`);
  });

  it("is unchanged without a voice", () => {
    expect(render(undefined, "Footsteps on wood")).toContain("overall_soundscape: Footsteps on wood\n");
    expect(render(undefined)).toContain("overall_soundscape: N/A");
  });
});

describe("tagging a spoken line", () => {
  const tagged = (body: string) =>
    renderH3ReferencePrompt({ body, subjects: [], hasStart: true, hasEnd: true });

  it("tags a line whose delivery sits between the verb and the quote", () => {
    // Untagged speech inside this format is description: the model shows
    // someone speaking and says nothing.
    const rendered = tagged('Mike says in a steady, commanding voice, "New stakes."');
    expect(rendered).toContain("<d>[English] New stakes.</d>");
  });

  it("keeps the delivery outside the tag, where it is direction not speech", () => {
    const rendered = tagged('Mike says in a low, gravelly voice, "New stakes."');
    expect(rendered).toContain("(S1) says in a low, gravelly voice: <d>");
  });

  it("still tags the plain form", () => {
    expect(tagged('The robot says, "We should go."')).toContain("(S1) says: <d>");
  });

  it("leaves prose that merely reports speech alone", () => {
    const rendered = tagged("She says the room is cold and nobody answers.");
    expect(rendered).not.toContain("<d>");
  });
});

/**
 * Tagging from the scene's own dialogue.
 *
 * Taken from a live project where only "says" was recognised: the two lines
 * introduced with "speaks" and "his voice carries" reached H3 as description,
 * and with a voice recording attached the character improvised in that voice.
 */
describe("tagging speech from the scene's dialogue", () => {
  const DIALOGUE = [
    { character: "TLBr3f", line: "Still got it. Bare feet on wet sand beats sandals any day." },
    { character: "Darius", line: "Yeah... yeah, it does." },
  ];
  const SCENE_ONE =
    'Mid-stride she speaks while keeping steady pace: "Still got it. Bare feet on wet sand beats ' +
    'sandals any day." Then she stops. His voice carries as his beard breaks the corner: ' +
    '"Yeah... yeah, it does."';

  it("tags every line whatever verb introduces it, naming an unnamed speaker", () => {
    const { text, speakers, unmatched } = markSceneDialogue(SCENE_ONE, DIALOGUE);
    // "she" is the only person in her sentence, so it becomes her name; "his
    // voice" has no pronoun to replace, so his name goes before the tag.
    expect(text).toContain(
      "Mid-stride TLBr3f speaks while keeping steady pace: (S1) <d>[English] Still got it. Bare feet on wet sand beats sandals any day.</d>",
    );
    expect(text).toContain("corner: Darius (S2) <d>[English] Yeah... yeah, it does.</d>");
    expect(speakers).toEqual(["TLBr3f", "Darius"]);
    expect(unmatched).toEqual([]);
  });

  it.each([
    ['The tide turns. She shouts "any spoken word"', "The tide turns. TLBr3f shouts (S1) <d>"],
    ['She cries out "please help me" as the wave hits.', "TLBr3f cries out (S1) <d>"],
    ['She raises her hand and cries out "please help me"', "TLBr3f raises her hand and cries out (S1) <d>"],
  ])("replaces the lone pronoun with the speaker: %s", (body, expected) => {
    const { text } = markSceneDialogue(body, [
      { character: "TLBr3f", line: "Any spoken word!" },
      { character: "TLBr3f", line: "Please help me." },
    ]);
    expect(text).toContain(expected);
  });

  it.each([
    ['She watches as he shouts "please help me"', "two people of either kind"],
    ['Darius turns as she cries out "please help me"', "another named person"],
    ['She sees she cannot run and cries out "please help me"', "the pronoun twice"],
    ['They run and she cries out "please help me"', "a plural"],
  ])("keeps the pronoun when the sentence may be about two people: %s (%s)", (body) => {
    const { text } = markSceneDialogue(
      body,
      [{ character: "TLBr3f", line: "Please help me." }],
      ["Darius"],
    );
    expect(text).toContain("TLBr3f (S1) <d>[English] please help me</d>");
    expect(text).not.toMatch(/TLBr3f (?:watches|sees|cries out \(S1\))/);
  });

  it("does not repeat a name the sentence already gives", () => {
    const { text } = markSceneDialogue(
      'TLBr3f speaks in a low steady voice: "Don\'t try. That\'s the whole trick."',
      [{ character: "TLBr3f", line: "Don't try. That's the whole trick." }],
    );
    expect(text).toBe(
      "TLBr3f speaks in a low steady voice: (S1) <d>[English] Don't try. That's the whole trick.</d>",
    );
  });

  it("keeps the established form for a line introduced with says", () => {
    const { text, speakers } = markSceneDialogue(
      'Darius says low and unhurried, "You got a body that don\'t even try."',
      [{ character: "Darius", line: "You got a body that don't even try." }],
    );
    expect(text).toBe(
      "Darius (S1) says low and unhurried: <d>[English] You got a body that don't even try.</d>",
    );
    expect(speakers).toEqual(["Darius"]);
  });

  it("matches across quote style, case and punctuation, and a line split by its delivery", () => {
    const { text, speakers, unmatched } = markSceneDialogue(
      "She grins. “still got it,” she murmurs. “Bare feet on wet sand beats sandals any day”",
      [DIALOGUE[0]!],
    );
    expect(text.match(/<d>/g)).toHaveLength(2);
    expect(text.match(/\(S1\)/g)).toHaveLength(2);
    expect(speakers).toEqual(["TLBr3f", "TLBr3f"]);
    expect(unmatched).toEqual([]);
  });

  it("leaves a quote that is not a line of the scene alone", () => {
    const { text, unmatched, extras } = markSceneDialogue('A sign reads "CLOSED". She stays silent.', DIALOGUE);
    expect(text).not.toContain("<d>");
    expect(unmatched).toEqual(DIALOGUE);
    // A sign is not speech, so it is not reported either.
    expect(extras).toEqual([]);
  });

  it("reports speech the scene's dialogue does not have, and who it belongs to", () => {
    const { extras } = markSceneDialogue(
      'TLBr3f says, "Hi." Later she cries out "please help me". Darius yells "Run!" ' +
        'Darius says, "Over here."',
      [{ character: "TLBr3f", line: "Hi." }],
      ["Darius"],
    );
    expect(extras).toEqual([
      { words: "Over here.", tagged: true, speaker: "Darius" },
      { words: "please help me", tagged: false, speaker: undefined },
      { words: "Run!", tagged: false, speaker: "Darius" },
    ]);
  });

  it("reports nothing when there is no dialogue to compare against", () => {
    expect(markSceneDialogue('She cries out "please help me"').extras).toEqual([]);
  });

  it("does not count a stage direction in the dialogue as a line to find", () => {
    const { unmatched } = markSceneDialogue('Colin says, "Can I?"', [
      { character: "Colin", line: "Can I?" },
      { character: "Tracey", line: "(Nods)" },
      { character: "Tracey", line: "[sharp inhale]" },
    ]);
    expect(unmatched).toEqual([]);
  });

  it("does not treat a 'said' inside a quoted line as the start of another", () => {
    const line = "...You said just standing there was all you needed.";
    const { text, unmatched } = markSceneDialogue(
      `She steps closer, voice low: "${line}" He answers, "I'm changing what's enough."`,
      [
        { character: "Mara", line },
        { character: "Jon", line: "I'm changing what's enough." },
      ],
    );
    expect(text).toContain(`<d>[English] ${line}</d>`);
    expect(text).not.toContain("You (S");
    expect(unmatched).toEqual([]);
  });

  it("is the verb rule alone when there is no dialogue", () => {
    expect(markSceneDialogue(SCENE_ONE).text).toBe(markDialogue(SCENE_ONE));
    expect(markDialogue(SCENE_ONE)).not.toContain("<d>");
  });
});

describe("binding a character to their photograph", () => {
  const withCast = (body: string) =>
    renderH3ReferencePrompt({
      body,
      subjects: [MARA],
      hasStart: true,
      hasEnd: true,
    });

  it("puts the subject tag where the prose names the character", () => {
    // A reference with nothing tying it to a person in the shot scattered the
    // referenced head across several people in a live run.
    const rendered = withCast("Mara turns from the window as Mara lifts her cup.");
    const body = rendered.slice(rendered.indexOf("detailed_description:"));
    expect(body).toContain("<Subject 1> turns from the window as <Subject 1> lifts her cup.");
  });

  it("leaves the name alone inside spoken lines", () => {
    // The tag would be read aloud.
    const rendered = withCast('The man says, "Mara, wait." Mara stops.');
    const body = rendered.slice(rendered.indexOf("detailed_description:"));
    expect(body).toContain("<d>[English] Mara, wait.</d>");
    expect(body).toContain("<Subject 1> stops.");
  });

  it("does not match a name inside a longer word", () => {
    const rendered = renderH3ReferencePrompt({
      body: "Al watches the album spin.",
      subjects: [{ name: "Al", pictureIndex: 3 }],
      hasStart: true,
      hasEnd: true,
    });
    expect(rendered).toContain("the album spin");
  });

  it("leaves the appended clauses alone", () => {
    // "the frame is free of ... Athletic/muscular Mara" became "free of ...
    // <Subject 1>", which reads as an instruction to leave her out of the shot.
    const rendered = withCast(
      "Mara waits. The start frame fixes how Mara look. The frame is free of muscular Mara.",
    );
    expect(rendered).toContain("The start frame fixes how Mara look");
    expect(rendered).toContain("The frame is free of muscular Mara");
    expect(rendered).toContain("<Subject 1> waits.");
  });

  it("names both halves of the job when a cast is present", () => {
    expect(withCast("She waits.")).toContain("[keyframe completion + reference generation]");
  });
});

describe("a character's voice recording", () => {
  const JON = { name: "Jon", description: "Fifties, grey beard.", pictureIndex: 4 };
  const voiced = (body: string, subjects: H3ReferenceSubject[] = [{ ...MARA, audioIndex: 1 }]) =>
    renderH3ReferencePrompt({ body, subjects, hasStart: true, hasEnd: true });
  const section = (prompt: string, from: string, to?: string) =>
    prompt.slice(prompt.indexOf(from), to ? prompt.indexOf(to) : undefined);

  it("binds the recording to its subject, directly after that subject", () => {
    const definitions = section(voiced("Mara waits."), "subject_definitions:", "summary:");
    const lines = definitions.split("\n");
    const subject = lines.findIndex((line) => line.startsWith("<Subject 1> is Mara"));
    expect(lines[subject + 1]).toMatch(/^<Audio 1> supplies the voice timbre, accent, cadence and delivery identity for <Subject 1>;/);
    expect(lines[subject + 1]).toContain("its words, timing and background noise are not copied");
  });

  it("names the audio reference as one of the job's tasks", () => {
    expect(voiced("Mara waits.")).toContain(
      "[keyframe completion + reference generation + audio reference]",
    );
  });

  it("retains the voice with the guide's audio marker, not a visual one", () => {
    const analysis = section(voiced("Mara waits."), "retention_analysis:", "detailed_description:");
    expect(analysis).toContain("<Audio 1> (heard in [Shot 1]): reference - retain only the stable vocal identity of <Subject 1>");
  });

  it("says which recording each line is spoken in, outside the spoken words", () => {
    const body = section(
      voiced('Mara turns and says quietly, "Not tonight."'),
      "detailed_description:",
    );
    expect(body).toContain(
      "<Subject 1> turns and (S1) says quietly in the voice from <Audio 1>: <d>[English] Not tonight.</d>",
    );
  });

  it("gives each voiced speaker their own recording and leaves an unvoiced one alone", () => {
    const prompt = voiced('Mara says, "Go." Jon says, "No."', [
      { ...MARA, audioIndex: 1 },
      JON,
    ]);
    expect(prompt).toContain("<Subject 1> (S1) says in the voice from <Audio 1>: <d>[English] Go.</d>");
    expect(prompt).toContain("<Subject 2> (S2) says: <d>[English] No.</d>");
    expect(prompt).not.toContain("<Audio 2>");
  });

  it("numbers recordings by voiced speaker, independently of pictures", () => {
    const prompt = voiced('Mara says, "Go." Jon says, "No."', [
      MARA,
      { ...JON, audioIndex: 1 },
    ]);
    expect(prompt).toContain("<Audio 1> supplies the voice timbre, accent, cadence and delivery identity for <Subject 2>");
    expect(prompt).toContain("<Subject 2> (S2) says in the voice from <Audio 1>");
  });

  it("keeps the binding when the line has no named speaker to attach to", () => {
    const prompt = voiced('Mara waits. A voice says, "Not tonight."');
    expect(prompt).toContain("<Audio 1> supplies the voice timbre, accent, cadence and delivery identity for <Subject 1>");
    expect(prompt).not.toContain("in the voice from <Audio 1>");
  });

  /** Rendered by the release before voice references, for the same input. */
  const BEFORE_VOICES =
    "subject_definitions:\n<Picture 1> is the first frame of [Shot 1], showing medium shot of Mara at a rain-streaked window.\n<Picture 2> is the last frame of [Shot 1], showing close-up of Mara facing the room.\n<Subject 1> is Mara, shown in <Picture 3>, which defines their facial identity. Pose and clothing follow the frame anchors or continued video.\nsummary:\n[keyframe completion + reference generation] The target video is a single continuous shot that begins from <Picture 1> and ends on <Picture 2>.\nretention_analysis:\n<Picture 1> ([Shot 1] first frame): fully_preserved - the opening composition, camera position, set dressing and lighting are reproduced exactly at the start of the shot.\n<Picture 2> ([Shot 1] last frame): fully_preserved - the closing framing, subject position and lighting are reached exactly at the end of the shot.\n<Subject 1> (appears in [Shot 1]): attribute_transfer - facial identity is carried over with no drift across the clip; the photograph's own pose, framing, wardrobe and background are not.\ndetailed_description:\nThe target video is a single continuous shot. [Shot 1] The shot begins from <Picture 1> — Medium shot of Mara at a rain-streaked window —, holding its composition, camera position, framing, lighting and the subject's exact pose in that frame. Nothing happens before the first change described below. <Subject 1> turns and (S1) says quietly: <d>[English] Not tonight.</d> The shot settles into the exact framing, subject position and lighting established by <Picture 2>, which is its final frame.\noverall_soundscape: Rain on glass.\nnon_diegetic_music: Low strings.";

  it("leaves a prompt with no recordings exactly as it was", () => {
    expect(
      renderH3ReferencePrompt({
        body: 'Mara turns and says quietly, "Not tonight."',
        subjects: [MARA],
        hasStart: true,
        hasEnd: true,
        startFrameDescription: "Medium shot of Mara at a rain-streaked window.",
        endFrameDescription: "Close-up of Mara facing the room.",
        soundscape: "Rain on glass.",
        score: "Low strings.",
      }),
    ).toBe(BEFORE_VOICES);
  });

  it("adds no blank line, which Wan2GP would read as a second video", () => {
    expect(voiced('Mara says, "Go."')).not.toContain("\n\n");
  });

  it("drops the voice clause when the prompt falls back to plain prose", () => {
    const plain = stripH3ReferencePrompt(voiced('Mara says, "Go."'));
    expect(plain).not.toContain("<Audio");
    expect(plain).toContain('"Go."');
  });

  /**
   * Sentences that show nothing were voiced in the character's voice once a
   * recording was attached: "Nothing happens before the first change described
   * below" and the restriction this block used to add were both heard spoken.
   */
  it("limits speech in the summary and after the lines, not in sentences that could be read out", () => {
    const prompt = voiced('Mara says, "Go."');
    expect(prompt).not.toContain("speaks only the lines marked as theirs");
    expect(prompt).not.toContain("Nothing happens before the first change");
    const summary = prompt.slice(prompt.indexOf("summary:"), prompt.indexOf("retention_analysis:"));
    expect(summary).toContain(SPEECH_LIMIT);
    expect(summary).not.toContain("  ");
    expect(prompt).toContain(`<d>[English] Go.</d> ${DIALOGUE_COMPLETE}`);
  });

  it("takes instruction sentences out of a voiced clip's timeline", () => {
    const body =
      'Mara walks to the door. Camera: slow push-in so only the door matters., evolving from the start ' +
      'frame to the end frame over 20 seconds. While the movement continues, Mara says, "Go... now." Lip movement matches the ' +
      "spoken words. The start frame fixes how Mara look. Keep face, hair, wardrobe and lighting " +
      "unchanged throughout. Render with correct natural anatomy.";
    const description = (prompt: string) => prompt.slice(prompt.indexOf("detailed_description:"));

    const withVoice = description(voiced(body));
    for (const gone of ["evolving from the start frame", "Lip movement", "The start frame fixes", "Keep face", "Render with"]) {
      expect(withVoice).not.toContain(gone);
    }
    expect(withVoice).toContain("Camera: slow push-in so only the door matters. While");
    expect(withVoice).toContain("<d>[English] Go... now.</d>");
    expect(withVoice).toContain("<Subject 1> walks to the door.");

    // Without a voice, nothing is removed.
    const withoutVoice = description(voiced(body, [{ ...MARA }]));
    expect(withoutVoice).toContain("Lip movement matches the spoken words.");
    expect(withoutVoice).toContain("Nothing happens before the first change");
    expect(withoutVoice).not.toContain(DIALOGUE_COMPLETE);
  });

  it("finds the speaker of a line from the dialogue, not from a name beside it", () => {
    const prompt = renderH3ReferencePrompt({
      body: 'Mid-stride she speaks while keeping steady pace: "Still got it." Jon nods.',
      subjects: [{ ...MARA, name: "TLBr3f", audioIndex: 1 }],
      hasStart: true,
      hasEnd: true,
      dialogue: [{ character: "TLBr3f", line: "Still got it." }],
    });
    expect(prompt).toContain(
      "Mid-stride <Subject 1> speaks while keeping steady pace in the voice from <Audio 1>: (S1) <d>[English] Still got it.</d>",
    );
  });

  it("reports a voiced subject whose line never reached the prompt", () => {
    const parts = {
      body: 'Mara mutters, "Maybe later."',
      subjects: [{ ...MARA, audioIndex: 1 }],
      hasStart: true,
      hasEnd: true,
    };
    expect(unvoicedSubjects({ ...parts, dialogue: [{ character: "Mara", line: "Not tonight." }] }))
      .toEqual(["Mara"]);
    expect(unvoicedSubjects({ ...parts, dialogue: [{ character: "Mara", line: "Maybe later." }] }))
      .toEqual([]);
    // Without dialogue, an unattributable line cannot carry the voice either.
    expect(unvoicedSubjects({ ...parts, body: 'Mara waits. A voice says, "Go."' })).toEqual(["Mara"]);
  });

  it("withholds a voice when the prompt quotes speech the dialogue lacks", () => {
    const parts = {
      subjects: [{ ...MARA, audioIndex: 1 }, { name: "Jon", pictureIndex: 4, audioIndex: 2 }],
      hasStart: true,
      hasEnd: true,
      dialogue: [
        { character: "Mara", line: "Not tonight." },
        { character: "Jon", line: "Then when?" },
      ],
    };
    const lines = 'Mara says, "Not tonight." Jon says, "Then when?"';

    // Named: only that speaker's voice is at risk.
    expect(voiceProblems({ ...parts, body: `${lines} Jon shouts "Wait!"` })).toEqual([
      { name: "Jon", reason: "unscripted_speech" },
    ]);
    // Nobody named: it could be either of them.
    expect(voiceProblems({ ...parts, body: `${lines} Someone cries out "Help!"` })).toEqual([
      { name: "Mara", reason: "unscripted_speech" },
      { name: "Jon", reason: "unscripted_speech" },
    ]);
    expect(voiceProblems({ ...parts, body: lines })).toEqual([]);
  });

  /**
   * A name inside a quotation is usually who is being spoken to: "faster,
   * Tracey" is Leroy's line. It must neither be tagged nor decide whose voice
   * the line is in.
   */
  describe("a voiced character named in someone else's line", () => {
    const tracey = { name: "Tracey", pictureIndex: 3, audioIndex: 1 };
    const dialogue = [
      { character: "Tracey", line: "Oh god, yes." },
      { character: "Leroy", line: "Faster, take it faster, baby." },
    ];
    const render = (leroy: string) => {
      const parts = {
        body: `Tracey gasps, "Oh god, yes." ${leroy}`,
        subjects: [tracey],
        hasStart: true,
        hasEnd: true,
        dialogue,
      };
      return { prompt: renderH3ReferencePrompt(parts), problems: voiceProblems(parts) };
    };

    it("leaves the name in the quotation and keeps her voice for her own line", () => {
      const { prompt, problems } = render('Leroy growls, "Come here, Tracey."');
      expect(prompt).toContain('"Come here, Tracey."');
      expect(prompt).not.toContain("Come here, <Subject 1>");
      expect(problems).toEqual([]);
    });

    it("never puts her voice on his line because she is named nearby", () => {
      const { prompt, problems } = render(
        'Gripping Tracey\'s hips, Leroy says, "Faster, take it faster, Tracey."',
      );
      expect(prompt).toContain("<d>[English] Faster, take it faster, Tracey.</d>");
      expect(prompt).not.toMatch(/Leroy \(S\d\) says in the voice from/);
      // The reworded line is still Leroy's card line, so her voice is safe.
      expect(problems).toEqual([]);
    });

    it("credits his reworded line to him even when the sentence only says he", () => {
      const { prompt, problems } = render('He growls, "Faster, take it faster, Tracey, my girl."');
      expect(prompt).toContain("Leroy growls, (S2) <d>[English] Faster, take it faster, Tracey, my girl.</d>");
      expect(prompt).not.toContain("in the voice from <Audio 1>, (S2)");
      expect(problems).toEqual([]);
    });
  });

  describe("a line reworded in the video prompt", () => {
    const lines = [
      { character: "Leroy", line: "Faster, take it faster, baby." },
      { character: "Tracey", line: "Fuck... keep going." },
    ];

    it.each([
      ["Faster — take it faster, Tracey, my little slut.", "Leroy"],
      ["Fuck yeah!... keep going.", "Tracey"],
    ])("is still the card line it came from: %s", (quote, speaker) => {
      const { speakers, unmatched } = markSceneDialogue(`Someone cries out, "${quote}"`, lines);
      expect(speakers).toEqual([speaker]);
      expect(unmatched.map((entry) => entry.character)).not.toContain(speaker);
    });

    it("is not matched on a few shared words", () => {
      const { speakers } = markSceneDialogue('He says, "Take it slow and look at me."', lines);
      expect(speakers).toEqual([undefined]);
    });

    it("is left unmatched when two speakers' lines are equally close", () => {
      const { speakers, extras } = markSceneDialogue('Someone says, "Come here and hold me now."', [
        { character: "Mara", line: "Come here and hold me close." },
        { character: "Jon", line: "Come here, hold me now, please." },
      ]);
      expect(speakers).toEqual([undefined]);
      expect(extras).toHaveLength(1);
    });
  });
});

describe("the cost estimate", () => {
  it("matches the measured runs", () => {
    // One character is three references, measured at 15:26 un-accelerated.
    expect(ref2vaEstimateMinutes(1)).toBe(15);
    expect(ref2vaEstimateMinutes(2)).toBe(19);
    expect(ref2vaEstimateMinutes(3)).toBe(23);
  });

  it("says what Spectrum would save if it were switched on in WanGP", () => {
    // 15:26 -> 12:35 on the same clip.
    expect(ref2vaAcceleratedMinutes(1)).toBe(12);
  });
});

describe("the frame cap", () => {
  const schema: WangpModelSchema = {
    modelType: "minimax_h3_ref2va",
    defaultSettings: { prompt: "", image_prompt_type: "", multi_prompts_gen_type: "PG" },
    fields: [
      { name: "prompt", type: "string" },
      { name: "video_length", type: "number" },
    ],
  } as unknown as WangpModelSchema;

  it("clamps a request past the variant's ceiling", () => {
    const manifest = buildSettingsManifest(schema, {
      sceneId: "s1",
      purpose: "video_segment",
      prompt: "x",
      fps: 24,
      durationSeconds: 15,
      maxFrames: 337,
    });
    expect(manifest.settings.video_length).toBe(337);
  });

  it("leaves a variant with no cap alone", () => {
    const manifest = buildSettingsManifest(schema, {
      sceneId: "s1",
      purpose: "video_segment",
      prompt: "x",
      fps: 24,
      durationSeconds: 15,
    });
    expect(manifest.settings.video_length).toBe(361);
  });
});

/**
 * A catalogue of one Ref2VA checkpoint, declaring exactly what the live schema
 * dump declares — which notably excludes `image_start` and `image_end`.
 */
class Ref2vaClient extends MockWangpClient {
  async listModels(): Promise<WangpModel[]> {
    return [
      {
        modelType: "minimax_h3_ref2va",
        name: "MiniMax H3 Ref2VA",
        mainOutput: "video",
        outputs: ["video", "audio"],
        metadata: { family: "minimax_h3" },
      },
    ] as unknown as WangpModel[];
  }

  async getModelSchema(modelType: string): Promise<WangpModelSchema> {
    return {
      modelType,
      defaultSettings: {
        prompt: "",
        resolution: "832x480",
        sliding_window_size: 362,
        image_prompt_type: "",
        video_prompt_type: "",
        multi_prompts_gen_type: "PG",
      },
      fields: [
        { name: "prompt", type: "string" },
        { name: "resolution", type: "string" },
        { name: "video_length", type: "number", max: 337 },
        { name: "image_refs", type: "array" },
        { name: "video_source", type: "string" },
        { name: "image_prompt_type", type: "string" },
        { name: "video_prompt_type", type: "string" },
      ],
    } as unknown as WangpModelSchema;
  }
}

async function ref2vaManifest(
  overrides: Record<string, unknown> = {},
  client: MockWangpClient = new Ref2vaClient(),
) {
  vi.resetModules();
  const { setWangpClient } = await import("@/lib/wangp/factory");
  setWangpClient(client);
  const { buildVideoManifest } = await import("@/lib/services/wangp-service");

  return buildVideoManifest({
    sceneId: "s1",
    prompt: "Mara turns from the window.",
    modelStrategy: "auto",
    modelType: "minimax_h3_ref2va",
    imageStart: "/frames/start.png",
    imageEnd: "/frames/end.png",
    durationSeconds: 14,
    cast: [{ name: "Mara", description: "Late thirties.", imagePaths: ["/refs/mara.png"] }],
    ...overrides,
  });
}

describe("the Ref2VA manifest", () => {
  it("sends the frames as references and never as keyframes", async () => {
    const manifest = await ref2vaManifest();
    expect(manifest.settings.image_refs).toEqual([
      "/frames/start.png",
      "/frames/end.png",
      "/refs/mara.png",
    ]);
    expect(manifest.settings.image_start).toBeUndefined();
    expect(manifest.settings.image_end).toBeUndefined();
  });

  it("declares the references people and objects, as a working run did", async () => {
    // Read from the metadata WanGP wrote beside a correct hand-made render on
    // this checkpoint. "KI" moved which picture became the opening frame; ""
    // had the references ignored entirely.
    const manifest = await ref2vaManifest();
    expect(manifest.settings.video_prompt_type).toBe("I");
  });

  it("stops a multi-section prompt being split into several", async () => {
    // WanGP's saved state arrives as "PG", under which a carriage return starts
    // a new prompt — so six labelled sections became six prompts.
    const manifest = await ref2vaManifest();
    expect(manifest.settings.multi_prompts_gen_type).toBe("FG");
  });

  it("leaves the step-skipping cache alone", async () => {
    // Its strength cannot be set from here: 1.75 was submitted and WanGP ran
    // the job at its own saved 0.08, skipping most of the denoising.
    const manifest = await ref2vaManifest();
    expect(manifest.settings.skip_steps_cache_type).toBeUndefined();
    expect(manifest.settings.skip_steps_multiplier).toBeUndefined();
  });

  it("lets Wan2GP stitch a request beyond the recommended single window", async () => {
    const manifest = await ref2vaManifest({ durationSeconds: 20 });
    expect(manifest.settings.video_length).toBe(481);
    expect(manifest.settings.sliding_window_size).toBe(481);
  });

  it("prompts in the six-section format", async () => {
    const manifest = await ref2vaManifest();
    expect(String(manifest.settings.prompt)).toContain("subject_definitions:");
    expect(String(manifest.settings.prompt)).toContain("<Picture 3>");
  });

  it("keeps all six sections in one sliding-window paragraph", async () => {
    const manifest = await ref2vaManifest();
    expect(String(manifest.settings.prompt)).not.toContain("\n\n");
  });

  it("continues from a source clip with an end reference but no start anchor", async () => {
    const manifest = await ref2vaManifest({
      imageStart: undefined,
      videoSource: "/clips/previous.mp4",
    });
    const prompt = String(manifest.settings.prompt);

    expect(manifest.settings.video_source).toBe("/clips/previous.mp4");
    expect(manifest.settings.image_prompt_type).toBe("V");
    expect(manifest.settings.image_refs).toEqual(["/frames/end.png", "/refs/mara.png"]);
    expect(prompt).toContain("<Video 1> supplies the source clip being continued");
    expect(prompt).toContain("[video continuation + keyframe completion + reference generation]");
    // WanGP shows the continued frame first, then the end frame, then photos.
    expect(prompt).toContain("<Picture 1> is the final frame of <Video 1>, the frame [Shot 1] begins from.");
    expect(prompt).toContain("<Picture 2> is the last frame of [Shot 1]");
    expect(prompt).toContain("<Subject 1> is Mara, shown in <Picture 3>");
    expect(prompt).toContain("begins immediately after <Video 1>'s final frame");
  });

  it("uses native image_end with continuation when Ref2VA declares it", async () => {
    class ModernRef2vaClient extends Ref2vaClient {
      async getModelSchema(modelType: string): Promise<WangpModelSchema> {
        const schema = await super.getModelSchema(modelType);
        return {
          ...schema,
          fields: [
            ...schema.fields,
            { name: "image_end", type: "string" },
            { name: "image_prompt_type", type: "string" },
          ],
        } as WangpModelSchema;
      }
    }

    const manifest = await ref2vaManifest(
      {
        imageStart: undefined,
        videoSource: "/clips/previous.mp4",
      },
      new ModernRef2vaClient(),
    );

    expect(manifest.settings.video_source).toBe("/clips/previous.mp4");
    expect(manifest.settings.image_end).toBe("/frames/end.png");
    expect(manifest.settings.image_prompt_type).toBe("EV");
    expect(manifest.settings.image_refs).toEqual(["/refs/mara.png"]);
    expect(String(manifest.settings.prompt)).toContain("<Picture 2> is the last frame");
    expect(String(manifest.settings.prompt)).toContain("<Subject 1> is Mara, shown in <Picture 3>");
  });

  it("refuses a single anchor rather than rendering from the prompt alone", async () => {
    await expect(ref2vaManifest({ imageEnd: undefined })).rejects.toThrow(/both a start and an end/);
  });

  it("reports a cast past the cap rather than trimming it", async () => {
    const cast = ["a", "b", "c", "d"].map((name) => ({ name, imagePath: `/refs/${name}.png` }));
    await expect(ref2vaManifest({ cast })).rejects.toThrow(/at most 3 characters/);
  });
});

/** The same checkpoint, declaring the audio reference role a live Ref2VA publishes. */
class VoicedRef2vaClient extends Ref2vaClient {
  async listModels(): Promise<WangpModel[]> {
    return (await super.listModels()).map((model) => ({
      ...model,
      metadata: { ...model.metadata, mediaInputs: { audio: { reference: true } } },
    })) as WangpModel[];
  }

  async getModelSchema(modelType: string): Promise<WangpModelSchema> {
    const schema = await super.getModelSchema(modelType);
    return {
      ...schema,
      fields: [
        ...schema.fields,
        ...["audio_guide", "audio_guide2", "audio_guide3", "audio_prompt_type"].map((name) => ({
          name,
          type: "string",
        })),
      ],
    };
  }
}

describe("voice references on the Ref2VA manifest", () => {
  const JON = { name: "Jon", description: "Fifties.", imagePaths: ["/refs/jon.png"] };
  const MARA_CAST = { name: "Mara", description: "Late thirties.", imagePaths: ["/refs/mara.png"] };

  it("numbers recordings in subject order, skipping subjects with none", async () => {
    const manifest = await ref2vaManifest(
      {
        prompt: 'Mara waits. Jon says, "We go now."',
        cast: [MARA_CAST, { ...JON, voicePath: "/voices/jon.wav" }],
      },
      new VoicedRef2vaClient(),
    );
    const prompt = String(manifest.settings.prompt);

    expect(manifest.settings.audio_guide).toBe("/voices/jon.wav");
    expect(manifest.settings.audio_guide2).toBeUndefined();
    expect(manifest.settings.audio_prompt_type).toBe("A");
    expect(prompt).toContain("<Audio 1> supplies the voice timbre, accent, cadence and delivery identity for <Subject 2>");
    expect(prompt).toContain("<Subject 2> (S1) says in the voice from <Audio 1>: <d>[English] We go now.</d>");
  });

  it("sends two speakers' recordings to the first two guides", async () => {
    const manifest = await ref2vaManifest(
      {
        prompt: 'Mara says, "Now?" Jon says, "Now."',
        cast: [
          { ...MARA_CAST, voicePath: "/voices/mara.wav" },
          { ...JON, voicePath: "/voices/jon.wav" },
        ],
      },
      new VoicedRef2vaClient(),
    );
    expect(manifest.settings.audio_guide).toBe("/voices/mara.wav");
    expect(manifest.settings.audio_guide2).toBe("/voices/jon.wav");
    expect(manifest.settings.audio_prompt_type).toBe("AB");
  });

  async function withLog<T>(run: (logEvent: ReturnType<typeof vi.fn>) => Promise<T>): Promise<T> {
    vi.resetModules();
    const logEvent = vi.fn();
    vi.doMock("@/lib/telemetry", async (original) => ({
      ...(await original<typeof import("@/lib/telemetry")>()),
      logEvent,
    }));
    try {
      return await run(logEvent);
    } finally {
      vi.doUnmock("@/lib/telemetry");
    }
  }

  async function voicedManifest(prompt: string, dialogue: { character: string; line: string }[]) {
    const { setWangpClient } = await import("@/lib/wangp/factory");
    setWangpClient(new VoicedRef2vaClient());
    const { buildVideoManifest } = await import("@/lib/services/wangp-service");
    return buildVideoManifest({
      sceneId: "s1",
      prompt,
      modelStrategy: "auto",
      modelType: "minimax_h3_ref2va",
      imageStart: "/frames/start.png",
      imageEnd: "/frames/end.png",
      durationSeconds: 14,
      cast: [{ ...MARA_CAST, characterId: "mara-id", voicePath: "/voices/mara.wav" }],
      dialogue,
    });
  }

  /**
   * A voice with no tagged words was heard improvising — reading the scene's
   * description aloud in the character's voice — so it is withheld instead.
   */
  it("withholds a voice whose line it could not find, and says why", async () => {
    await withLog(async (logEvent) => {
      const manifest = await voicedManifest('Mara waits, then mutters, "Maybe later."', [
        { character: "Mara", line: "Not tonight." },
      ]);

      expect(manifest.settings.audio_guide).toBeUndefined();
      expect(manifest.settings.audio_prompt_type).toBe("");
      expect(String(manifest.settings.prompt)).not.toContain("<Audio");
      expect(manifest.promptWarnings?.some((w) => w.includes("Mara's voice sample was not sent"))).toBe(true);
      expect(logEvent).toHaveBeenCalledWith(
        "wangp.ref2va.voice_skipped",
        expect.objectContaining({ sceneId: "s1", characterId: "mara-id", reason: "line_not_tagged" }),
      );
    });
  });

  it("sends the voice when the line is introduced with any verb", async () => {
    await withLog(async () => {
      const manifest = await voicedManifest('Mara speaks in a low steady voice: "Not tonight."', [
        { character: "Mara", line: "Not tonight." },
      ]);

      expect(manifest.settings.audio_guide).toBe("/voices/mara.wav");
      expect(String(manifest.settings.prompt)).toContain(
        "<Subject 1> speaks in a low steady voice in the voice from <Audio 1>: (S1) <d>[English] Not tonight.</d>",
      );
      expect(manifest.promptWarnings ?? []).toEqual([]);
    });
  });

  it("warns about unscripted speech and withholds the voice it could be in", async () => {
    await withLog(async (logEvent) => {
      const manifest = await voicedManifest(
        'Mara says, "Not tonight." Later she cries out "please help me".',
        [{ character: "Mara", line: "Not tonight." }],
      );

      expect(manifest.settings.audio_guide).toBeUndefined();
      const warnings = manifest.promptWarnings ?? [];
      expect(warnings.some((w) => w.includes("quotes speech that is not in the scene's dialogue"))).toBe(true);
      expect(warnings.some((w) => w.includes('"please help me" reads as speech'))).toBe(true);
      expect(logEvent).toHaveBeenCalledWith(
        "wangp.ref2va.voice_skipped",
        expect.objectContaining({ characterId: "mara-id", reason: "unscripted_speech" }),
      );
    });
  });
});

describe.each(H3_OMNI_MODEL_TYPES)("%s reference manifests", (modelType) => {
  it.each([false, true])(
    "sends character photographs with native keyframe inputs = %s",
    async (nativeKeyframes) => {
      class OmniClient extends Ref2vaClient {
        async listModels(): Promise<WangpModel[]> {
          return (await super.listModels()).map((model) => ({ ...model, modelType }));
        }

        async getModelSchema(type: string): Promise<WangpModelSchema> {
          const schema = await super.getModelSchema(type);
          return {
            ...schema,
            fields: [
              ...schema.fields,
              ...(nativeKeyframes
                ? [
                    { name: "image_start", type: "string" },
                    { name: "image_end", type: "string" },
                  ]
                : []),
            ],
          };
        }
      }

      const manifest = await ref2vaManifest({ modelType }, new OmniClient());

      expect(manifest.modelType).toBe(modelType);
      expect(manifest.settings.image_refs).toEqual(
        nativeKeyframes
          ? ["/refs/mara.png"]
          : ["/frames/start.png", "/frames/end.png", "/refs/mara.png"],
      );
      expect(manifest.settings.image_start).toBe(
        nativeKeyframes ? "/frames/start.png" : undefined,
      );
      expect(manifest.settings.image_end).toBe(nativeKeyframes ? "/frames/end.png" : undefined);
      expect(manifest.settings.video_prompt_type).toBe("I");
      expect(manifest.settings.multi_prompts_gen_type).toBe("FG");
      expect(String(manifest.settings.prompt)).toContain("subject_definitions:");
      // The keyframes come first in WanGP's picture order whichever way they
      // are sent, so the photograph is the third picture either way.
      expect(String(manifest.settings.prompt)).toContain(
        "<Subject 1> is Mara, shown in <Picture 3>",
      );
    },
  );
});
