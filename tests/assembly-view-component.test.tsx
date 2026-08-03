import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { AssemblyView } from "@/components/assembly/assembly-view";
import type { ProjectRecord } from "@/lib/schemas/storyboard";
import type { SceneAttempt } from "@/lib/schemas/generation";

function scene(number: number, title: string) {
  return {
    id: `p1-scene-00${number}`,
    sceneNumber: number,
    title,
    summary: "x",
    sceneObjective: "objective",
    visualDescription: "visual",
    cameraMovement: "static",
    targetDurationSeconds: 20,
    startTimeSeconds: (number - 1) * 20,
    endTimeSeconds: number * 20,
    transitionIn: "Cut",
    transitionOut: "Cut",
    status: "generated",
  };
}

function attempt(sceneId: string, approved: boolean): SceneAttempt {
  return {
    id: `${sceneId}-a1`,
    sceneId,
    attemptNumber: 1,
    videoPath: `${sceneId}.mp4`,
    settingsIds: [],
    approved,
    createdAt: new Date().toISOString(),
  };
}

function recordWith(approvals: boolean[]): ProjectRecord {
  const scenes = approvals.map((_, i) => scene(i + 1, `Beat ${i + 1}`));
  const attempts: Record<string, SceneAttempt[]> = {};
  scenes.forEach((s, i) => {
    attempts[s.id] = [attempt(s.id, approvals[i]!)];
  });
  return {
    project: {
      id: "p1",
      title: "Demo",
      concept: "x",
      requestedDurationSeconds: scenes.length * 20,
      segmentSeconds: 20,
      segmentCount: scenes.length,
      generatedDurationSeconds: scenes.length * 20,
      finalTrimSeconds: 0,
      aspectRatio: "16:9",
      resolutionPreset: "standard",
      style: "cinematic",
      tone: "calm",
      creativeMode: "film_short",
      narrationRequired: false,
      dialogueRequired: false,
      musicRequired: false,
      sfxRequired: false,
      generationMode: "video_segments",
      modelStrategy: "auto",
      status: "needs_review",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    storyboard: { projectId: "p1", scenes },
    attempts,
  } as unknown as ProjectRecord;
}

function stubFetch(record: ProjectRecord) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = url.endsWith("/exports")
        ? { exports: [] }
        : url.endsWith("/media")
          ? { media: [] }
          : record;
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    }),
  );
}

describe("AssemblyView approval gate", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("disables assembly and lists every scene still needing approval", async () => {
    stubFetch(recordWith([true, false, false]));
    render(<AssemblyView projectId="p1" />);

    await waitFor(() => expect(screen.getByTestId("approval-count")).toHaveTextContent(
      "1 of 3 scenes approved",
    ));
    expect(screen.getByTestId("assemble-button")).toBeDisabled();

    const missing = screen.getAllByTestId("missing-approval");
    expect(missing).toHaveLength(2);
    expect(missing[0]).toHaveTextContent(/Scene 2 — Beat 2/);
    expect(missing[1]).toHaveTextContent(/Scene 3 — Beat 3/);

    // The explanation is adjacent to the disabled action and announced politely.
    // Only the count is live: the list below names scenes, and a scene title is
    // model-authored content that a polite region would read aloud.
    const status = screen.getByTestId("approval-count");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(screen.getByTestId("assembly-readiness")).not.toHaveAttribute("aria-live");
    expect(screen.getByTestId("assemble-button")).toHaveAttribute(
      "aria-describedby",
      "assembly-readiness",
    );

    // Each missing scene links back to its storyboard card.
    const links = screen.getAllByRole("link", { name: /review scene/i });
    expect(links[0]).toHaveAttribute("href", "/storyboard/p1#scene-p1-scene-002");
    expect(links[1]).toHaveAttribute("href", "/storyboard/p1#scene-p1-scene-003");
  });

  it("explains the reason a generated but unreviewed scene blocks assembly", async () => {
    stubFetch(recordWith([false]));
    render(<AssemblyView projectId="p1" />);
    await waitFor(() =>
      expect(screen.getByTestId("missing-approval")).toHaveTextContent(/Awaiting approval/),
    );
  });

  it("enables assembly once every scene is approved", async () => {
    stubFetch(recordWith([true, true]));
    render(<AssemblyView projectId="p1" />);

    await waitFor(() => expect(screen.getByTestId("approval-count")).toHaveTextContent(
      "2 of 2 scenes approved",
    ));
    expect(screen.getByTestId("assemble-button")).toBeEnabled();
    expect(screen.queryAllByTestId("missing-approval")).toHaveLength(0);
  });
});
