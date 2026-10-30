import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MAX_SYSTEM_PROMPT_CHARACTERS } from "@/lib/schemas/system-prompt-settings";

const dirs: string[] = [];
const SHARED_DATA_DIR = process.env.STORYFORGE_DATA_DIR;

async function isolated() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "storyforge-system-prompts-"));
  dirs.push(dir);
  process.env.STORYFORGE_DATA_DIR = dir;
  vi.resetModules();
  const service = await import("@/lib/services/system-prompt-settings-service");
  return { dir, service };
}

afterEach(async () => {
  if (SHARED_DATA_DIR) process.env.STORYFORGE_DATA_DIR = SHARED_DATA_DIR;
  else delete process.env.STORYFORGE_DATA_DIR;
  vi.resetModules();
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("app-wide system prompt settings", () => {
  it("starts disabled on a fresh install", async () => {
    const { service } = await isolated();
    const settings = await service.getSystemPromptSettings();

    expect(settings.agenticCanvas).toBeUndefined();
    expect(settings.storyboard).toBeUndefined();
    expect(settings.renderPrompts).toBeUndefined();
  });

  it("trims and round-trips every scope", async () => {
    const { service } = await isolated();
    await service.saveSystemPromptSettings({
      agenticCanvas: "  Favor visual causality.  ",
      storyboard: "  Record undressing as a wardrobe change.  ",
      renderPrompts: "  Keep render prompts concise.  ",
    });

    const settings = await service.getSystemPromptSettings();
    expect(settings.agenticCanvas).toBe("Favor visual causality.");
    expect(settings.storyboard).toBe("Record undressing as a wardrobe change.");
    expect(settings.renderPrompts).toBe("Keep render prompts concise.");
  });

  it("rejects a partial set without changing the saved value", async () => {
    const { service } = await isolated();
    const saved = { agenticCanvas: "Canvas A", storyboard: "Board A", renderPrompts: "Render A" };
    await service.saveSystemPromptSettings(saved);

    await expect(
      service.saveSystemPromptSettings({
        agenticCanvas: "Canvas B",
        storyboard: "Board B",
        renderPrompts: "",
      }),
    ).rejects.toThrow(/all three system prompts/i);
    expect(await service.getSystemPromptSettings()).toMatchObject(saved);
  });

  it("clears the policy when every value is empty", async () => {
    const { service } = await isolated();
    await service.saveSystemPromptSettings({
      agenticCanvas: "Canvas",
      storyboard: "Board",
      renderPrompts: "Render",
    });
    await service.saveSystemPromptSettings({
      agenticCanvas: "  ",
      storyboard: "",
      renderPrompts: " ",
    });

    const settings = await service.getSystemPromptSettings();
    expect(settings.agenticCanvas).toBeUndefined();
    expect(settings.storyboard).toBeUndefined();
    expect(settings.renderPrompts).toBeUndefined();
  });

  it("bounds each prompt", async () => {
    const { service } = await isolated();
    await expect(
      service.saveSystemPromptSettings({
        agenticCanvas: "x".repeat(MAX_SYSTEM_PROMPT_CHARACTERS + 1),
        storyboard: "Board",
        renderPrompts: "Render",
      }),
    ).rejects.toThrow();
  });

  it("falls back to disabled settings when the file is corrupt", async () => {
    const { dir, service } = await isolated();
    const library = path.join(dir, "library");
    await fs.mkdir(library, { recursive: true });
    await fs.writeFile(path.join(library, "system-prompt-settings.json"), "not json", "utf8");

    expect(await service.getSystemPromptSettings()).toMatchObject({ version: 1 });
    expect((await service.getSystemPromptSettings()).agenticCanvas).toBeUndefined();
  });

  it("leaves disabled and unscoped system prompts byte-for-byte unchanged", async () => {
    const { service } = await isolated();
    const { resolveSystemPrompt } = await import("@/lib/agents/llm/system-prompt");
    const builtIn = "You are the built-in agent.\nReturn JSON.";

    expect(await resolveSystemPrompt(builtIn, "agentic_canvas")).toBe(builtIn);
    await service.saveSystemPromptSettings({
      agenticCanvas: "Canvas",
      storyboard: "Board",
      renderPrompts: "Render",
    });
    expect(await resolveSystemPrompt(builtIn)).toBe(builtIn);
  });

  it("sends each scope only its own instructions", async () => {
    const { service } = await isolated();
    const { resolveSystemPrompt } = await import("@/lib/agents/llm/system-prompt");
    await service.saveSystemPromptSettings({
      agenticCanvas: "CANVAS_POLICY",
      storyboard: "CARD_POLICY",
      renderPrompts: "RENDER_POLICY",
    });

    const resolved = {
      agentic_canvas: await resolveSystemPrompt("BUILT IN", "agentic_canvas"),
      storyboard: await resolveSystemPrompt("BUILT IN", "storyboard"),
      render_prompts: await resolveSystemPrompt("BUILT IN", "render_prompts"),
    };

    expect(resolved.agentic_canvas).toContain("CANVAS_POLICY");
    expect(resolved.agentic_canvas).not.toContain("CARD_POLICY");
    expect(resolved.agentic_canvas).not.toContain("RENDER_POLICY");
    expect(resolved.storyboard).toContain("CARD_POLICY");
    expect(resolved.storyboard).not.toContain("RENDER_POLICY");
    expect(resolved.render_prompts).toContain("RENDER_POLICY");
    expect(resolved.render_prompts).not.toContain("CARD_POLICY");

    const canvas = resolved.agentic_canvas;
    expect(canvas.indexOf("CANVAS_POLICY")).toBeLessThan(canvas.indexOf("BUILT IN"));
    expect(canvas).toContain("MANDATORY STORYFORGEAI AGENT CONTRACT");
  });

  it("drops the obsolete appended-appearance instruction only for image requests", async () => {
    const { service } = await isolated();
    const { resolveSystemPrompt } = await import("@/lib/agents/llm/system-prompt");
    const legacy = "Do not restate a supplied character's appearance. It is appended automatically, " +
      "and describing someone twice renders them twice.";
    await service.saveSystemPromptSettings({
      agenticCanvas: "Canvas policy.", storyboard: "Storyboard policy.",
      renderPrompts: `Keep the original roles. ${legacy} Preserve the setting.`,
    });
    const resolved = await resolveSystemPrompt(
      "You are the Image Prompt Agent. Describe each character inline.", "render_prompts",
    );
    expect(resolved).not.toContain(legacy);
    expect(resolved).toContain("Keep the original roles.");
    expect(resolved).toContain("Preserve the setting.");
    expect(resolved).toContain("Describe each character inline.");
    expect((await service.getSystemPromptSettings()).renderPrompts).toContain(legacy);
    expect(await resolveSystemPrompt("You are the Video Prompt Agent.", "render_prompts")).toContain(legacy);
  });
});