import { describe, it, expect, afterEach, afterAll, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Concept images: what gets stored, and what gets read from them.
 *
 * The storage rules matter because the uploads are the one place in the app
 * where client-supplied bytes and names reach the disk. The reading rules
 * matter because the provider drops images when no vision model is configured,
 * and a prompt saying "the attached images show" would then produce an invented
 * answer indistinguishable from a real one.
 */

const dirs: string[] = [];
let dataDir: string | null = null;

/**
 * One temp directory for this whole file.
 *
 * The repository is a `globalThis` singleton that survives `vi.resetModules()`,
 * so it stays bound to whatever data directory was set when the first test
 * imported it. Giving each test its own directory would leave project records
 * in the first one and image files in the current one — which reads as a bug in
 * whatever is being tested. A directory per *file* is still enough isolation,
 * since the point is not to collide with other test files.
 */
async function isolated(env: Record<string, string> = {}) {
  if (!dataDir) {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "storyforge-concept-"));
    dirs.push(dataDir);
  }
  process.env.STORYFORGE_DATA_DIR = dataDir;
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  vi.resetModules();

  const projects = await import("@/lib/services/project-service");
  const conceptImages = await import("@/lib/services/concept-image-service");
  const { MockWangpClient } = await import("@/lib/wangp/mock-client");
  const { setWangpClient } = await import("@/lib/wangp/factory");
  setWangpClient(new MockWangpClient());
  return { dir: dataDir, projects, conceptImages };
}

afterEach(async () => {
  delete process.env.OPENAI_VISION_MODEL;
});

afterAll(async () => {
  delete process.env.STORYFORGE_DATA_DIR;
  dataDir = null;
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** The node test env's File has no arrayBuffer(); the upload path needs three fields. */
function upload(type: string, bytes = new Uint8Array([1, 2, 3, 4]), name = "photo.txt"): File {
  return {
    name,
    type,
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.buffer.slice(0),
  } as unknown as File;
}

async function draft(projects: typeof import("@/lib/services/project-service")) {
  return projects.createProject({
    concept: "Four men play cards in a back room.",
    style: "cinematic",
    tone: "tense",
    audience: "adults",
    requestedDurationSeconds: 10,
    segmentSeconds: 5,
  });
}

describe("concept image storage", () => {
  it("rejects a type outside the allowlist", async () => {
    const { projects, conceptImages } = await isolated();
    const project = await draft(projects);
    await expect(
      conceptImages.addConceptImage(project.id, upload("application/pdf")),
    ).rejects.toThrow(/png|jpe?g|webp|gif|image/i);
  });

  it("rejects a file over the size cap", async () => {
    const { projects, conceptImages } = await isolated();
    const project = await draft(projects);
    const huge = new Uint8Array(9 * 1024 * 1024);
    await expect(conceptImages.addConceptImage(project.id, upload("image/png", huge))).rejects.toThrow(
      /large|size|8/i,
    );
  });

  it("rejects an empty file", async () => {
    const { projects, conceptImages } = await isolated();
    const project = await draft(projects);
    await expect(
      conceptImages.addConceptImage(project.id, upload("image/png", new Uint8Array(0))),
    ).rejects.toThrow(/empty/i);
  });

  it("stops at the count ceiling", async () => {
    const { projects, conceptImages } = await isolated();
    const project = await draft(projects);
    for (let i = 0; i < conceptImages.MAX_CONCEPT_IMAGES; i += 1) {
      await conceptImages.addConceptImage(project.id, upload("image/png"));
    }
    await expect(conceptImages.addConceptImage(project.id, upload("image/png"))).rejects.toThrow(
      /most|limit|remove/i,
    );
  });

  it("takes the extension from the MIME type, not the filename", async () => {
    const { projects, conceptImages } = await isolated();
    const project = await draft(projects);
    // A ".png" name on a JPEG body is the ordinary case; a ".html" name on an
    // image body is the interesting one, since the extension decides what the
    // browser is later told the bytes are.
    const stored = await conceptImages.addConceptImage(
      project.id,
      upload("image/jpeg", new Uint8Array([1, 2, 3]), "payload.html"),
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatch(/\.jpg$/);
    expect(stored[0]).not.toContain("payload");
    expect(conceptImages.conceptImageContentType(stored[0])).toBe("image/jpeg");
  });

  it("refuses a path that escapes the project folder", async () => {
    const { projects, conceptImages } = await isolated();
    const project = await draft(projects);
    expect(conceptImages.conceptImagePath(project.id, "../../secrets.env")).toBeNull();
    expect(conceptImages.conceptImagePath(project.id, "concept-1.png")).not.toBeNull();
  });

  it("removes the file from disk as well as the record", async () => {
    const { projects, conceptImages } = await isolated();
    const project = await draft(projects);
    const stored = await conceptImages.addConceptImage(project.id, upload("image/png"));
    const onDisk = conceptImages.conceptImagePath(project.id, stored[0])!;
    expect(await fs.access(onDisk).then(() => true)).toBe(true);

    const left = await conceptImages.removeConceptImage(project.id, stored[0]);
    expect(left).toEqual([]);
    expect(await fs.access(onDisk).then(() => true).catch(() => false)).toBe(false);
  });

  it("deleting the project takes the concept images with it", async () => {
    const { projects, conceptImages } = await isolated();
    const project = await draft(projects);
    const stored = await conceptImages.addConceptImage(project.id, upload("image/png"));
    const onDisk = conceptImages.conceptImagePath(project.id, stored[0])!;

    await projects.deleteProject(project.id);
    expect(await fs.access(onDisk).then(() => true).catch(() => false)).toBe(false);
  });

  it("duplicating a project copies the image bytes, not just the names", async () => {
    const { projects, conceptImages } = await isolated();
    const project = await draft(projects);
    const stored = await conceptImages.addConceptImage(project.id, upload("image/png"));

    const copy = await projects.duplicateProject(project.id);
    expect(copy.conceptImages).toEqual(stored);
    // The folder is keyed by project id, so a name that carried over without
    // its bytes would leave the copy's thumbnails broken and silent.
    const files = await conceptImages.conceptImageFiles(copy.id);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain(copy.id);
  });

  it("importing a record clears the names, since no bytes travel in JSON", async () => {
    const { projects, conceptImages } = await isolated();
    const project = await draft(projects);
    await conceptImages.addConceptImage(project.id, upload("image/png"));
    const record = await projects.getProjectRecord(project.id);

    const outcome = await projects.importProject(JSON.parse(JSON.stringify(record)));
    expect(outcome.project.conceptImages).toBeUndefined();
    expect(await conceptImages.conceptImageFiles(outcome.project.id)).toEqual([]);
  });
});

describe("concept reader", () => {
  it("builds a deterministic reading with no provider", async () => {
    await isolated();
    const { buildConceptVisuals } = await import("@/lib/agents/concept-reader");
    const { conceptReaderAgent } = await import("@/lib/agents/concept-reader");
    const projects = await import("@/lib/services/project-service");
    const project = await draft(projects);

    const built = buildConceptVisuals(project);
    expect(built.projectId).toBe(project.id);
    expect(built.fromImages).toBe(false);
    expect(built.contradictions).toEqual([]);

    // A missing provider must not be an error: the whole pipeline runs without one.
    await expect(conceptReaderAgent(project, ["/nope.png"], null)).resolves.toEqual(built);
  });

  it("uses the text prompt and sends nothing when no vision model is configured", async () => {
    delete process.env.OPENAI_VISION_MODEL;
    const { projects } = await isolated();
    const { conceptReaderAgent, CONCEPT_READER_TEXT_SYSTEM } = await import(
      "@/lib/agents/concept-reader"
    );
    const project = await draft(projects);

    const generateJson = vi.fn(async () => ({
      projectId: "ignored",
      setting: "A back room.",
      subjects: [],
      palette: [],
      lighting: "Overhead lamp.",
      wardrobe: [],
      mood: "Tense.",
      notableDetails: [],
      contradictions: [],
      fromImages: true,
    }));

    const result = await conceptReaderAgent(project, ["/a.png"], {
      generateJson,
    } as never);

    const [system, , , options] = generateJson.mock.calls[0] as unknown as [
      string,
      string,
      unknown,
      { images?: string[] },
    ];
    expect(system).toBe(CONCEPT_READER_TEXT_SYSTEM);
    expect(options?.images ?? []).toEqual([]);
    // The model claimed it saw the images; it did not, and the flag is ours.
    expect(result.fromImages).toBe(false);
    expect(result.projectId).toBe(project.id);
  });

  it("uses the visual prompt and attaches data URLs when a vision model is set", async () => {
    // Set before the imports: `config` reads the environment once at load.
    const { projects, conceptImages } = await isolated({ OPENAI_VISION_MODEL: "qwen-vl" });
    const { conceptReaderAgent, CONCEPT_READER_VISUAL_SYSTEM } = await import(
      "@/lib/agents/concept-reader"
    );
    const project = await draft(projects);
    await conceptImages.addConceptImage(project.id, upload("image/png"));
    const paths = await conceptImages.conceptImageFiles(project.id);

    const generateJson = vi.fn(async () => ({
      projectId: "ignored",
      setting: "A back room with a felt table.",
      subjects: ["Four men"],
      palette: ["#1a1a1a"],
      lighting: "One low lamp.",
      wardrobe: ["Shirtsleeves"],
      mood: "Tense.",
      notableDetails: [],
      contradictions: ["Concept says morning; the image is night."],
      fromImages: false,
    }));

    const result = await conceptReaderAgent(project, paths, { generateJson } as never);

    const [system, , , options] = generateJson.mock.calls[0] as unknown as [
      string,
      string,
      unknown,
      { images?: string[] },
    ];
    expect(system).toBe(CONCEPT_READER_VISUAL_SYSTEM);
    expect(options.images).toHaveLength(1);
    expect(options.images![0]).toMatch(/^data:image\/png;base64,/);
    expect(result.fromImages).toBe(true);
    expect(result.contradictions).toHaveLength(1);
  });
});
