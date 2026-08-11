import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * The character record is assembled field by field on create and update, so a
 * new field reaches the store only when both are told about it. `faceSwapPrompt`
 * shipped without that and was accepted by the schema, sent by the form, and
 * dropped in the service — saving looked like it worked and changed nothing.
 */
const dirs: string[] = [];

async function isolated() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "storyforge-charfields-"));
  dirs.push(dir);
  process.env.STORYFORGE_DATA_DIR = dir;
  vi.resetModules();
  return import("@/lib/services/character-service");
}

afterEach(async () => {
  delete process.env.STORYFORGE_DATA_DIR;
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("a character's face-swap prompt", () => {
  it("survives creation", async () => {
    const characters = await isolated();
    const created = await characters.createCharacter({
      name: "Jaime",
      description: "A man in his fifties.",
      faceSwap: true,
      faceSwapPrompt: "swap the man",
    });

    expect(created.faceSwapPrompt).toBe("swap the man");
    expect((await characters.getCharacter(created.id)).faceSwapPrompt).toBe("swap the man");
  });

  it("survives an edit", async () => {
    const characters = await isolated();
    const created = await characters.createCharacter({
      name: "Jaime",
      description: "A man in his fifties.",
      faceSwap: true,
    });

    const updated = await characters.updateCharacter(created.id, {
      faceSwapPrompt: "swap the man on the left",
    });

    expect(updated.faceSwapPrompt).toBe("swap the man on the left");
    expect((await characters.getCharacter(created.id)).faceSwapPrompt).toBe(
      "swap the man on the left",
    );
  });

  it("keeps the stored prompt when an edit does not mention it", async () => {
    const characters = await isolated();
    const created = await characters.createCharacter({
      name: "Jaime",
      description: "A man in his fifties.",
      faceSwap: true,
      faceSwapPrompt: "swap the man",
    });

    const updated = await characters.updateCharacter(created.id, { name: "Jaime R" });

    expect(updated.faceSwapPrompt).toBe("swap the man");
  });

  /** Clearing the box is how a character goes back to the preset wording. */
  it("falls back to the default when cleared", async () => {
    const characters = await isolated();
    const created = await characters.createCharacter({
      name: "Jaime",
      description: "A man in his fifties.",
      faceSwap: true,
      faceSwapPrompt: "swap the man",
    });

    const updated = await characters.updateCharacter(created.id, { faceSwapPrompt: "   " });

    expect(updated.faceSwapPrompt).toBeUndefined();
  });
});
