import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { APP_VERSION } from "@/lib/version";

/**
 * The footer version, the README's update log and the changelog are one claim
 * made in three places. A release that bumps only one of them tells the user
 * they are running something they are not, which is worse than showing no
 * version at all.
 */

const README = fs.readFileSync(path.join(process.cwd(), "README.md"), "utf8");
const CHANGELOG = fs.readFileSync(path.join(process.cwd(), "CHANGELOG.md"), "utf8");

/** Version, date and summary of every row in a log table, newest first. */
function rowsOf(markdown: string): { version: string; date: string; summary: string }[] {
  return [...markdown.matchAll(/^\|\s*\*\*([\d.]+)\*\*\s*\|\s*([\d-]+)\s*\|(.+?)\|\s*$/gm)].map(
    (row) => ({ version: row[1]!, date: row[2]!, summary: row[3]!.trim() }),
  );
}

function updateLog() {
  return rowsOf(README.split("## Update log")[1]?.split("\n## ")[0] ?? "");
}

const changelog = () => rowsOf(CHANGELOG);

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

/**
 * The README keeps five rows so it stays readable; the changelog keeps all of
 * them. Trimming the README is only safe if the row it drops has already been
 * written down somewhere permanent, so that is checked rather than trusted.
 */
describe("the changelog", () => {
  it("leads with the release the footer claims", () => {
    expect(changelog()[0]?.version).toBe(APP_VERSION);
  });

  it("runs unbroken back to the first release", () => {
    const versions = changelog().map((row) => Math.round(Number(row.version) * 100));
    expect(versions.at(-1)).toBe(100);
    for (let i = 1; i < versions.length; i += 1) {
      expect(versions[i - 1]! - versions[i]!).toBe(1);
    }
  });

  it("keeps every row the README has dropped, word for word", () => {
    const kept = new Map(changelog().map((row) => [row.version, row]));
    for (const row of updateLog()) {
      expect(kept.get(row.version)).toEqual(row);
    }
  });
});
