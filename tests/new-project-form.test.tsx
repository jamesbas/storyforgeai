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
});
