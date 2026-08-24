import { describe, it, expect } from "vitest";
import { promptAuthorship, type ArtifactExecution } from "@/lib/schemas/provenance";
import { promptAuthorshipSentence } from "@/components/storyboard/prompt-authorship";

/**
 * The storyboard fallback notice claimed the per-scene prompts were unaffected.
 *
 * It reasoned from the mechanism — cards are one request, prompts are one
 * request per scene per pass — which is true in isolation and was false in the
 * run that exposed it: a 24-scene project fell back on its cards while 20 of
 * its 24 image prompts fell back too, because the same exhausted context lost
 * both. The counts were in `executions` the whole time.
 */

const scenes = (count: number) =>
  Array.from({ length: count }, (_, i) => `p-scene-${String(i + 1).padStart(3, "0")}`);

function execution(
  artifact: string,
  source: ArtifactExecution["source"],
): ArtifactExecution {
  return {
    executionId: `${artifact}-${source}`,
    artifact,
    scope: "scene",
    source,
    status: source === "llm" ? "ok" : "degraded",
    startedAt: "2026-08-23T21:00:00.000Z",
    finishedAt: "2026-08-23T21:00:01.000Z",
  } as ArtifactExecution;
}

/** The shape of the live failure: 4 image hybrids, 17 clean video prompts. */
function liveFailure() {
  const ids = scenes(24);
  const executions: ArtifactExecution[] = [];
  ids.forEach((id, index) => {
    executions.push(execution(`${id}.image_prompt`, index < 4 ? "hybrid" : "deterministic"));
    executions.push(execution(`${id}.video_prompt`, index < 17 ? "llm" : "deterministic"));
  });
  return { ids, executions };
}

describe("counting who wrote the per-scene prompts", () => {
  it("counts each source from the newest execution per scene", () => {
    const { ids, executions } = liveFailure();

    expect(promptAuthorship(executions, ids, "image_prompt")).toEqual({
      total: 24,
      llm: 0,
      hybrid: 4,
      deterministic: 20,
      unrecorded: 0,
    });
    expect(promptAuthorship(executions, ids, "video_prompt")).toEqual({
      total: 24,
      llm: 17,
      hybrid: 0,
      deterministic: 7,
      unrecorded: 0,
    });
  });

  /** A rerun appends; only the last word counts. */
  it("reads the newest record, not the first", () => {
    const ids = scenes(1);
    const executions = [
      execution(`${ids[0]}.image_prompt`, "deterministic"),
      execution(`${ids[0]}.image_prompt`, "llm"),
    ];

    expect(promptAuthorship(executions, ids, "image_prompt").llm).toBe(1);
  });

  it("counts a scene with no execution as unrecorded, not as a failure", () => {
    const ids = scenes(3);

    expect(promptAuthorship([], ids, "image_prompt")).toMatchObject({
      deterministic: 0,
      unrecorded: 3,
    });
  });
});

describe("what the fallback notice says", () => {
  it("reports the real counts rather than claiming the prompts are unaffected", () => {
    const { ids, executions } = liveFailure();
    const sentence = promptAuthorshipSentence(executions, ids);

    expect(sentence).toContain("4 of 24 image prompts");
    expect(sentence).toContain("17 of 24 video prompts");
    expect(sentence).not.toContain("unaffected");
  });

  it("says so plainly when every prompt was model-written", () => {
    const ids = scenes(5);
    const executions = ids.flatMap((id) => [
      execution(`${id}.image_prompt`, "llm"),
      execution(`${id}.video_prompt`, "llm"),
    ]);

    const sentence = promptAuthorshipSentence(executions, ids);
    expect(sentence).toContain("all 5 image and all 5 video prompts");
    expect(sentence).toContain("only the cards above are mechanical");
  });

  /** A gate repair is still the model's work, so it counts as written. */
  it("counts a repaired prompt as model-written", () => {
    const ids = scenes(2);
    const executions = ids.flatMap((id) => [
      execution(`${id}.image_prompt`, "hybrid"),
      execution(`${id}.video_prompt`, "llm"),
    ]);

    expect(promptAuthorshipSentence(executions, ids)).toContain("all 2 image and all 2 video");
  });

  it("claims nothing for a project written before provenance existed", () => {
    const sentence = promptAuthorshipSentence(undefined, scenes(6));

    expect(sentence).toContain("predates prompt provenance");
    expect(sentence).not.toContain("unaffected");
  });
});
