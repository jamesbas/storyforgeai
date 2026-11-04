import { describe, expect, it } from "vitest";
import {
  essentialVideoSentences,
  gateVideoPrompt,
  videoGateRetryDirective,
  type VideoGateContext,
} from "@/lib/agents/video-prompt-gate";

function context(overrides: Partial<VideoGateContext> = {}): VideoGateContext {
  return {
    scene: {
      actionDescription: "Ada opens the archive door. Ben carries the blue folder.",
      visualDescription: "Ada and Ben are in the archive.",
      dialogue: [{ character: "Ada", line: "The records are ready." }],
    },
    participants: ["Ada", "Ben"],
    ...overrides,
  };
}

const faithful = 'Ada opens the archive door and says, "The records are ready." Ben carries the blue folder.';

describe("gateVideoPrompt dialogue", () => {
  it("accepts faithful motion with correctly attributed verbatim dialogue", () => {
    expect(gateVideoPrompt(faithful, context())).toEqual([]);
  });

  it("warns when the exact line is present but assigned to the wrong named speaker", () => {
    const warnings = gateVideoPrompt(
      'Ada opens the archive door. Ben carries the blue folder and says, "The records are ready."',
      context(),
    );
    expect(warnings).toContainEqual(expect.stringMatching(/appears assigned to Ben.*assign this line to Ada/));
  });

  it("does not mistake a named listener for the speaker", () => {
    const warnings = gateVideoPrompt(
      'Ada listens while Ben says to Ada, "The records are ready." Ada opens the archive door. Ben carries the blue folder.',
      context(),
    );
    expect(warnings).toContainEqual(expect.stringContaining("appears assigned to Ben"));
  });

  it.each([
    'Ada: "The records are ready."',
    'Ada says to Ben, “The records are ready.”',
    '"The records are ready," Ada says.',
    '"The records are ready," says Ada.',
    "Ada says: The records are ready.",
    "Ada says, 'The records are ready.'",
  ])("recognizes explicit attribution: %s", (speech) => {
    expect(gateVideoPrompt(`Ada opens the archive door. Ben carries the blue folder. ${speech}`, context())).toEqual([]);
  });

  it("compares whole dialogue words, ignoring case and punctuation", () => {
    expect(gateVideoPrompt(
      'Ada opens the archive door and says, "THE RECORDS—are ready!" Ben carries the blue folder.',
      context(),
    )).toEqual([]);
    const ctx = context({
      scene: { actionDescription: "", visualDescription: "", dialogue: [{ character: "Ada", line: "Go" }] },
      participants: ["Ada"],
    });
    expect(gateVideoPrompt('Ada says, "Good morning."', ctx)).toContainEqual(expect.stringMatching(/^Missing dialogue/));
  });

  it("warns about a missing or paraphrased spoken line", () => {
    expect(gateVideoPrompt(
      'Ada opens the archive door and says, "The files are available." Ben carries the blue folder.',
      context(),
    )).toContainEqual(expect.stringContaining("Missing dialogue for Ada"));
  });

  it("flags an unassigned quote as ambiguous rather than claiming a speaker swap", () => {
    const warnings = gateVideoPrompt(
      'Ada opens the archive door. Ben carries the blue folder. "The records are ready."',
      context(),
    );
    expect(warnings).toContainEqual(expect.stringMatching(/^Speaker is unclear/));
    expect(warnings.join(" ")).not.toContain("appears assigned");
  });

  it("checks each line's speaker separately", () => {
    const ctx = context({
      scene: {
        actionDescription: "", visualDescription: "",
        dialogue: [{ character: "Ada", line: "Ready to begin." }, { character: "Ben", line: "The room is open." }],
      },
    });
    const warnings = gateVideoPrompt('Ben says, "Ready to begin." Ada replies, "The room is open."', ctx);
    expect(warnings.filter((warning) => warning.includes("appears assigned"))).toHaveLength(2);
  });

  it("supports repeated lines spoken correctly by different people", () => {
    const ctx = context({
      scene: {
        actionDescription: "", visualDescription: "",
        dialogue: [{ character: "Ada", line: "Ready." }, { character: "Ben", line: "Ready." }],
      },
    });
    expect(gateVideoPrompt('Ada says, "Ready." Ben replies, "Ready."', ctx)).toEqual([]);
  });

  it("ignores empty dialogue entries", () => {
    expect(gateVideoPrompt("Ada waves.", context({
      scene: { actionDescription: "", visualDescription: "", dialogue: [{ character: "Ada", line: " " }] },
      participants: ["Ada"],
    }))).toEqual([]);
  });

  it("accepts missing optional dialogue data", () => {
    expect(gateVideoPrompt("Ada waves.", context({
      scene: { actionDescription: "", visualDescription: "" }, participants: ["Ada"],
    }))).toEqual([]);
  });

  it("keeps attribution separate from the next speaker's sentence", () => {
    const ctx = context({
      scene: {
        actionDescription: "", visualDescription: "",
        dialogue: [{ character: "Ada", line: "Ready." }, { character: "Ben", line: "Welcome." }],
      },
    });
    expect(gateVideoPrompt('Ada says, "Ready." Ben says, "Welcome."', ctx)).toEqual([]);
  });
});

describe("gateVideoPrompt actors and action", () => {
  it("warns about an omitted named actor, even if the actor is mentioned inside dialogue", () => {
    const warnings = gateVideoPrompt('Ada opens the archive door and says, "Ben will be here soon."', context({
      scene: {
        actionDescription: "Ada opens the archive door. Ben carries the blue folder.",
        visualDescription: "",
        dialogue: [{ character: "Ada", line: "Ben will be here soon." }],
      },
    }));
    expect(warnings).toContainEqual(expect.stringMatching(/^Participant Ben is not explicitly identified/));
  });

  it("checks names at word boundaries, not substrings", () => {
    const warnings = gateVideoPrompt("Anna waves.", context({
      participants: ["Ann"], scene: { actionDescription: "", visualDescription: "", dialogue: [] },
    }));
    expect(warnings).toContainEqual(expect.stringContaining("Participant Ann is not explicitly identified"));
  });

  it("warns about clearly unrelated activity bound to the named actor", () => {
    const warnings = gateVideoPrompt(
      'Ada waters garden plants and says, "The records are ready." Ben carries the blue folder.',
      context(),
    );
    expect(warnings).toContainEqual(expect.stringContaining("Possible unrelated action for Ada"));
  });

  it("does not let another actor's matching action hide an actor swap", () => {
    const warnings = gateVideoPrompt(
      'Ben opens the archive door. Ada carries the blue folder and says, "The records are ready."',
      context(),
    );
    expect(warnings).toContainEqual(expect.stringContaining("Possible unrelated action for Ada"));
    expect(warnings).toContainEqual(expect.stringContaining("Possible unrelated action for Ben"));
  });

  it("does not let dialogue alone stand in for an actor's required physical beat", () => {
    const warnings = gateVideoPrompt(
      'Ada says, "The records are ready." Ben carries the blue folder.',
      context(),
    );
    expect(warnings).toContainEqual(expect.stringContaining("Possible missing action for Ada"));
  });

  it("warns if the only direction is camera movement", () => {
    expect(gateVideoPrompt("The camera pans slowly across the room.", context())).toContainEqual(
      expect.stringContaining("may omit the scene action"),
    );
  });

  it("does not reject lexical paraphrases sharing clear physical anchors", () => {
    expect(gateVideoPrompt(
      'Ada unlocks the archive door and says, "The records are ready." Ben holds the blue folder.',
      context(),
    )).toEqual([]);
  });

  it("does not infer an action failure from a tiny source action", () => {
    expect(gateVideoPrompt("Ada smiles.", context({
      scene: { actionDescription: "Ada waits.", visualDescription: "", dialogue: [] }, participants: ["Ada"],
    }))).toEqual([]);
  });

  it("recognizes unique given names without merging numbered role labels", () => {
    expect(gateVideoPrompt('Ada says, "Ready."', context({
      scene: { actionDescription: "", visualDescription: "", dialogue: [{ character: "Ada Stone", line: "Ready." }] },
      participants: ["Ada Stone"],
    }))).toEqual([]);
    expect(gateVideoPrompt("Worker 1 waves.", context({
      scene: { actionDescription: "", visualDescription: "", dialogue: [] }, participants: ["Worker 1", "Worker 2"],
    }))).toContainEqual(expect.stringContaining("Participant Worker 2"));
  });

  it("flags a distinguishable new named actor, but not a camera or a name in speech", () => {
    expect(gateVideoPrompt(`${faithful} Casey enters.`, context())).toContainEqual(
      expect.stringContaining("Possible unexpected participant Casey"),
    );
    expect(gateVideoPrompt(`${faithful} Camera opens on the room.`, context())).toEqual([]);
    expect(gateVideoPrompt('Ada says, "Casey enters at noon." Ben carries the blue folder.', context({
      scene: {
        actionDescription: "", visualDescription: "", dialogue: [{ character: "Ada", line: "Casey enters at noon." }],
      },
    }))).toEqual([]);
  });

  it("accepts supporting actors explicitly established by the scene or frame", () => {
    expect(gateVideoPrompt(`${faithful} Casey enters.`, context({
      startFrame: "Casey is at the archive entrance.",
    }))).toEqual([]);
  });

  it("only flags explicitly additional anonymous participants", () => {
    expect(gateVideoPrompt(`${faithful} Another worker enters.`, context())).toContainEqual(
      expect.stringContaining("Possible added participant"),
    );
    expect(gateVideoPrompt(`${faithful} Two people stand in the archive.`, context())).toEqual([]);
  });
});

describe("gateVideoPrompt wardrobe", () => {
  const wardrobe = { Ada: "a blue coat and grey trousers", Ben: "a green jacket" };

  it.each([
    "Ada takes her coat off.",
    "Ada pulls off her coat.",
    "Ada slips out of her coat.",
    "Ada is slowly removing her coat.",
  ])("recognizes explicit garment removal: %s", (removal) => {
    expect(gateVideoPrompt(`${faithful} ${removal}`, context({ wardrobe }))).toContainEqual(
      expect.stringContaining("unauthorized wardrobe change for Ada"),
    );
  });

  it("warns about an unplanned, owner-bound garment removal", () => {
    expect(gateVideoPrompt(`${faithful} Ada removes her coat.`, context({ wardrobe }))).toContainEqual(
      expect.stringContaining("Possible unauthorized wardrobe change for Ada"),
    );
  });

  it("resolves an explicit garment owner instead of blaming the actor", () => {
    const warnings = gateVideoPrompt(`${faithful} Ben removes Ada's coat.`, context({ wardrobe }));
    expect(warnings).toContainEqual(expect.stringContaining("wardrobe change for Ada"));
    expect(warnings.join(" ")).not.toContain("wardrobe change for Ben");
  });

  it("allows explicit per-person wardrobe changes without exempting everyone", () => {
    const warnings = gateVideoPrompt(
      `${faithful} Ada removes her coat. Ben takes off his jacket.`,
      context({ wardrobe, allowedWardrobeChanges: ["Ada"] }),
    );
    expect(warnings).toContainEqual(expect.stringContaining("wardrobe change for Ben"));
    expect(warnings.join(" ")).not.toContain("wardrobe change for Ada");
  });

  it("accepts an exact clothing change already requested on the scene card", () => {
    const ctx = context({ wardrobe });
    ctx.scene = { ...ctx.scene, actionDescription: `${ctx.scene.actionDescription} Ada removes her coat.` };
    expect(gateVideoPrompt(`${faithful} Ada removes her coat.`, ctx)).toEqual([]);
  });

  it("accepts lexical removal variants but not a different garment change", () => {
    const ctx = context({ wardrobe });
    ctx.scene = { ...ctx.scene, actionDescription: `${ctx.scene.actionDescription} Ada removes her coat.` };
    expect(gateVideoPrompt(`${faithful} Ada takes off her coat.`, ctx)).toEqual([]);
    expect(gateVideoPrompt(`${faithful} Ada takes off her coat and gloves.`, ctx)).toContainEqual(
      expect.stringContaining("unauthorized wardrobe change for Ada"),
    );
  });

  it("does not confuse negation, dialogue, or non-clothing removal with undressing", () => {
    expect(gateVideoPrompt(`${faithful} Ada does not remove her coat. Ben removes the lid.`, context({ wardrobe }))).toEqual([]);
    expect(gateVideoPrompt(`${faithful} Do not let Ada remove her coat.`, context({ wardrobe }))).toEqual([]);
    expect(gateVideoPrompt('Ada says, "I will remove my coat tomorrow." Ben smiles.', context({
      wardrobe,
      scene: {
        actionDescription: "", visualDescription: "", dialogue: [{ character: "Ada", line: "I will remove my coat tomorrow." }],
      },
    }))).toEqual([]);
  });

  it("flags an explicit conflicting garment colour for its own wearer", () => {
    const warnings = gateVideoPrompt(`${faithful} Ada wears a red coat. Ben wears a green jacket.`, context({ wardrobe }));
    expect(warnings).toContainEqual(expect.stringContaining("Possible wardrobe mismatch for Ada"));
    expect(warnings.join(" ")).not.toContain("wardrobe mismatch for Ben");
  });

  it.each([
    "Ada is now wearing a red coat.",
    "Ada, wearing a red coat, opens the archive door.",
  ])("recognizes an explicit wearer in normal prose: %s", (wearing) => {
    expect(gateVideoPrompt(`${faithful} ${wearing}`, context({ wardrobe }))).toContainEqual(
      expect.stringContaining("wardrobe mismatch for Ada"),
    );
  });

  it("does not require the entire outfit to be repeated or treat accessories as mismatches", () => {
    expect(gateVideoPrompt(`${faithful} Ada wears a blue coat and a red scarf.`, context({ wardrobe }))).toEqual([]);
    expect(gateVideoPrompt(faithful, context({ wardrobe }))).toEqual([]);
  });

  it("keeps garment colours separate and does not borrow another actor's outfit", () => {
    expect(gateVideoPrompt(`${faithful} Ada wears a blue coat and grey trousers. Ben wears a green jacket.`, context({ wardrobe }))).toEqual([]);
    expect(gateVideoPrompt(`${faithful} Ada wears a red coat beside Ben who wears a blue jacket.`, context({ wardrobe }))).toContainEqual(
      expect.stringContaining("wardrobe mismatch for Ada"),
    );
  });

  it("does not treat approved navy/blue or gray/grey shades as a certain mismatch", () => {
    expect(gateVideoPrompt(`${faithful} Ada wears a navy coat and gray trousers.`, context({ wardrobe }))).toEqual([]);
  });

  it("does not warn about colours with no approved outfit or an authorized change", () => {
    expect(gateVideoPrompt(`${faithful} Ada wears a red coat.`, context())).toEqual([]);
    expect(gateVideoPrompt(`${faithful} Ada wears a red coat.`, context({
      wardrobe, allowedWardrobeChanges: ["Ada"],
    }))).toEqual([]);
  });
});

describe("advisory contract", () => {
  it("returns actionable findings for blank input", () => {
    expect(gateVideoPrompt(" \n ", context())).toEqual([
      "Video prompt is blank; describe the scene's motion and any required spoken lines.",
    ]);
  });

  it("is deterministic and does not mutate frozen inputs", () => {
    const ctx = Object.freeze(context({
      scene: Object.freeze({
        actionDescription: "", visualDescription: "", dialogue: Object.freeze([]) as unknown as VideoGateContext["scene"]["dialogue"],
      }),
      participants: Object.freeze(["Ada"]),
      wardrobe: Object.freeze({ Ada: "a blue coat" }),
      allowedWardrobeChanges: Object.freeze([]),
    }));
    const prompt = "Ada wears a red coat.";
    expect(gateVideoPrompt(prompt, ctx)).toEqual(gateVideoPrompt(prompt, ctx));
    expect(ctx.wardrobe).toEqual({ Ada: "a blue coat" });
    expect(prompt).toBe("Ada wears a red coat.");
  });

  it("emits no retry for clean prompts and deduplicates supplied findings", () => {
    expect(videoGateRetryDirective([])).toBe("");
    const directive = videoGateRetryDirective(["Restore Ada's line.", "Restore Ada's line."]);
    expect(directive).toContain("Advisory checks may be incomplete");
    expect(directive.match(/Restore Ada's line\./g)).toHaveLength(1);
  });
});

describe("essentialVideoSentences", () => {
  it("protects the actor/action beat, camera direction, and attributed dialogue in order", () => {
    const text = 'Warm lighting fills the archive. Ada opens the archive door. Ben carries the blue folder. The camera dollies forward. Ada says, "The records are ready." Film grain gives a timeless feel.';
    expect(essentialVideoSentences(text, context())).toEqual([
      "Ada opens the archive door.",
      "Ben carries the blue folder.",
      "The camera dollies forward.",
      'Ada says, "The records are ready."',
    ]);
  });

  it("does not split required dialogue at punctuation inside quotes", () => {
    const ctx = context({
      scene: {
        actionDescription: "", visualDescription: "",
        dialogue: [{ character: "Ada", line: "Ready. Please come in." }],
      },
    });
    expect(essentialVideoSentences('Ada says, "Ready. Please come in." Ben waves. Soft shadows cover the wall.', ctx)).toEqual([
      'Ada says, "Ready. Please come in."',
    ]);
  });

  it("keeps postfix speaker attribution attached to a spoken line", () => {
    expect(essentialVideoSentences('"The records are ready," Ada says. A decorative clock is visible.', context())).toEqual([
      '"The records are ready," Ada says.',
    ]);
    expect(essentialVideoSentences('"The records are ready." says Ada. A decorative clock is visible.', context())).toEqual([
      '"The records are ready." says Ada.',
    ]);
  });

  it("protects the required verbatim line even when speaker attribution needs repair", () => {
    expect(essentialVideoSentences('"The records are ready." Ben wears a blue coat.', context())).toEqual([
      '"The records are ready."',
    ]);
  });

  it("retains other explicitly attributed speech without treating quoted camera words as direction", () => {
    const ctx = context({ scene: { actionDescription: "", visualDescription: "" } });
    expect(essentialVideoSentences('Ben says, "Welcome to the archive." A sign reads "Camera rental".', ctx)).toEqual([
      'Ben says, "Welcome to the archive."',
    ]);
  });

  it("keeps clear pronoun-led continuations but not appearance details sharing a name", () => {
    const ctx = context({
      scene: { actionDescription: "Ada places a folder on the table.", visualDescription: "" }, participants: ["Ada"],
    });
    expect(essentialVideoSentences("Ada's blue coat is visible. She places the folder on the table. The walls are blue.", ctx)).toEqual([
      "She places the folder on the table.",
    ]);
  });

  it("returns an empty selection for blank text or details with no essential evidence", () => {
    expect(essentialVideoSentences("", context())).toEqual([]);
    expect(essentialVideoSentences("Soft shadows on a textured wall.", context())).toEqual([]);
  });
});
