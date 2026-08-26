import { describe, expect, it } from "vitest";
import {
  CONCEPT_ENHANCER_SYSTEM,
  CONCEPT_ENHANCER_VISUAL,
  enhanceConcept,
} from "@/lib/agents/concept-enhancer";
import { conceptVisualsPayload } from "@/lib/agents/concept-visuals";
import { variantExplorerAgent } from "@/lib/agents/canvas-agents";
import { uploadsAsDataUrls } from "@/lib/media/data-url";
import { conceptVisualsSchema } from "@/lib/schemas/agents";
import type { PlanningProvider, GenerateOptions } from "@/lib/agents/llm/provider";
import type { EnhanceConceptInput } from "@/lib/schemas/intake";
import type { Project } from "@/lib/schemas/project";

/**
 * Reference images reaching the two places that decide a story.
 *
 * Until now they only ever reached agents that decide how the film looks, so a
 * picture could change the palette and never the premise. The concept helper
 * writes the concept itself, and the Variant Explorer proposes the directions
 * to choose between — those are where a photograph can shape what happens.
 */

const input: EnhanceConceptInput = {
  concept: "A lighthouse keeper befriends a storm.",
  requestedDurationSeconds: 60,
  style: "cinematic",
  tone: "inspirational",
  audience: "general audience",
  creativeMode: "film_short",
};

type Seen = { system?: string; options?: GenerateOptions };

function recordingProvider(concept: string, seen: Seen) {
  return {
    name: "fake",
    generateJson: async () => null,
    generate: async (system: string, _user: string, _schema: unknown, options?: GenerateOptions) => {
      seen.system = system;
      seen.options = options;
      return { ok: true as const, value: { concept }, provider: "fake" };
    },
  } as unknown as PlanningProvider;
}

const EXPANDED =
  "A solitary lighthouse keeper discovers that the storm circling his island answers the beam " +
  "he tends each night. He tests the connection as the sea rises, drawing the gale away from a " +
  "fishing boat and dangerously close to his own tower, and must choose which to save before " +
  "the light fails and the decision is made for him by the water.";

describe("the concept helper reading reference images", () => {
  it("sends the pictures with the call", async () => {
    const seen: Seen = {};
    const images = ["data:image/png;base64,AAAA", "data:image/png;base64,BBBB"];

    await enhanceConcept(input, recordingProvider(EXPANDED, seen), images);

    expect(seen.options?.images).toEqual(images);
  });

  /**
   * The discipline QC and the Concept Reader both record: a prompt that says
   * "the attached images show" when nothing was attached does not produce an
   * empty answer, it produces an invented one.
   */
  it("only claims images are attached when some are", async () => {
    const withImages: Seen = {};
    await enhanceConcept(input, recordingProvider(EXPANDED, withImages), [
      "data:image/png;base64,AAAA",
    ]);
    expect(withImages.system).toContain(CONCEPT_ENHANCER_VISUAL);

    const without: Seen = {};
    await enhanceConcept(input, recordingProvider(EXPANDED, without));
    expect(without.system).toBe(CONCEPT_ENHANCER_SYSTEM);
    expect(without.system).not.toContain("REFERENCE IMAGES");
    expect(without.options).toBeUndefined();
  });

  it("keeps the whole text brief when it adds the visual one", async () => {
    const seen: Seen = {};
    await enhanceConcept(input, recordingProvider(EXPANDED, seen), ["data:image/png;base64,AAAA"]);

    // The visual block is an addition, never a replacement — everything that
    // stops the expansion sanitising or contradicting the premise lives in the
    // text prompt.
    expect(seen.system).toContain(CONCEPT_ENHANCER_SYSTEM);
  });

  /** The typed note still leads, exactly as it does everywhere else. */
  it("tells the model the note outranks the pictures", () => {
    expect(CONCEPT_ENHANCER_VISUAL).toContain("The typed note still leads");
  });

  it("still returns the expansion", async () => {
    const result = await enhanceConcept(input, recordingProvider(EXPANDED, {}), [
      "data:image/png;base64,AAAA",
    ]);
    expect(result).toEqual({ ok: true, concept: EXPANDED });
  });
});

const project = { id: "p1", concept: "A lighthouse keeper.", style: "cinematic", tone: "tense" } as Project;

const visuals = conceptVisualsSchema.parse({
  projectId: "p1",
  setting: "A basalt shoreline under a low sky.",
  subjects: [],
  palette: ["slate", "brine green"],
  lighting: "Flat storm light.",
  wardrobe: [],
  mood: "Isolated.",
  notableDetails: ["a wrecked jetty"],
  contradictions: [],
  sources: ["concept-0.png"],
  fromImages: true,
});

describe("the Variant Explorer reading reference images", () => {
  it("is given the reference reading", async () => {
    let user = "";
    let system = "";
    const provider = {
      name: "fake",
      generateJson: async () => null,
      generate: async (s: string, u: string) => {
        system = s;
        user = u;
        return { ok: false as const, reason: "timeout", provider: "fake" };
      },
    } as unknown as PlanningProvider;

    await variantExplorerAgent(project, provider, { conceptVisuals: visuals });

    expect(JSON.parse(user).conceptVisuals).toEqual(conceptVisualsPayload(visuals));
    expect(system).toContain("REFERENCE LOOK");
  });

  it("says nothing about a reference when there is none", async () => {
    let user = "";
    let system = "";
    const provider = {
      name: "fake",
      generateJson: async () => null,
      generate: async (s: string, u: string) => {
        system = s;
        user = u;
        return { ok: false as const, reason: "timeout", provider: "fake" };
      },
    } as unknown as PlanningProvider;

    await variantExplorerAgent(project, provider, {});

    expect(JSON.parse(user).conceptVisuals).toBeUndefined();
    expect(system).not.toContain("REFERENCE LOOK");
  });
});

/**
 * The helper's images never reach disk, so nothing downstream re-validates
 * them. What it accepts is what gets base64'd into a prompt.
 */
describe("encoding an upload that never reaches disk", () => {
  /** jsdom's File lacks arrayBuffer(); the encoder needs only these three. */
  function upload(type: string, size = 4, name = "a.png"): File {
    const bytes = new Uint8Array(size);
    return {
      name,
      type,
      size: bytes.byteLength,
      arrayBuffer: async () => bytes.buffer,
    } as unknown as File;
  }

  it("encodes an accepted image as a data URL", async () => {
    const urls = await uploadsAsDataUrls([upload("image/png")], "test");
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/^data:image\/png;base64,/);
  });

  it("refuses a type that is not on the allowlist", async () => {
    expect(await uploadsAsDataUrls([upload("application/pdf")], "test")).toEqual([]);
    expect(await uploadsAsDataUrls([upload("text/html")], "test")).toEqual([]);
  });

  /** A local vision model turns pixels into tokens; an oversized frame can cost
   * more prompt budget than the answer is worth. */
  it("skips an image past the size cap", async () => {
    expect(await uploadsAsDataUrls([upload("image/png", 7 * 1024 * 1024)], "test")).toEqual([]);
  });

  it("skips the bad one and keeps the rest", async () => {
    const urls = await uploadsAsDataUrls(
      [upload("image/png"), upload("application/pdf"), upload("image/jpeg")],
      "test",
    );
    expect(urls).toHaveLength(2);
  });
});
