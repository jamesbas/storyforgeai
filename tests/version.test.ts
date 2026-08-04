import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { APP_VERSION } from "@/lib/version";

/**
 * The footer version and the README's update log are one claim made in two
 * places. A release that bumps only one of them tells the user they are running
 * something they are not, which is worse than showing no version at all.
 */

const README = fs.readFileSync(path.join(process.cwd(), "README.md"), "utf8");

/** Version, date and summary of every row in the update log, newest first. */
function updateLog(): { version: string; date: string; summary: string }[] {
  const section = README.split("## Update log")[1]?.split("\n## ")[0] ?? "";
  return [...section.matchAll(/^\|\s*\*\*([\d.]+)\*\*\s*\|\s*([\d-]+)\s*\|(.+?)\|\s*$/gm)].map(
    (row) => ({ version: row[1]!, date: row[2]!, summary: row[3]!.trim() }),
  );
}

describe("the release shown in the footer", () => {
  it("matches the newest entry in the README update log", () => {
    expect(updateLog()[0]?.version).toBe(APP_VERSION);
  });

  it("keeps the log to the five most recent updates", () => {
    expect(updateLog().length).toBeGreaterThan(0);
    expect(updateLog().length).toBeLessThanOrEqual(5);
  });

  it("descends, in steps of one hundredth", () => {
    const versions = updateLog().map((row) => Math.round(Number(row.version) * 100));
    for (let i = 1; i < versions.length; i += 1) {
      expect(versions[i - 1]! - versions[i]!).toBe(1);
    }
  });

  it("says what changed, not just that something did", () => {
    for (const row of updateLog()) {
      expect(row.summary.length).toBeGreaterThan(40);
      expect(row.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
