import { describe, expect, it } from "vitest";

import { cutFileName, exportContentDisposition, exportFileName } from "@/lib/export/file-name";

/**
 * Naming an assembled cut.
 *
 * Every project's cut was `rough-cut.mp4`, and because the download header is
 * built from the file's own basename, that is what a browser saved too — so a
 * folder of finished pieces was a row of identical names.
 */
describe("naming an assembled cut", () => {
  const at = new Date(2026, 8, 22, 10, 5);

  it("carries the project and the moment it was cut", () => {
    expect(cutFileName("Swing Deep", "rough-cut", at)).toBe(
      "Swing Deep-2026-09-22-1005-rough-cut.mp4",
    );
  });

  /** Both cuts share a folder, so the kind cannot be left out of the name. */
  it("keeps the scored cut distinct from the unscored one", () => {
    expect(cutFileName("Swing Deep", "final-cut", at)).toBe(
      "Swing Deep-2026-09-22-1005-final-cut.mp4",
    );
    expect(cutFileName("Swing Deep", "final-cut", at)).not.toBe(
      cutFileName("Swing Deep", "rough-cut", at),
    );
  });

  it("still produces a usable name without a title", () => {
    expect(cutFileName(undefined, "rough-cut", at)).toBe("2026-09-22-1005-rough-cut.mp4");
    expect(cutFileName("   ", "rough-cut", at)).toBe("2026-09-22-1005-rough-cut.mp4");
  });

  it("pads a single-digit month, day and hour", () => {
    expect(cutFileName("P", "rough-cut", new Date(2026, 0, 3, 9, 7))).toBe(
      "P-2026-01-03-0907-rough-cut.mp4",
    );
  });

  /** The title reaches a filesystem and a response header; both are hostile. */
  it("removes characters a filesystem reserves", () => {
    const name = cutFileName('A/B\\C:D*E?F"G<H>I|J', "rough-cut", at);
    for (const bad of ["/", "\\", ":", "*", "?", '"', "<", ">", "|"]) {
      expect(name).not.toContain(bad);
    }
    expect(name.endsWith("-rough-cut.mp4")).toBe(true);
  });

  it("distinguishes two cuts of the same project made minutes apart", () => {
    expect(cutFileName("Swing Deep", "rough-cut", new Date(2026, 8, 22, 10, 5))).not.toBe(
      cutFileName("Swing Deep", "rough-cut", new Date(2026, 8, 22, 10, 6)),
    );
  });
});

describe("naming an exported file after its project", () => {
  it("puts the project title in the name", () => {
    expect(exportFileName("storyboard", "Swing Deep", "json")).toBe("storyboard-Swing Deep.json");
  });

  it("falls back to the bare name when there is no usable title", () => {
    // Every project exported as `storyboard.json` is why this exists, so an
    // empty title has to keep working rather than produce `storyboard-.json`.
    expect(exportFileName("storyboard", "   ", "json")).toBe("storyboard.json");
    expect(exportFileName("storyboard", undefined, "json")).toBe("storyboard.json");
  });

  it("removes characters a filesystem reserves", () => {
    const name = exportFileName("storyboard", 'A/B\\C:D*E?F"G<H>I|J', "md");
    expect(name).toMatch(/^storyboard-[\w ]+\.md$/);
    for (const bad of ["/", "\\", ":", "*", "?", '"', "<", ">", "|"]) {
      expect(name).not.toContain(bad);
    }
  });

  it("strips control characters rather than escaping them", () => {
    // The name goes into a response header. A newline in a title would end the
    // header and let whatever followed be read as another one.
    const name = exportFileName("storyboard", 'Room\r\nX-Evil: 1\u0000Service', "json");
    expect(name).not.toMatch(/[\r\n\u0000]/);
  });

  it("does not let a title end the quoted header value", () => {
    const header = exportContentDisposition("storyboard", 'Say "hi"', "json");
    expect(header.match(/"/g) ?? []).toHaveLength(2);
  });

  it("keeps the header ASCII and carries the real name alongside it", () => {
    // RFC 6266: `filename` must be ASCII, so a title with an em dash needs the
    // encoded form beside it or the browser sees mojibake.
    const header = exportContentDisposition("storyboard", "Café — Late", "json");
    expect(header).toMatch(/^[\x00-\x7f]*$/);
    expect(header).toContain("filename*=UTF-8''");
    expect(decodeURIComponent(header.split("filename*=UTF-8''")[1]!)).toContain("Café");
  });

  it("truncates a title long enough to break a filesystem", () => {
    const name = exportFileName("storyboard", "x".repeat(400), "json");
    expect(name.length).toBeLessThanOrEqual(120);
  });

  it("does not produce a name that is only dots", () => {
    // "." and ".." are directory entries, not files.
    expect(exportFileName("storyboard", "..", "json")).toBe("storyboard.json");
  });
});
