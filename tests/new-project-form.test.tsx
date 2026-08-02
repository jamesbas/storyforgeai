import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NewProjectForm } from "@/components/intake/new-project-form";

describe("NewProjectForm", () => {
  it("renders the concept field and submit button", () => {
    render(<NewProjectForm onSubmit={vi.fn()} />);
    expect(screen.getByLabelText(/concept/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create storyboard/i })).toBeInTheDocument();
  });

  it("submits captured values", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<NewProjectForm onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText(/concept/i), "A robot paints a sunset.");
    await user.click(screen.getByRole("button", { name: /create storyboard/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const values = onSubmit.mock.calls[0]![0];
    expect(values.concept).toBe("A robot paints a sunset.");
    expect(values.requestedDurationSeconds).toBe(60);
    expect(values.aspectRatio).toBe("16:9");
  });

  it("disables the button while submitting", () => {
    render(<NewProjectForm onSubmit={vi.fn()} submitting />);
    expect(screen.getByRole("button", { name: /creating/i })).toBeDisabled();
  });

  /**
   * The upload route is keyed by project id, so reference images cannot be sent
   * until the project exists. The form stages them and hands them over.
   */
  it("stages reference images and passes them alongside the values", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<NewProjectForm onSubmit={onSubmit} />);

    const file = new File(["x"], "set.png", { type: "image/png" });
    await user.upload(screen.getByLabelText(/reference images/i), file);
    await user.type(screen.getByLabelText(/concept/i), "A robot paints a sunset.");
    await user.click(screen.getByRole("button", { name: /create storyboard/i }));

    const references = onSubmit.mock.calls[0]![1];
    expect(references).toHaveLength(1);
    expect(references[0].name).toBe("set.png");
  });

  it("passes an empty list when no references were chosen", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<NewProjectForm onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText(/concept/i), "A robot paints a sunset.");
    await user.click(screen.getByRole("button", { name: /create storyboard/i }));

    expect(onSubmit.mock.calls[0]![1]).toEqual([]);
  });
});
