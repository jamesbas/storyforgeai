import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Serialization of planning calls.
 *
 * A local model serves one request at a time, so overlapping structured-output
 * calls are slower at best and exhaust VRAM at worst. Nothing surfaces when this
 * regresses — the calls simply interleave and the machine struggles — so the
 * ordering is pinned explicitly rather than left to observation.
 */

/** Load the module fresh with a given environment. */
async function loadProvider(env: Record<string, string>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  return import("@/lib/agents/llm/provider");
}

/** A task that records whether it ever overlapped another. */
function probe() {
  let inFlight = 0;
  let maxInFlight = 0;
  const order: string[] = [];

  const task = (label: string) => async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    order.push(`${label}:start`);
    await new Promise((r) => setTimeout(r, 5));
    order.push(`${label}:end`);
    inFlight -= 1;
    return label;
  };

  return { task, order, peak: () => maxInFlight };
}

beforeEach(() => {
  delete (globalThis as { __storyforgePlanningQueue?: unknown }).__storyforgePlanningQueue;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const LOCAL = { OPENAI_BASE_URL: "http://127.0.0.1:1234/v1" };

describe("planning call serialization", () => {
  it("never overlaps two calls against a local server", async () => {
    const { enqueuePlanning } = await loadProvider(LOCAL);
    const { task, order, peak } = probe();

    await Promise.all([enqueuePlanning(task("a")), enqueuePlanning(task("b"))]);

    expect(peak()).toBe(1);
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("preserves submission order", async () => {
    const { enqueuePlanning } = await loadProvider(LOCAL);
    const { task, order } = probe();

    await Promise.all([
      enqueuePlanning(task("first")),
      enqueuePlanning(task("second")),
      enqueuePlanning(task("third")),
    ]);

    expect(order.filter((o) => o.endsWith(":start"))).toEqual([
      "first:start",
      "second:start",
      "third:start",
    ]);
  });

  /** One failed agent must not strand every call queued behind it. */
  it("keeps running after a call fails", async () => {
    const { enqueuePlanning } = await loadProvider(LOCAL);

    const failing = enqueuePlanning(async () => {
      throw new Error("model exploded");
    });
    const following = enqueuePlanning(async () => "survived");

    await expect(failing).rejects.toThrow("model exploded");
    await expect(following).resolves.toBe("survived");
  });

  it("returns each caller its own result", async () => {
    const { enqueuePlanning } = await loadProvider(LOCAL);
    const { task } = probe();

    const results = await Promise.all([
      enqueuePlanning(task("a")),
      enqueuePlanning(task("b")),
    ]);

    expect(results).toEqual(["a", "b"]);
  });

  /**
   * A hosted API has no single-session limit, and serializing there would slow
   * the per-scene prompt agents down for nothing.
   */
  it("allows concurrency when the provider is not local", async () => {
    const { enqueuePlanning } = await loadProvider({ OPENAI_BASE_URL: "" });
    const { task, peak } = probe();

    await Promise.all([enqueuePlanning(task("a")), enqueuePlanning(task("b"))]);

    expect(peak()).toBe(2);
  });
});

describe("provider construction", () => {
  it("is null when AI planning is disabled", async () => {
    const { getPlanningProvider } = await loadProvider({
      ...LOCAL,
      AI_PLANNING_ENABLED: "false",
    });
    expect(getPlanningProvider()).toBeNull();
  });

  it("is null without a key or a base url", async () => {
    const { getPlanningProvider } = await loadProvider({
      AI_PLANNING_ENABLED: "true",
      OPENAI_BASE_URL: "",
      OPENAI_API_KEY: "",
    });
    expect(getPlanningProvider()).toBeNull();
  });

  it("is created from a base url alone, which a local server needs no key for", async () => {
    const { getPlanningProvider } = await loadProvider({
      ...LOCAL,
      AI_PLANNING_ENABLED: "true",
      OPENAI_API_KEY: "",
    });
    expect(getPlanningProvider()?.name).toBe("openai-compatible");
  });
});
