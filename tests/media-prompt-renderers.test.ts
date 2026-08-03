import { describe, it, expect } from "vitest";
import {
  dialogueClause,
  framingOpening,
  renderImagePrompt,
  renderVideoPrompt,
  trimToBudget,
} from "@/lib/agents/media-prompt-renderers";
import {
  countWords,
  hasPunctuationArtifact,
  lintRendered,
  wordBudget,
  type MediaPromptSpec,
} from "@/lib/agents/media-prompt-spec";
import {
  buildMediaPromptSpec,
  deriveCameraMotion,
  deriveFraming,
  splitMotion,
} from "@/lib/agents/media-prompt-builder";
import type { Project } from "@/lib/schemas/project";
import type { SceneDraft } from "@/lib/schemas/storyboard";

function spec(overrides: Partial<MediaPromptSpec> = {}): MediaPromptSpec {
  return {
    framing: { shotSize: "Medium shot", cameraHeight: "eye level" },
    subject: "The apprentice braces a brass gear against the movement",
    setting: "a cluttered clock workshop",
    lighting: "low winter sun through a dusty window",
    startState: "the gear held clear of the plate",
    endState: "the gear seated, teeth meshed",
    dominantMotion: "she seats the gear with a firm clockwise turn",
    secondaryMotion: "the scarf whips left",
    cameraMotion: "makes one slow push-in",
    dialogue: [],
    continuity: [],
    exclusions: [],
    ...overrides,
  };
}

function scene(overrides: Partial<SceneDraft> = {}): SceneDraft {
  return {
    id: "p1-scene-001",
    projectId: "p1",
    sceneNumber: 1,
    startTimeSeconds: 0,
    endTimeSeconds: 20,
    targetDurationSeconds: 20,
    title: "The gear",
    sceneObjective: "Seat the gear",
    storyBeat: "The apprentice commits to the repair",
    visualDescription: "Medium shot of the apprentice at the bench",
    actionDescription: "She seats the gear with a firm turn. The scarf whips left. A clock chimes.",
    cameraMovement: "Slow push-in on the subject.",
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

const project = { segmentCount: 3, segmentSeconds: 20 } as Project;

/** FR-2: images open with shot size and camera height; lens when known. */
describe("image framing opening", () => {
  it("leads with shot size then camera height", () => {
    expect(framingOpening(spec())).toBe("Medium shot, eye level.");
  });

  it("includes a lens when one is known", () => {
    const withLens = spec({
      framing: { shotSize: "Close-up", cameraHeight: "low angle", lens: "50mm" },
    });
    expect(framingOpening(withLens)).toBe("Close-up, low angle, 50mm.");
  });

  it("never opens an image prompt with the old boilerplate", () => {
    const rendered = renderImagePrompt(spec(), { family: "flux", frame: "start" });
    expect(rendered.startsWith("Medium shot, eye level.")).toBe(true);
    expect(rendered).not.toMatch(/^Cinematic still/);
  });

  it("states each required fact once", () => {
    const rendered = renderImagePrompt(spec(), { family: "flux", frame: "start" });
    expect(rendered).toContain("apprentice");
    expect(rendered).toContain("clock workshop");
    expect(rendered).toContain("winter sun");
    expect(lintRendered(rendered, "flux", "image", 0)).toEqual([]);
  });

  it("renders the end frame from the end state, not the start state", () => {
    const start = renderImagePrompt(spec(), { family: "flux", frame: "start" });
    const end = renderImagePrompt(spec(), { family: "flux", frame: "end" });
    expect(start).toContain("held clear of the plate");
    expect(end).toContain("teeth meshed");
    expect(end).not.toContain("held clear of the plate");
  });

  it("tells Qwen not to invent lettering, since it is the family that does", () => {
    expect(renderImagePrompt(spec(), { family: "qwen", frame: "start" })).toContain("No lettering");
    expect(renderImagePrompt(spec(), { family: "flux", frame: "start" })).not.toContain(
      "No lettering",
    );
  });
});

/** FR-4: video is motion-first, one dominant action, one camera behaviour. */
describe("video rendering by family", () => {
  it("opens Wan on the movement, not the scene description", () => {
    const rendered = renderVideoPrompt(spec(), {
      family: "wan",
      segmentSeconds: 5,
      nativeAudio: false,
    });
    // The duration frames the shot; the action is the first thing described.
    expect(rendered.startsWith("Over 5 seconds, she seats the gear")).toBe(true);
    expect(rendered).not.toContain("clock workshop");
  });

  it("states the segment length every family has to fill", () => {
    for (const family of ["wan", "ltx", "unknown"] as const) {
      const rendered = renderVideoPrompt(spec(), {
        family,
        segmentSeconds: 20,
        nativeAudio: false,
      });
      expect(rendered, family).toMatch(/\b20 seconds\b/);
    }
  });

  it("keeps Wan inside its budget, whose formula is motion plus camera", () => {
    const rendered = renderVideoPrompt(spec(), {
      family: "wan",
      segmentSeconds: 5,
      nativeAudio: false,
    });
    expect(countWords(rendered)).toBeLessThanOrEqual(wordBudget("wan", "video", 5));
  });

  it("says so explicitly when the camera is locked", () => {
    const rendered = renderVideoPrompt(spec({ cameraMotion: "" }), {
      family: "wan",
      segmentSeconds: 5,
      nativeAudio: false,
    });
    expect(rendered).toContain("Fixed camera, unchanged framing");
  });

  it("writes LTX as a present-tense timeline anchored to the duration", () => {
    const rendered = renderVideoPrompt(spec(), {
      family: "ltx",
      segmentSeconds: 10,
      nativeAudio: true,
    });
    expect(rendered.startsWith("Over 10 seconds,")).toBe(true);
    expect(rendered).toContain("The shot settles on");
  });

  it("gives LTX ambience only when it renders its own audio", () => {
    const withAudio = renderVideoPrompt(spec(), {
      family: "ltx",
      segmentSeconds: 10,
      nativeAudio: true,
    });
    const without = renderVideoPrompt(spec(), {
      family: "ltx",
      segmentSeconds: 10,
      nativeAudio: false,
    });
    expect(withAudio).toContain("Ambience:");
    expect(without).not.toContain("Ambience:");
  });

  it("ends on an observable state so the movement has somewhere to finish", () => {
    for (const family of ["wan", "ltx"] as const) {
      const rendered = renderVideoPrompt(spec(), {
        family,
        segmentSeconds: 10,
        nativeAudio: family === "ltx",
      });
      expect(rendered, family).toContain("teeth meshed");
    }
  });
});

/** FR-6: dialogue verbatim, speaker-attributed, quoted inline for lip sync. */
describe("dialogue rendering", () => {
  const speaking = spec({
    dialogue: [
      { speaker: "Ana", line: "Then we decide now, together." },
      { speaker: "Ben", line: "Not yet." },
    ],
  });

  it("attributes each speaker and quotes the line inline", () => {
    expect(dialogueClause(speaking)).toBe(
      'Ana says, "Then we decide now, together." Ben says, "Not yet." ' +
        "Lip movement matches the spoken words.",
    );
  });

  it("keeps the words exactly as written", () => {
    const rendered = renderVideoPrompt(speaking, {
      family: "ltx",
      segmentSeconds: 10,
      nativeAudio: true,
    });
    expect(rendered).toContain('"Then we decide now, together."');
    expect(rendered).toContain('"Not yet."');
  });

  it("re-delimits an inner double quote rather than breaking the wrapper", () => {
    const quoted = spec({ dialogue: [{ speaker: "Ana", line: 'He said "run" and left.' }] });
    expect(dialogueClause(quoted)).toContain(`Ana says, "He said 'run' and left."`);
  });

  it("never drops dialogue to satisfy a word budget", () => {
    // Dialogue is authoritative; optional clauses are cut first.
    const wordy = spec({
      dialogue: [{ speaker: "Ana", line: "Then we decide now, together, before the tide turns." }],
      secondaryMotion: Array.from({ length: 80 }, () => "drifting").join(" "),
    });
    const rendered = renderVideoPrompt(wordy, {
      family: "wan",
      segmentSeconds: 5,
      nativeAudio: false,
    });
    expect(rendered).toContain("before the tide turns");
  });
});

describe("budget trimming", () => {
  it("protects the opening sentence", () => {
    const text = "Medium shot, eye level. " + Array.from({ length: 60 }, () => "extra").join(" ") + ".";
    expect(trimToBudget(text, 10)).toContain("Medium shot, eye level.");
  });

  it("returns the text untouched when it already fits", () => {
    expect(trimToBudget("Short enough.", 50)).toBe("Short enough.");
  });
});

/** FR-10: no duplicated sentences and no punctuation artifacts, anywhere. */
describe("output hygiene", () => {
  it("removes the repeated scene description the old builder emitted", () => {
    const repeated = spec({
      subject: "The gear turns",
      startState: "The gear turns",
      endState: "The gear turns",
    });
    const rendered = renderImagePrompt(repeated, { family: "flux", frame: "start" });
    expect(rendered.match(/gear turns/gi)?.length).toBe(1);
  });

  it("does not emit the camera-movement artifact from the traces", () => {
    // `Camera: ${cameraMovement.toLowerCase()}, evolving` where the field
    // already ended in a full stop.
    const rendered = renderVideoPrompt(spec({ cameraMotion: "makes one slow push-in." }), {
      family: "wan",
      segmentSeconds: 5,
      nativeAudio: false,
    });
    expect(hasPunctuationArtifact(rendered)).toBe(false);
  });

  it("stays clean for every family", () => {
    for (const family of ["flux", "qwen", "krea", "wan", "ltx", "unknown"] as const) {
      const image = renderImagePrompt(spec(), { family, frame: "start" });
      const video = renderVideoPrompt(spec(), {
        family,
        segmentSeconds: 10,
        nativeAudio: family === "ltx",
      });
      expect(hasPunctuationArtifact(image), `${family} image`).toBe(false);
      expect(hasPunctuationArtifact(video), `${family} video`).toBe(false);
    }
  });
});

describe("deriving a spec from a scene card", () => {
  it("reads shot size from the visual description", () => {
    expect(deriveFraming(scene(), undefined).shotSize).toBe("Medium shot");
  });

  it("prefers the cinematographer's shot plan over the card", () => {
    const framing = deriveFraming(scene(), "Extreme close-up, low angle, 85mm on the gear");
    expect(framing.shotSize).toBe("Extreme close-up");
    expect(framing.cameraHeight).toBe("low angle");
    expect(framing.lens).toBe("85mm");
  });

  it("falls back to a medium at eye level when nothing states framing", () => {
    const framing = deriveFraming(scene({ visualDescription: "The bench", cameraMovement: "" }), undefined);
    expect(framing).toEqual({ shotSize: "Medium shot", cameraHeight: "eye level" });
  });

  it("turns a static camera note into an explicit fixed frame", () => {
    expect(deriveCameraMotion(scene({ cameraMovement: "Static" }))).toBe("holds a fixed frame");
  });

  it("strips the trailing stop and supplies a verb, since cards state a noun phrase", () => {
    // "The camera slow push-in on the subject" is what plain concatenation gave.
    expect(deriveCameraMotion(scene())).toBe("makes a slow push-in on the subject");
  });

  it("leaves a note that already reads as a verb alone", () => {
    expect(deriveCameraMotion(scene({ cameraMovement: "Pushes in slowly" }))).toBe(
      "pushes in slowly",
    );
  });

  it("removes framing wording from the subject once it leads the prompt", () => {
    const built = buildMediaPromptSpec(project, scene(), undefined, undefined);
    // Otherwise it renders as "Medium shot, eye level. Medium shot of the ...".
    expect(built.subject).toBe("the apprentice at the bench");
  });

  it("promotes one dominant action and keeps at most one secondary", () => {
    const motion = splitMotion("She seats the gear. The scarf whips left. A clock chimes.");
    expect(motion.dominant).toBe("She seats the gear");
    expect(motion.secondary).toBe("The scarf whips left");
  });

  it("carries dialogue through verbatim", () => {
    const built = buildMediaPromptSpec(
      project,
      scene({ dialogue: [{ character: "Ana", line: "Now." }] } as Partial<SceneDraft>),
      undefined,
      undefined,
    );
    expect(built.dialogue).toEqual([{ speaker: "Ana", line: "Now." }]);
  });

  it("marks the closing scene as resolving rather than setting up another", () => {
    const built = buildMediaPromptSpec(project, scene({ sceneNumber: 3 }), undefined, undefined);
    expect(built.endState).toContain("resolving beat");
  });
});
