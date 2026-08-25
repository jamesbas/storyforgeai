import { describe, expect, it } from "vitest";

import { GET } from "@/app/api/projects/[projectId]/export/route";
import { exportFileName } from "@/lib/export/file-name";
import { createProject, generateStoryboard } from "@/lib/services/project-service";

/**
 * The route, not just the helper.
 *
 * The first cut of this shipped the helper and its unit tests while the route
 * still emitted `storyboard.json`, and everything passed — nothing exercised
 * the two together, so the feature was green and absent at the same time.
 */
async function exported(concept: string, format: string) {
  const project = await createProject({ concept, requestedDurationSeconds: 40 });
  await generateStoryboard(project.id);
  const res = await GET(
    new Request(`http://localhost/api/projects/${project.id}/export?format=${format}`),
    { params: Promise.resolve({ projectId: project.id }) },
  );
  return { title: project.title, disposition: res.headers.get("content-disposition") ?? "" };
}

describe("what an export is called when it leaves the server", () => {
  it("names a JSON export after the project it came from", async () => {
    const { title, disposition } = await exported("A robot paints the sunset from a cliff.", "json");
    expect(disposition).toContain(`filename="${exportFileName("storyboard", title, "json")}"`);
    expect(disposition).toContain("storyboard-A Robot Paints");
  });

  it("names a Markdown export after the project it came from", async () => {
    const { title, disposition } = await exported("A diver returns to a flooded town.", "md");
    expect(disposition).toContain(`filename="${exportFileName("storyboard", title, "md")}"`);
  });

  it("gives two different projects two different names", async () => {
    // The whole point: two exports must not collide in one folder.
    const first = await exported("A robot paints the sunset from a cliff.", "json");
    const second = await exported("A diver returns to a flooded town.", "json");
    expect(first.title).not.toBe(second.title);
    expect(first.disposition).not.toBe(second.disposition);
  });

  it("names the other export formats after the project too", async () => {
    const { title, disposition } = await exported("A courier crosses a frozen lake.", "manifest");
    expect(disposition).toContain(
      `filename="${exportFileName("generation-manifest", title, "json")}"`,
    );
  });
});
