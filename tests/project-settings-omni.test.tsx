import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectSettings } from "@/components/settings/project-settings";
import type { ProjectRecord } from "@/lib/schemas/storyboard";
import type { WangpModel } from "@/lib/schemas/wangp";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("H3 Omni in project settings", () => {
  it.each(["minimax_h3_fasth3_omni", "minimax_h3_fasth3_omni_nvfp4"])(
    "enables reference controls when %s is selected from the model list",
    async (modelType) => {
      let record: ProjectRecord = {
        project: {
          id: "omni-project",
          title: "Mara at the window",
          concept: "Mara turns from the window.",
          requestedDurationSeconds: 40,
          segmentSeconds: 20,
          segmentCount: 2,
          generatedDurationSeconds: 40,
          finalTrimSeconds: 0,
          aspectRatio: "16:9",
          resolutionPreset: "draft",
          style: "Naturalistic",
          tone: "Quiet",
          creativeMode: "film_short",
          narrationRequired: false,
          dialogueRequired: false,
          musicRequired: false,
          sfxRequired: false,
          generationMode: "video_segments",
          modelStrategy: "auto",
          videoModel: "minimax_h3_fl2va",
          videoTier: "fl2va",
          useCharacterLibrary: true,
          characterIds: ["mara"],
          status: "draft",
          createdAt: "2026-10-25T00:00:00.000Z",
          updatedAt: "2026-10-25T00:00:00.000Z",
        },
      };
      const models: WangpModel[] = ["minimax_h3_fl2va", modelType].map((type) => ({
        modelType: type,
        name: type,
        metadata: {
          family: "minimax_h3",
          mainOutput: "video",
          inputs: ["text", "image"],
          availability: "available",
        },
      }));
      const response = (body: unknown) => new Response(JSON.stringify(body));
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/projects/omni-project") return response(record);
        if (url === "/api/projects/omni-project/models" && init?.method === "PATCH") {
          record = {
            ...record,
            project: { ...record.project, ...JSON.parse(String(init.body)) },
          };
          return response(record);
        }
        if (url === "/api/projects/omni-project/model-choice") {
          return response({
            status: { enabled: true, mode: "live", ok: true, url: "http://localhost/mcp" },
            image: null,
            video: null,
          });
        }
        if (url.startsWith("/api/wangp/models?")) {
          const video = url.includes("output=video");
          return response({
            models: video ? models : [],
            total: video ? models.length : 0,
            availabilityKnown: true,
          });
        }
        if (url.startsWith("/api/wangp/loras?")) {
          return response({ supported: false, modelType: "", reason: "No LoRAs in this test." });
        }
        if (url === "/api/characters") return response({ characters: [] });
        throw new Error(`Unexpected request: ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();
      render(<ProjectSettings projectId="omni-project" />);

      const picker = await screen.findByRole("combobox", { name: /Video model \(clips\)/ });
      await screen.findByRole("option", { name: new RegExp(modelType) });
      await user.selectOptions(picker, modelType);

      expect(await screen.findByRole("radio", { name: /^Reference mode/ })).toBeChecked();
      expect(screen.getByRole("radio", { name: /^Reference mode/ })).toBeEnabled();
      expect(screen.getByRole("radio", { name: /^First and last frame/ })).not.toBeChecked();
      expect(
        screen.getByRole("radio", { name: /^Send each character's photograph/ }),
      ).toBeChecked();
      expect(screen.getByRole("combobox", { name: /^Photographs sent per character/ })).toBeEnabled();
      expect(picker).toHaveValue(modelType);
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/projects/omni-project/models",
        expect.objectContaining({ method: "PATCH", body: JSON.stringify({ videoModel: modelType }) }),
      );
    },
  );
});
