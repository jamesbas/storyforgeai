import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Wardrobe belongs to the project, not the character.
 *
 * The same person appears in unrelated stories wearing different clothes, so a
 * costume pinned to the library record would be wrong the moment a second
 * project used them. The library value is only a fallback for a signature look.
 */

const dirs: string[] = [];

async function libraryInTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "storyforge-wardrobe-"));
  dirs.push(dir);
  process.env.STORYFORGE_DATA_DIR = dir;
  return import("@/lib/services/character-service");
}

beforeEach(async () => {
  const { vi } = await import("vitest");
  vi.resetModules();
});

afterEach(async () => {
  delete process.env.STORYFORGE_DATA_DIR;
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("project wardrobe overrides", () => {
  it("uses the project's wardrobe in preference to the library default", async () => {
    const service = await libraryInTempDir();
    const character = await service.createCharacter({
      name: "Elena",
      description: "A woman in her mid-thirties with dark curly hair.",
      wardrobe: "a red raincoat",
    });

    const cast = await service.resolveProjectCast({
      useCharacterLibrary: true,
      characterIds: [character.id],
      characterWardrobe: { [character.id]: "a charcoal wool overcoat" },
    });

    expect(cast[0]!.wardrobe).toBe("a charcoal wool overcoat");
  });

  it("falls back to the library default when the project says nothing", async () => {
    const service = await libraryInTempDir();
    const character = await service.createCharacter({
      name: "Elena",
      description: "A woman in her mid-thirties with dark curly hair.",
      wardrobe: "a red raincoat",
    });

    const cast = await service.resolveProjectCast({
      useCharacterLibrary: true,
      characterIds: [character.id],
    });

    expect(cast[0]!.wardrobe).toBe("a red raincoat");
  });

  it("leaves wardrobe unset when neither specifies one", async () => {
    const service = await libraryInTempDir();
    const character = await service.createCharacter({
      name: "Elena",
      description: "A woman in her mid-thirties with dark curly hair.",
    });

    const cast = await service.resolveProjectCast({
      useCharacterLibrary: true,
      characterIds: [character.id],
      characterWardrobe: { [character.id]: "   " },
    });

    // Whitespace is not a costume.
    expect(cast[0]!.wardrobe).toBeUndefined();
  });

  it("does not leak one project's wardrobe into another", async () => {
    const service = await libraryInTempDir();
    const character = await service.createCharacter({
      name: "Elena",
      description: "A woman in her mid-thirties with dark curly hair.",
    });

    const thriller = await service.resolveProjectCast({
      useCharacterLibrary: true,
      characterIds: [character.id],
      characterWardrobe: { [character.id]: "a charcoal wool overcoat" },
    });
    const beachShort = await service.resolveProjectCast({
      useCharacterLibrary: true,
      characterIds: [character.id],
      characterWardrobe: { [character.id]: "a linen sundress" },
    });

    expect(thriller[0]!.wardrobe).toBe("a charcoal wool overcoat");
    expect(beachShort[0]!.wardrobe).toBe("a linen sundress");
  });
});
