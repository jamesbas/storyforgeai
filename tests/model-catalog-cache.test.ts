import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LiveWangpClient } from "@/lib/wangp/live-client";

/**
 * The catalogue was cached for the life of the process.
 *
 * Availability is not static: it flips the moment WanGP finishes fetching a
 * model's weights. A model downloaded while StoryForgeAI was running therefore
 * stayed "not installed" in every picker until the app was restarted, with
 * WanGP reporting it available the whole time — observed live on
 * `krea2_raw_edit` after a successful render in Wan2GP.
 */

type FakeTransport = { call: (name: string, args?: unknown) => Promise<unknown> };

function clientWith(availability: () => string) {
  const client = new LiveWangpClient("http://127.0.0.1:1/mcp");
  let calls = 0;
  const transport: FakeTransport = {
    call: async () => {
      calls += 1;
      return [
        {
          model_type: "krea2_raw_edit",
          name: "Krea 2 RAW Identity Edit v1.2",
          main_output: "image",
          media_inputs: { image: { reference: true } },
          availability: { status: availability() },
        },
      ];
    },
  };
  (client as unknown as { transport: FakeTransport }).transport = transport;
  return { client, calls: () => calls };
}

const availabilityOf = async (client: LiveWangpClient) =>
  (await client.listModels("image"))[0]?.metadata.availability;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-16T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("how long a model catalogue stays good", () => {
  it("answers from cache inside the window", async () => {
    const { client, calls } = clientWith(() => "available");

    await client.listModels("image");
    await client.listModels();
    vi.setSystemTime(new Date("2026-08-16T12:00:30Z"));
    await client.listModels("image");

    expect(calls()).toBe(1);
  });

  /** The defect: a model finishes downloading and the picker never notices. */
  it("notices a model that finished downloading", async () => {
    let status = "missing";
    const { client, calls } = clientWith(() => status);

    expect(await availabilityOf(client)).toBe("missing");

    status = "available";
    vi.setSystemTime(new Date("2026-08-16T12:01:01Z"));

    expect(await availabilityOf(client)).toBe("available");
    expect(calls()).toBe(2);
  });

  it("refetches immediately when asked to", async () => {
    let status = "missing";
    const { client, calls } = clientWith(() => status);

    await client.listModels("image");
    status = "available";
    client.resetModelCache();

    expect(await availabilityOf(client)).toBe("available");
    expect(calls()).toBe(2);
  });
});
