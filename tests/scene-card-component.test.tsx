import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SceneCard } from "@/components/storyboard/scene-card";
import type { MediaDescriptor } from "@/lib/media/refs";
import type { SceneAttempt } from "@/lib/schemas/generation";
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

function attempt(overrides: Partial<SceneAttempt> = {}): SceneAttempt {
  return {
    id: "attempt-1",
    sceneId: scene.id,
    attemptNumber: 1,
    startImagePath: "start.png",
    endImagePath: "end.png",
    settingsIds: [],
    approved: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * The consequences of an import are the whole point of the control: the frame
 * no longer came from the seed, a full regeneration throws it away, and on a
 * carried-forward end frame it has already changed the next scene.
 */
describe("SceneCard imported frames", () => {
  it("offers the control only once there is an attempt to put a frame on", () => {
    const { rerender } = render(
      <SceneCard scene={scene} onGenerate={vi.fn()} onImportFrame={vi.fn()} />,
    );
    expect(screen.queryByTestId("import-frame")).toBeNull();

    rerender(
      <SceneCard
        scene={scene}
        attempt={attempt()}
        onGenerate={vi.fn()}
        onImportFrame={vi.fn()}
      />,
    );
    expect(screen.getByTestId("import-frame")).toBeInTheDocument();
  });

  it("stays quiet about consequences until something has been imported", () => {
    render(<SceneCard scene={scene} attempt={attempt()} onImportFrame={vi.fn()} />);
    expect(screen.queryByTestId("imported-frame-notes")).toBeNull();
    expect(screen.queryByTestId("imported-seed-note")).toBeNull();
  });

  it("warns that regenerating media discards the image, and that the seed does not describe it", () => {
    render(
      <SceneCard
        scene={scene}
        attempt={attempt({ startImageImported: true })}
        onImportFrame={vi.fn()}
        onNewSeed={vi.fn()}
        seed={42}
      />,
    );
    expect(screen.getByTestId("imported-frame-notes")).toHaveTextContent(
      /Regenerate media.*discard the imported image/i,
    );
    expect(screen.getByTestId("imported-frame-notes")).toHaveTextContent(
      /Regenerate video for selected scenes/i,
    );
    expect(screen.getByTestId("imported-seed-note")).toBeInTheDocument();
  });

  it("names the scene that went with it, and only when one actually did", () => {
    const { rerender } = render(
      <SceneCard
        scene={scene}
        attempt={attempt({ endImageImported: true })}
        onImportFrame={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("imported-frame-cascade")).toBeNull();

    rerender(
      <SceneCard
        scene={scene}
        attempt={attempt({ endImageImported: true })}
        onImportFrame={vi.fn()}
        endFrameCarriedToScene={2}
      />,
    );
    expect(screen.getByTestId("imported-frame-cascade")).toHaveTextContent(/Scene 2/);
  });

  it("hands the chosen file to the parent with the frame it belongs to", async () => {
    const onImportFrame = vi.fn();
    render(<SceneCard scene={scene} attempt={attempt()} onImportFrame={onImportFrame} />);

    const file = new File(["x"], "edited.png", { type: "image/png" });
    await userEvent.upload(screen.getByTestId("import-end_frame"), file);

    expect(onImportFrame).toHaveBeenCalledWith("end_frame", file);
  });
});
