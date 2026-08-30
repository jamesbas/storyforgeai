import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CollapsibleSection } from "@/components/shared/collapsible-section";

/**
 * jsdom does not implement the summary click that toggles a `<details>`, so the
 * open state is asserted through the attribute rather than by clicking. What the
 * browser does with it is native behaviour and not ours to test.
 */
describe("CollapsibleSection", () => {
  it("starts collapsed", () => {
    render(
      <CollapsibleSection testId="s" title="Character library">
        <p>Body</p>
      </CollapsibleSection>,
    );

    expect(screen.getByTestId("s")).not.toHaveAttribute("open");
  });

  it("opens when asked to", () => {
    render(
      <CollapsibleSection testId="s" title="Character library" defaultOpen>
        <p>Body</p>
      </CollapsibleSection>,
    );

    expect(screen.getByTestId("s")).toHaveAttribute("open");
  });

  /** A page of shut sections is still navigable if the headings survive. */
  it("keeps the title a heading inside the summary", () => {
    render(
      <CollapsibleSection testId="s" title="Character library" description="Reused across projects.">
        <p>Body</p>
      </CollapsibleSection>,
    );

    const heading = screen.getByRole("heading", { name: "Character library", level: 2 });
    expect(heading.closest("summary")).not.toBeNull();
    expect(screen.getByText("Reused across projects.").closest("summary")).not.toBeNull();
  });

  it("keeps the body out of the summary", () => {
    render(
      <CollapsibleSection testId="s" title="Character library">
        <p>Body</p>
      </CollapsibleSection>,
    );

    expect(screen.getByText("Body").closest("summary")).toBeNull();
  });
});
