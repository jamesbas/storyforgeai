import { describe, expect, it } from "vitest";

import { exportContentDisposition, exportFileName } from "@/lib/export/file-name";

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
