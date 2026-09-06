import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OpeningFramePanel } from "@/components/storyboard/opening-frame-panel";

/**
 * Feedback for pinning the opening frame.
 *
 * The panel sits at the bottom of scene 1's card, which on a twenty-scene
 * storyboard is a long way from the page-level error line at the top. A refused
 * upload reported up there is a refusal nobody sees: the file picker resets
 * itself, nothing else changes, and the feature looks broken rather than picky.
 */

describe("the opening frame panel", () => {
  it("says what will happen to a mismatched shape, before anything is chosen", () => {
    render(<OpeningFramePanel aspectRatio="16:9" onPin={vi.fn()} />);
    expect(screen.getByText(/not 16:9 is centre-cropped/i)).toBeTruthy();
  });

  it("says nothing about shape when the project's ratio is custom", () => {
    render(<OpeningFramePanel aspectRatio="custom" onPin={vi.fn()} />);
    expect(screen.queryByText(/centre-cropped/i)).toBeNull();
  });

  it("shows the pinned image, so the crop can be judged before generating", () => {
    render(
      <OpeningFramePanel
        pinned={{ path: "/tmp/a.png", faceSwap: false }}
        previewUrl="/api/projects/p1/media/opening-frame"
        aspectRatio="16:9"
        cropped={{ from: { width: 1024, height: 1024 }, to: { width: 1024, height: 576 } }}
        onUnpin={vi.fn()}
      />,
    );

    expect(screen.getByTestId<HTMLImageElement>("opening-frame-preview").src).toContain(
      "/media/opening-frame",
    );
    expect(screen.getByTestId("opening-frame-cropped").textContent).toContain("1024");
  });

  it("shows a failure beside the control that caused it", () => {
    render(
      <OpeningFramePanel
        aspectRatio="16:9"
        error="That image could not be read. It may be corrupt."
        onPin={vi.fn()}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("could not be read");
  });

  it("reports the upload in progress and locks the picker while it runs", () => {
    render(<OpeningFramePanel aspectRatio="16:9" pending onPin={vi.fn()} />);
    expect(screen.getByTestId("opening-frame-pending")).toBeTruthy();
    expect(screen.getByTestId<HTMLInputElement>("pin-opening-frame").disabled).toBe(true);
  });

  it("passes the face-swap choice along with the file", async () => {
    const onPin = vi.fn();
    render(<OpeningFramePanel aspectRatio="16:9" onPin={onPin} />);

    await userEvent.click(screen.getByTestId("opening-frame-face-swap"));
    const file = new File(["x"], "opening.png", { type: "image/png" });
    await userEvent.upload(screen.getByTestId("pin-opening-frame"), file);

    expect(onPin).toHaveBeenCalledWith(file, true);
  });

  it("offers a release instead of a picker once a frame is pinned", () => {
    render(<OpeningFramePanel pinned={{ path: "/tmp/a.png", faceSwap: false }} onUnpin={vi.fn()} />);
    expect(screen.getByTestId("unpin-opening-frame")).toBeTruthy();
    expect(screen.queryByTestId("pin-opening-frame")).toBeNull();
    expect(screen.getByText(/used verbatim/i)).toBeTruthy();
  });
});
