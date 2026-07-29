import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SceneCard } from "@/components/storyboard/scene-card";
import type { MediaDescriptor } from "@/lib/media/refs";
import type { Scene } from "@/lib/schemas/storyboard";

const scene = {
  id: "scene-1",
  sceneNumber: 1,
  title: "Arrival",
  summary: "x",
  targetDurationSeconds: 20,
  status: "planned",
  prompts: {
    startFramePrompt: "start",
    endFramePrompt: "end",
    videoPromptSegment: "video",
    videoNegativePrompt: "",
    imageNegativePrompt: "",
    promptQualityChecklist: [],
  },
} as unknown as Scene;

/**
 * The card reads a `preview` flag set server-side rather than parsing the asset
 * id: importing the ref codec into a client component drags `node:fs` into the
 * browser bundle and fails the production build.
 */
function previewDescriptor(): MediaDescriptor {
  return {
    assetId: "preview~scene-1~start_frame",
    sceneId: scene.id,
    kind: "image",
    label: "Scene 1 start frame preview",
    url: "/media/preview",
    downloadUrl: "/media/preview?download=1",
    available: true,
    role: "start_frame",
    preview: true,
  };
}

describe("SceneCard preview controls", () => {
  it("offers to remove previews when the scene has one", () => {
    render(
      <SceneCard
        scene={scene}
        media={[previewDescriptor()]}
        onGenerate={vi.fn()}
        onGenerateKeyframe={vi.fn()}
        onClearPreviews={vi.fn()}
      />,
    );
    expect(screen.getByTestId("clear-previews")).toBeInTheDocument();
  });

  it("hides the control when there is nothing to remove", () => {
    render(
      <SceneCard
        scene={scene}
        media={[]}
        onGenerate={vi.fn()}
        onGenerateKeyframe={vi.fn()}
        onClearPreviews={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("clear-previews")).toBeNull();
  });
});
