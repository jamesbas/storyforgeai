import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SceneCheckPanel } from "@/components/storyboard/scene-check-panel";
import { CheckedRerunNotice } from "@/components/storyboard/scene-check-tools";
import type { SceneChecksApi } from "@/components/storyboard/use-scene-checks";
import type { SceneCheck } from "@/lib/schemas/scene-check";
import type { Scene } from "@/lib/schemas/storyboard";

const check: SceneCheck = {
  depth: "quick",
  checkedAt: "2026-11-08T12:00:00.000Z",
  inputHash: "h1",
  mode: "text",
  coverage: "complete",
  findings: [{
    id: "rule:startFramePrompt:identity_missing:(Leroy)",
    code: "identity_missing",
    category: "identity",
    severity: "error",
    certainty: "likely",
    origin: "rule",
    field: "startFramePrompt",
    evidence: [{ source: "people:Leroy", excerpt: "dark espresso-brown skin" }],
    explanation: "This frame names Leroy without his skin tone.",
  }],
};

afterEach(() => vi.unstubAllGlobals());

function panel(overrides: Partial<Parameters<typeof SceneCheckPanel>[0]> = {}) {
  const props = {
    projectId: "p1",
    sceneId: "s1",
    checks: { quick: check },
    status: { quick: "issues" as const, deep: "not_checked" as const },
    onRun: vi.fn(),
    onAccept: vi.fn(),
    onApplied: vi.fn(),
    ...overrides,
  };
  render(<SceneCheckPanel {...props} />);
  return props;
}

describe("a scene's check panel", () => {
  it("shows the status of both depths and runs only when asked", () => {
    const props = panel();
    expect(screen.getByTestId("scene-check-badge-quick")).toHaveTextContent("Quick: Issues");
    expect(screen.getByTestId("scene-check-badge-deep")).toHaveTextContent("Deep: Not checked");
    expect(props.onRun).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("scene-check-run-deep"));
    expect(props.onRun).toHaveBeenCalledWith("deep");
  });

  it("shows each finding with the evidence it rests on, and can mark it intentional", () => {
    const props = panel();
    const finding = screen.getByTestId("scene-check-finding");
    expect(finding).toHaveTextContent("identity_missing");
    expect(finding).toHaveTextContent("dark espresso-brown skin");
    fireEvent.click(screen.getByText("Accept as intentional"));
    expect(props.onAccept).toHaveBeenCalledWith("quick", check.findings[0]!.id, true);
  });

  it("tells you a result is out of date instead of offering fixes against old text", () => {
    panel({ status: { quick: "out_of_date", deep: "not_checked" } });
    expect(screen.getByText(/has changed since this check/i)).toBeInTheDocument();
    expect(screen.queryByTestId("scene-check-preview-fix")).toBeNull();
  });

  it("previews a fix as a change, and applies it only when told to", async () => {
    const before = "Medium shot. Leroy, heavyset, kneels.";
    const after = "Medium shot. Leroy (a Black man with dark espresso-brown skin), heavyset, kneels.";
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
      new Response(JSON.stringify(init?.method === "PUT"
        ? { project: { id: "p1" } }
        : { kind: "prompt", field: "startFramePrompt", before, after, summary: "Stated his skin tone.",
            sourceHash: "abc", method: "rebuild", sceneId: "s1", findingId: check.findings[0]!.id, depth: "quick" }),
      { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const props = panel();

    fireEvent.click(screen.getByTestId("scene-check-preview-fix"));
    const preview = await screen.findByTestId("scene-check-fix-preview");
    expect(preview).toHaveTextContent("(a Black man with dark espresso-brown skin)");
    expect(props.onApplied).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Apply"));
    await waitFor(() => expect(props.onApplied).toHaveBeenCalled());
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT")!;
    expect(JSON.parse(String(put[1]!.body))).toEqual({
      kind: "prompt", field: "startFramePrompt", after, sourceHash: "abc",
    });
  });
});

describe("a checked rerun", () => {
  const scenes = [{ id: "s1", sceneNumber: 1 }, { id: "s2", sceneNumber: 2 }] as Scene[];
  const api = (followUp: NonNullable<NonNullable<SceneChecksApi["data"]>["progress"]["followUp"]>) =>
    ({ data: { checks: {}, status: {}, progress: { entries: [], active: false, remaining: 0, followUp } } }) as unknown as SceneChecksApi;

  it("lists the held scenes with their reason, and can render them anyway", () => {
    const onRenderAnyway = vi.fn();
    render(
      <CheckedRerunNotice
        scenes={scenes}
        onRenderAnyway={onRenderAnyway}
        checks={api({
          scope: "keyframes", depth: "quick", sceneIds: ["s1", "s2"], state: "queued", queued: 1,
          held: [{ sceneId: "s1", sceneNumber: 1, reason: "identity_missing: names Leroy without his skin tone." }],
        })}
      />,
    );
    const notice = screen.getByTestId("checked-rerun-notice");
    expect(notice).toHaveTextContent("1 scene queued for keyframes, 1 held back");
    expect(notice).toHaveTextContent("identity_missing");
    fireEvent.click(screen.getByText(/render the held scene anyway/i));
    expect(onRenderAnyway).toHaveBeenCalledWith("keyframes", ["s1"]);
  });
});
