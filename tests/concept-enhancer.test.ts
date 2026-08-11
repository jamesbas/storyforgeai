import { describe, expect, it } from "vitest";
import { CONCEPT_ENHANCER_SYSTEM, enhanceConcept } from "@/lib/agents/concept-enhancer";
import type { PlanningProvider } from "@/lib/agents/llm/provider";
import type { EnhanceConceptInput } from "@/lib/schemas/intake";

const input: EnhanceConceptInput = {
  concept: "A lighthouse keeper befriends a storm.",
  requestedDurationSeconds: 60,
  style: "cinematic",
  tone: "inspirational",
  audience: "general audience",
  creativeMode: "film_short",
};

type Seen = { system?: string; user?: string };

type FakeResult =
  | { ok: true; value: { concept: string } }
  | { ok: false; reason: string; detail?: string };

/** Captures what the agent sent, and answers with whatever the test wants. */
function fakeProvider(result: FakeResult, seen: Seen = {}) {
  return {
    name: "fake",
    generateJson: async () => null,
    generate: async (system: string, user: string) => {
      seen.system = system;
      seen.user = user;
      return { ...result, provider: "fake" };
    },
  } as unknown as PlanningProvider;
}

const ok = (concept: string): FakeResult => ({ ok: true, value: { concept } });

describe("enhanceConcept", () => {
  it("returns the rewritten concept", async () => {
    const provider = fakeProvider(ok("  A keeper tends a light through a rising gale.  "));
    await expect(enhanceConcept(input, provider)).resolves.toEqual({
      ok: true,
      concept: "A keeper tends a light through a rising gale.",
    });
  });

  /**
   * The screen used to say only that nothing came back, which is the same
   * message whether the server is down or the schema is wrong.
   */
  it("reports why the provider failed rather than collapsing to nothing", async () => {
    const provider = fakeProvider({
      ok: false,
      reason: "request_failed",
      detail: "400 failed to parse grammar",
    });
    const result = await enhanceConcept(input, provider);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/rejected the request/);
    expect(result.ok === false && result.reason).toMatch(/parse grammar/);
  });

  it("names a timeout as a timeout", async () => {
    const result = await enhanceConcept(input, fakeProvider({ ok: false, reason: "timeout" }));
    expect(result.ok === false && result.reason).toMatch(/timed out/);
  });

  it("returns a reason when the answer is empty", async () => {
    const result = await enhanceConcept(input, fakeProvider(ok("   ")));
    expect(result.ok === false && result.reason).toMatch(/empty/);
  });

  /**
   * Offering the writer their own sentence back invites them to accept a no-op
   * and conclude the feature did something.
   */
  it("returns a reason when the model echoes the input", async () => {
    const result = await enhanceConcept(input, fakeProvider(ok(`  ${input.concept}  `)));
    expect(result.ok === false && result.reason).toMatch(/unchanged/);
  });

  it("sends the settings that constrain the rewrite", async () => {
    const seen: Seen = {};
    await enhanceConcept(input, fakeProvider(ok("Expanded."), seen));
    const payload = JSON.parse(seen.user!) as Record<string, unknown>;

    expect(payload).toMatchObject({
      concept: input.concept,
      runningTimeSeconds: 60,
      style: "cinematic",
      tone: "inspirational",
      audience: "general audience",
      creativeMode: "film_short",
    });
  });

  it("omits audience when the form left it blank", async () => {
    const seen: Seen = {};
    const { audience: _audience, ...withoutAudience } = input;
    await enhanceConcept(withoutAudience, fakeProvider(ok("Expanded."), seen));

    expect(JSON.parse(seen.user!)).not.toHaveProperty("audience");
  });
});

describe("CONCEPT_ENHANCER_SYSTEM", () => {
  /**
   * The prohibitions are the load-bearing half: without them the model invents
   * names and camera direction that override decisions later stages own.
   */
  it("forbids inventing detail and writing craft direction", () => {
    expect(CONCEPT_ENHANCER_SYSTEM).toMatch(/Do not introduce named people/);
    expect(CONCEPT_ENHANCER_SYSTEM).toMatch(/No shot lists, camera moves/);
    expect(CONCEPT_ENHANCER_SYSTEM).toMatch(/Never contradict the premise/);
  });

  it("asks for prose in the JSON envelope the provider parses", () => {
    expect(CONCEPT_ENHANCER_SYSTEM).toMatch(/"concept"/);
    expect(CONCEPT_ENHANCER_SYSTEM).toMatch(/No headings, no bullet/);
  });
});
