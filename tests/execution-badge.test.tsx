import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ExecutionBadge, describeExecution } from "@/components/shared/execution-badge";
import type { ArtifactExecution } from "@/lib/schemas/provenance";

function execution(overrides: Partial<ArtifactExecution> = {}): ArtifactExecution {
  return {
    executionId: "e1",
    artifact: "storyboard",
    source: "llm",
    status: "ok",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 10,
    ...overrides,
  };
}

/**
 * A creator cannot tell a model-written plan from a templated one by looking at
 * it, which is the whole reason provenance exists. The badge has to say so in
 * words: colour alone would carry none of it.
 */
describe("the provenance badge", () => {
  it("names the model on a clean LLM run", () => {
    render(<ExecutionBadge execution={execution({ model: "gemma4-26b" })} />);
    expect(screen.getByTestId("execution-badge")).toHaveTextContent("LLM · gemma4-26b");
  });

  it("says deterministic for demo mode without calling it a failure", () => {
    render(
      <ExecutionBadge
        execution={execution({
          source: "deterministic",
          status: "ok",
          fallbackReason: "provider_disabled",
        })}
      />,
    );
    const badge = screen.getByTestId("execution-badge");
    expect(badge).toHaveTextContent("Deterministic");
    expect(badge.textContent).not.toMatch(/could not|failed|wrong/i);
  });

  it("gives the reason when a run degraded", () => {
    render(
      <ExecutionBadge
        execution={execution({
          source: "deterministic",
          status: "degraded",
          fallbackReason: "schema_mismatch",
        })}
      />,
    );
    expect(screen.getByTestId("execution-badge")).toHaveTextContent(
      "the model's answer had the wrong shape",
    );
  });

  /**
   * A per-scene prompt is one call, so it has no `attempted` count. Gating the
   * hybrid branch on that field dropped every repaired prompt through to
   * "Deterministic" — telling a creator the model wrote none of a prompt it had
   * in fact written all of. Observed on a live project whose image prompts were
   * 13 llm and 24 hybrid, with not one deterministic among them.
   */
  it("still says hybrid when there is no per-item count to show", () => {
    render(
      <ExecutionBadge
        execution={execution({
          artifact: "scene-004.image_prompt",
          source: "hybrid",
          status: "degraded",
          fallbackReason: "invalid_set",
        })}
      />,
    );
    const badge = screen.getByTestId("execution-badge");
    expect(badge).toHaveTextContent("Hybrid");
    expect(badge).not.toHaveTextContent("Deterministic");
  });

  it("describes a failed check without calling one prompt a set", () => {
    expect(
      describeExecution(execution({ source: "hybrid", status: "degraded" })),
    ).toBe("Hybrid");
  });

  it("shows how much of a hybrid set came from the model", () => {
    render(
      <ExecutionBadge
        execution={execution({
          source: "hybrid",
          status: "degraded",
          fallbackReason: "invalid_set",
          attempted: { total: 3, fromLlm: 2 },
        })}
      />,
    );
    expect(screen.getByTestId("execution-badge")).toHaveTextContent("Hybrid · 2/3 from the model");
  });

  it("distinguishes visual QC from text-only QC", () => {
    expect(
      describeExecution(execution({ evidence: { mode: "visual", attachments: 2 } })),
    ).toBe("Visual QC · 2 frames");
    expect(
      describeExecution(execution({ evidence: { mode: "text_only", attachments: 0 } })),
    ).toBe("Text-only QC");
  });

  it("says a legacy project has no provenance, not that it was deterministic", () => {
    render(<ExecutionBadge execution={undefined} />);
    expect(screen.getByTestId("execution-badge")).toHaveTextContent(
      "No provenance (legacy project)",
    );
  });

  it("carries the meaning in text, not only in colour", () => {
    const { container } = render(
      <ExecutionBadge execution={execution({ source: "deterministic", status: "ok" })} />,
    );
    expect(container.textContent?.trim().length).toBeGreaterThan(0);
    expect(screen.getByTestId("execution-badge")).toHaveAttribute("title");
  });
});
