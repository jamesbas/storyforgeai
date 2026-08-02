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
      conceptImages.addConceptImage(project.id, upload("application/pdf"), "reference"),
    ).rejects.toThrow(/png|jpe?g|webp|gif|image/i);
  });

  it("rejects a file over the size cap", async () => {
    const { projects, conceptImages } = await isolated();
    const project = await draft(projects);
    const huge = new Uint8Array(9 * 1024 * 1024);
    await expect(
      conceptImages.addConceptImage(project.id, upload("image/png", huge), "reference"),
    ).rejects.toThrow(/large|size|8/i);
  });

  it("rejects an empty file", async () => {
    const { projects, conceptImages } = await isolated();
    const project = await draft(projects);
    await expect(
      conceptImages.addConceptImage(project.id, upload("image/png", new Uint8Array(0)), "reference"),
    ).rejects.toThrow(/empty/i);
  });

  it("stops at the count ceiling", async () => {
    const { projects, conceptImages } = await isolated();
    const project = await draft(projects);
    for (let i = 0; i < conceptImages.MAX_CONCEPT_IMAGES; i += 1) {
      await conceptImages.addConceptImage(project.id, upload("image/png"), "reference");
    }
    await expect(
      conceptImages.addConceptImage(project.id, upload("image/png"), "reference"),
    ).rejects.toThrow(/most|limit|remove/i);
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
      "reference",
    );
    expect(stored).toHaveLength(1);
    expect(stored[0].name).toMatch(/\.jpg$/);
    expect(stored[0].name).not.toContain("payload");
    expect(conceptImages.conceptImageContentType(stored[0].name)).toBe("image/jpeg");
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
    const stored = await conceptImages.addConceptImage(project.id, upload("image/png"), "reference");
    const onDisk = conceptImages.conceptImagePath(project.id, stored[0].name)!;
    expect(await fs.access(onDisk).then(() => true)).toBe(true);

    const left = await conceptImages.removeConceptImage(project.id, stored[0].name);
    expect(left).toEqual([]);
    expect(await fs.access(onDisk).then(() => true).catch(() => false)).toBe(false);
  });

  it("deleting the project takes the concept images with it", async () => {
    const { projects, conceptImages } = await isolated();
    const project = await draft(projects);
    const stored = await conceptImages.addConceptImage(project.id, upload("image/png"), "render");
    const onDisk = conceptImages.conceptImagePath(project.id, stored[0].name)!;

    await projects.deleteProject(project.id);
    expect(await fs.access(onDisk).then(() => true).catch(() => false)).toBe(false);
  });

  it("duplicating a project copies the image bytes, not just the names", async () => {
    const { projects, conceptImages } = await isolated();
    const project = await draft(projects);
    const stored = await conceptImages.addConceptImage(project.id, upload("image/png"), "reference");

    const copy = await projects.duplicateProject(project.id);
    expect(copy.conceptImages).toEqual(stored);
    // The folder is keyed by project id, so a name that carried over without
    // its bytes would leave the copy's thumbnails broken and silent.
    const files = await conceptImages.conceptImageFiles(copy.id, "reference");
    expect(files).toHaveLength(1);
    expect(files[0].path).toContain(copy.id);
  });

  it("importing a record clears the names, since no bytes travel in JSON", async () => {
    const { projects, conceptImages } = await isolated();
    const project = await draft(projects);
    await conceptImages.addConceptImage(project.id, upload("image/png"), "reference");
    const record = await projects.getProjectRecord(project.id);

    const outcome = await projects.importProject(JSON.parse(JSON.stringify(record)));
    expect(outcome.project.conceptImages).toBeUndefined();
    expect(await conceptImages.conceptImageFiles(outcome.project.id, "reference")).toEqual([]);
  });

  /**
   * The kinds are read by different agents for opposite purposes, so a lookup
   * that leaked across them would hand a render to the agent whose output the
   * pipeline consumes.
   */
  it("keeps the two kinds apart", async () => {
    const { projects, conceptImages } = await isolated();
    const project = await draft(projects);
    await conceptImages.addConceptImage(project.id, upload("image/png"), "reference");
    await conceptImages.addConceptImage(project.id, upload("image/png"), "render");
    await conceptImages.addConceptImage(project.id, upload("image/png"), "render");

    expect(await conceptImages.conceptImageFiles(project.id, "reference")).toHaveLength(1);
    expect(await conceptImages.conceptImageFiles(project.id, "render")).toHaveLength(2);
  });

  /**
   * Provenance was added after the first images were stored, and those were
   * renders. Reading a bare name as a reference would let exactly the frames
   * this split exists to quarantine back into the Visual Bible.
   */
  it("reads an entry stored before provenance existed as a render", async () => {
    const { projectSchema } = await import("@/lib/schemas/project");
    const parsed = projectSchema.partial().parse({ conceptImages: ["concept-0.png"] });
    expect(parsed.conceptImages).toEqual([{ name: "concept-0.png", kind: "render" }]);
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
    await conceptImages.addConceptImage(project.id, upload("image/png"), "reference");
    const files = await conceptImages.conceptImageFiles(project.id, "reference");

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

    const result = await conceptReaderAgent(
      project,
      files.map((file) => file.path),
      { generateJson } as never,
    );

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

  /**
   * Images are an optional addition to the written concept, never a
   * requirement. Reading none would still write a "visual reference" derived
   * from no visuals, which is a worse artefact than having none at all.
   */
  it("refuses to read a project that has no concept images", async () => {
    const { projects } = await isolated();
    const project = await draft(projects);

    await expect(projects.readConceptImages(project.id)).rejects.toThrow(
      /at least one reference image/i,
    );
  });

  it("leaves a project with no images completely unchanged", async () => {
    const { projects } = await isolated();
    const project = await draft(projects);
    const before = await projects.getProjectRecord(project.id);

    expect(before.project.conceptImages).toBeUndefined();
    expect(before.conceptVisuals).toBeUndefined();

    // The storyboard path must not require any of this to exist.
    const record = await projects.generateStoryboard(project.id);
    expect(record.storyboard?.scenes.length).toBeGreaterThan(0);
    expect(record.conceptVisuals).toBeUndefined();
  });

  /**
   * A render is not a reference. Reading one into `conceptVisuals` would let
   * the Visual Bible inherit whatever that frame failed to deliver, so the
   * reader must not see it however the project was uploaded.
   */
  it("never shows a render to the Concept Reader", async () => {
    const { projects, conceptImages } = await isolated({ OPENAI_VISION_MODEL: "qwen-vl" });
    const project = await draft(projects);
    await conceptImages.addConceptImage(project.id, upload("image/png"), "render");

    expect(await conceptImages.conceptImageFiles(project.id, "reference")).toEqual([]);
    await expect(projects.readConceptImages(project.id)).rejects.toThrow(
      /at least one reference image/i,
    );
  });
});

describe("concept fidelity check", () => {
  it("reports nothing looked at rather than nothing wrong when vision is off", async () => {
    delete process.env.OPENAI_VISION_MODEL;
    const { projects } = await isolated();
    const { conceptFidelityAgent } = await import("@/lib/agents/concept-fidelity");
    const project = await draft(projects);

    const generateJson = vi.fn();
    const report = await conceptFidelityAgent(project, ["/a.png"], { generateJson } as never);

    expect(generateJson).not.toHaveBeenCalled();
    // An empty findings list with no images examined must not read as a pass.
    expect(report.findings).toEqual([]);
    expect(report.images).toEqual([]);
  });

  it("labels the frames it examined and keeps the model's labels out of it", async () => {
    const { projects, conceptImages } = await isolated({ OPENAI_VISION_MODEL: "qwen-vl" });
    const { conceptFidelityAgent } = await import("@/lib/agents/concept-fidelity");
    const project = await draft(projects);
    await conceptImages.addConceptImage(project.id, upload("image/png"), "render");
    await conceptImages.addConceptImage(project.id, upload("image/png"), "render");
    const files = await conceptImages.conceptImageFiles(project.id, "render");

    const generateJson = vi.fn(async () => ({
      projectId: "invented",
      findings: [{ image: "Image 7", concept: "Four men", shows: "Three men" }],
      images: ["whatever the model felt like"],
      checkedAt: "not a date",
    }));

    const report = await conceptFidelityAgent(
      project,
      files.map((file) => file.path),
      { generateJson } as never,
    );

    expect(report.projectId).toBe(project.id);
    expect(report.images).toEqual(["Image 1", "Image 2"]);
    expect(report.findings).toHaveLength(1);
  });

  /**
   * The whole point of the split. A render's palette, wardrobe and mood record
   * what the pipeline settled for, so the report is given nowhere to put them.
   */
  it("has no descriptive fields that could reach a prompt", async () => {
    const { conceptFidelitySchema } = await import("@/lib/schemas/agents");
    const fields = Object.keys(conceptFidelitySchema.shape);
    for (const banned of ["palette", "wardrobe", "mood", "lighting", "setting", "subjects"]) {
      expect(fields).not.toContain(banned);
    }
  });

  it("refuses to check a project that has no rendered frames", async () => {
    const { projects, conceptImages } = await isolated();
    const project = await draft(projects);
    await conceptImages.addConceptImage(project.id, upload("image/png"), "reference");

    await expect(projects.checkConceptFidelity(project.id)).rejects.toThrow(/at least one render/i);
  });
});
