import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * A character's voice recording (SPEC-012).
 *
 * Stored like a reference photograph: a generated filename, an allowlist chosen
 * by MIME type, and a resolver that cannot be walked out of its directory. The
 * length check exists because WanGP refuses a reference under two seconds, and
 * finding that out at render time can fail a batch hours in.
 */

const dirs: string[] = [];

/** What ffprobe "measures" for the next upload; null is ffprobe being unavailable. */
const probe: { seconds: number | null } = { seconds: 6 };

async function isolated() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "storyforge-voice-"));
  dirs.push(dir);
  process.env.STORYFORGE_DATA_DIR = dir;
  vi.resetModules();
  vi.doMock("@/lib/media/ffmpeg", async (original) => ({
    ...(await original<typeof import("@/lib/media/ffmpeg")>()),
    probeDurationSeconds: vi.fn(async () => probe.seconds),
  }));

  const characters = await import("@/lib/services/character-service");
  const store = await import("@/lib/db/character-store");
  const character = await characters.createCharacter({
    name: "Marcus",
    description: "A man in his forties.",
    faceSwap: false,
  });
  return { characters, store, character };
}

afterEach(async () => {
  probe.seconds = 6;
  vi.doUnmock("@/lib/media/ffmpeg");
  delete process.env.STORYFORGE_DATA_DIR;
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function audioFile(type: string, size?: number) {
  const bytes = Buffer.from("not decoded by these tests");
  return {
    name: "voice",
    type,
    size: size ?? bytes.byteLength,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as File;
}

const exists = (filePath: string | null) =>
  filePath ? fs.stat(filePath).then(() => true, () => false) : Promise.resolve(false);

describe("storing a voice recording", () => {
  it("keeps a WAV under a generated name and records its length", async () => {
    const { characters, store, character } = await isolated();
    probe.seconds = 6.5;

    const updated = await characters.setVoiceSample(character.id, audioFile("audio/wav"));

    expect(updated.voiceSample).toBe(`${character.id}-voice.wav`);
    expect(updated.voiceSampleSeconds).toBe(6.5);
    expect(await exists(store.resolveVoiceSamplePath(updated.voiceSample!))).toBe(true);
  });

  it("refuses a format WanGP's H3 pipeline cannot read", async () => {
    const { characters, character } = await isolated();
    await expect(characters.setVoiceSample(character.id, audioFile("audio/mp4"))).rejects.toThrow(
      /WAV, FLAC, MP3 or OGG/,
    );
  });

  it("refuses a recording over the size cap", async () => {
    const { characters, character } = await isolated();
    const huge = audioFile("audio/mpeg", 21 * 1024 * 1024);
    await expect(characters.setVoiceSample(character.id, huge)).rejects.toThrow(/20 MB/);
  });

  it("refuses a recording shorter than WanGP accepts, and keeps the one already stored", async () => {
    const { characters, store, character } = await isolated();
    const kept = await characters.setVoiceSample(character.id, audioFile("audio/wav"));

    probe.seconds = 1.2;
    await expect(characters.setVoiceSample(character.id, audioFile("audio/wav"))).rejects.toThrow(
      /at least 2 seconds/,
    );

    const after = await characters.getCharacter(character.id);
    expect(after.voiceSample).toBe(kept.voiceSample);
    expect(after.voiceSampleSeconds).toBe(6);
    expect(await exists(store.resolveVoiceSamplePath(kept.voiceSample!))).toBe(true);
  });

  it("accepts a recording longer than H3 uses, since H3 trims it itself", async () => {
    const { characters, character } = await isolated();
    probe.seconds = 42;
    const updated = await characters.setVoiceSample(character.id, audioFile("audio/flac"));
    expect(updated.voiceSampleSeconds).toBe(42);
  });

  it("accepts a recording whose length cannot be measured", async () => {
    const { characters, character } = await isolated();
    probe.seconds = null;
    const updated = await characters.setVoiceSample(character.id, audioFile("audio/ogg"));
    expect(updated.voiceSample).toMatch(/\.ogg$/);
    expect(updated.voiceSampleSeconds).toBeUndefined();
  });

  it("removes the previous file when a replacement arrives in another format", async () => {
    const { characters, store, character } = await isolated();
    const first = await characters.setVoiceSample(character.id, audioFile("audio/wav"));
    const second = await characters.setVoiceSample(character.id, audioFile("audio/mpeg"));

    expect(second.voiceSample).toMatch(/\.mp3$/);
    expect(await exists(store.resolveVoiceSamplePath(first.voiceSample!))).toBe(false);
    expect(await exists(store.resolveVoiceSamplePath(second.voiceSample!))).toBe(true);
  });

  it("deletes the file when the recording is removed, or the character is", async () => {
    const { characters, store, character } = await isolated();
    const first = await characters.setVoiceSample(character.id, audioFile("audio/wav"));
    const cleared = await characters.clearVoiceSample(character.id);
    expect(cleared.voiceSample).toBeUndefined();
    expect(await exists(store.resolveVoiceSamplePath(first.voiceSample!))).toBe(false);

    const again = await characters.setVoiceSample(character.id, audioFile("audio/wav"));
    await characters.deleteCharacter(character.id);
    expect(await exists(store.resolveVoiceSamplePath(again.voiceSample!))).toBe(false);
  });

  it("will not resolve a stored name outside the voice directory", async () => {
    const { store } = await isolated();
    expect(store.resolveVoiceSamplePath("../characters.json")).toBeNull();
    expect(store.resolveVoiceSamplePath(path.join("..", "..", "secrets.txt"))).toBeNull();
  });
});
