// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/concept/enhance/route";
import {
  getPlanningProvider,
  visionAvailable,
  visionIsSeparateModel,
  type GenerateOptions,
  type PlanningProvider,
} from "@/lib/agents/llm/provider";
import { CONCEPT_FROM_IMAGES_SYSTEM, REFERENCE_READER_SYSTEM } from "@/lib/agents/concept-enhancer";

vi.mock("@/lib/agents/llm/provider", async (original) => ({
  ...(await original<typeof import("@/lib/agents/llm/provider")>()),
  getPlanningProvider: vi.fn(() => null),
  visionAvailable: vi.fn(() => true),
  visionIsSeparateModel: vi.fn(async () => false),
}));

const STORY =
  "A diver surfaces beside a rusted trawler at dusk and finds its deck lights still burning. " +
  "She climbs aboard to switch them off before the tide turns, follows the cables below deck, " +
  "and discovers the generator was restarted by someone still aboard. By full dark the trawler " +
  "is drifting toward the harbour wall with both of them on it.";

type Seen = { system?: string; options?: GenerateOptions };

function provider(seen: Seen): PlanningProvider {
  return {
    name: "fake",
    generateJson: async () => null,
    generate: async (system: string, _user: string, _schema: unknown, options?: GenerateOptions) => {
      seen.system = system;
      seen.options = options;
      return { ok: true as const, value: { concept: STORY }, provider: "fake" };
    },
  } as unknown as PlanningProvider;
}

function request(concept: string, images = 0): Request {
  const form = new FormData();
  form.append("concept", concept);
  form.append("requestedDurationSeconds", "60");
  for (let i = 0; i < images; i++) {
    form.append("images", new File([new Uint8Array(4)], `ref-${i}.png`, { type: "image/png" }));
  }
  return new Request("http://localhost/api/concept/enhance", { method: "POST", body: form });
}

describe("POST /api/concept/enhance with a blank concept", () => {
  let seen: Seen;

  beforeEach(() => {
    seen = {};
    vi.mocked(getPlanningProvider).mockReturnValue(provider(seen));
    vi.mocked(visionAvailable).mockReturnValue(true);
    vi.mocked(visionIsSeparateModel).mockResolvedValue(false);
  });

  it("writes a concept from the attached images alone", async () => {
    const res = await POST(request("", 2));
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      concept: STORY,
      imagesRead: 2,
      imagesSupplied: 2,
      fromImagesOnly: true,
      readFirst: false,
    });
    expect(seen.system).toBe(CONCEPT_FROM_IMAGES_SYSTEM);
    expect(seen.options?.images).toHaveLength(2);
  });

  /** A small vision model reads; the planning model writes. */
  it("reads first when the vision model is not the planning model", async () => {
    vi.mocked(visionIsSeparateModel).mockResolvedValue(true);
    const calls: string[] = [];
    vi.mocked(getPlanningProvider).mockReturnValue({
      name: "fake",
      generateJson: async () => null,
      generate: async (system: string) => {
        calls.push(system);
        return {
          ok: true as const,
          value: system === REFERENCE_READER_SYSTEM ? { reading: "Picture 1: a trawler." } : { concept: STORY },
          provider: "fake",
        };
      },
    } as unknown as PlanningProvider);

    const res = await POST(request("", 2));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ concept: STORY, readFirst: true });
    expect(calls).toEqual([REFERENCE_READER_SYSTEM, expect.stringContaining(CONCEPT_FROM_IMAGES_SYSTEM)]);
  });

  it("refuses a blank concept with no images", async () => {
    const res = await POST(request(""));

    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/attach reference images/);
    expect(seen.system).toBeUndefined();
  });

  /** Answering from nothing would read as though the pictures had been seen. */
  it("refuses rather than inventing when no vision model can read the images", async () => {
    vi.mocked(visionAvailable).mockReturnValue(false);
    const res = await POST(request("", 2));

    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/needs a vision model/);
    expect(seen.system).toBeUndefined();
  });
});
