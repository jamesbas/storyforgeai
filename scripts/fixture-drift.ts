import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { LiveWangpClient } from "@/lib/wangp/live-client";

/**
 * Find test fixtures whose `defaultSettings` diverge from a live WanGP dump.
 *
 * The bug this exists for: `applyImagePromptType` skips when
 * `image_prompt_type !== undefined`. Live defaults carry it as `""` — defined,
 * so the guard returns — while the fixture omitted the key entirely, leaving it
 * genuinely undefined. Test and production took opposite branches, and the
 * suite proved nothing about the code that ships.
 *
 *   $env:WANGP_MCP_URL="http://100.71.40.31:7866/mcp"
 *   npx tsx scripts/fixture-drift.ts
 *
 * Output is a shortlist for review, not a verdict. A missing key only matters
 * where something reads it, so keys absent from `lib/` are dropped and the rest
 * are ranked by whether they appear in a conditional.
 */
const url = process.env.WANGP_MCP_URL ?? "http://127.0.0.1:7866/mcp";
const root = process.cwd();

type Fixture = {
  file: string;
  line: number;
  modelType: string | null;
  /** Property name to its literal value, or null where the value is an expression. */
  keys: Map<string, string | null>;
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

function propName(p: ts.ObjectLiteralElementLike): string | null {
  if (!ts.isPropertyAssignment(p)) return null;
  if (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) return p.name.text;
  return null;
}

/** JSON text for the literals a fixture realistically uses; null for anything else. */
function literalValue(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node)) return JSON.stringify(node.text);
  if (ts.isNumericLiteral(node)) return node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return "true";
  if (node.kind === ts.SyntaxKind.FalseKeyword) return "false";
  if (node.kind === ts.SyntaxKind.NullKeyword) return "null";
  if (ts.isArrayLiteralExpression(node) && node.elements.length === 0) return "[]";
  return null;
}

function collectFixtures(file: string): Fixture[] {
  const src = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const found: Fixture[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      propName(node) === "defaultSettings" &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      const keys = new Map<string, string | null>();
      for (const p of node.initializer.properties) {
        const name = propName(p);
        if (name && ts.isPropertyAssignment(p)) keys.set(name, literalValue(p.initializer));
      }

      // `modelType` sits beside defaultSettings on a WangpModelSchema; some
      // fixtures only carry `model_type` inside the settings themselves.
      let modelType: string | null = null;
      if (ts.isObjectLiteralExpression(node.parent)) {
        for (const p of node.parent.properties) {
          if (propName(p) === "modelType" && ts.isPropertyAssignment(p) && ts.isStringLiteral(p.initializer)) {
            modelType = p.initializer.text;
          }
        }
      }
      if (!modelType) {
        const inner = node.initializer.properties.find((p) => propName(p) === "model_type");
        if (inner && ts.isPropertyAssignment(inner) && ts.isStringLiteral(inner.initializer)) {
          modelType = inner.initializer.text;
        }
      }

      found.push({
        file: relative(root, file).replace(/\\/g, "/"),
        line: src.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        modelType,
        keys,
      });
    }
    ts.forEachChild(node, visit);
  };

  visit(src);
  return found;
}

const GUARD_TOKENS = ["undefined", "fieldNames.has", "in schema.defaultSettings", "??", "?.", "if ("];

/**
 * Values that always differ and never mean anything. `prompt` holds whatever
 * was last sent, not a default — comparing it reports drift on every run and
 * prints the operator's own render text back at them.
 */
const VALUE_NOISE = new Set([
  "prompt",
  "alt_prompt",
  "client_id",
  "output_filename",
  "type",
  "settings_version",
  "seed",
  "config",
]);

function short(value: string): string {
  return value.length > 60 ? `${value.slice(0, 57)}\u2026` : value;
}

type LibLine = { file: string; line: number; text: string };

function libLines(): LibLine[] {
  const out: LibLine[] = [];
  for (const file of sourceFiles(join(root, "lib"))) {
    const rel = relative(root, file).replace(/\\/g, "/");
    readFileSync(file, "utf8")
      .split(/\r?\n/)
      .forEach((text, i) => out.push({ file: rel, line: i + 1, text }));
  }
  return out;
}

function usage(key: string, lines: LibLine[]) {
  // Only a quoted key or a property access is a settings reference. A bare word
  // boundary matches `type` in an import and `mode` in prose, which is how the
  // first run of this script reported a dozen guards that do not exist.
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(["'\`])${escaped}\\1|\\.${escaped}\\b`);
  const hits = lines.filter((l) => pattern.test(l.text) && !l.text.trim().startsWith("*"));
  return {
    read: hits.length > 0,
    guarded: hits.some((l) => GUARD_TOKENS.some((t) => l.text.includes(t))),
    where: hits.slice(0, 2).map((l) => `${l.file}:${l.line}`),
  };
}

async function main() {
  const fixtures = sourceFiles(join(root, "tests")).flatMap(collectFixtures);
  const models = [...new Set(fixtures.map((f) => f.modelType).filter((m): m is string => Boolean(m)))];

  console.log(`Fixtures with defaultSettings: ${fixtures.length}`);
  console.log(`Model types named:             ${models.length}\n`);

  const client = new LiveWangpClient(url);
  const live = new Map<string, Record<string, unknown>>();
  for (const model of models) {
    try {
      live.set(model, (await client.getModelSchema(model)).defaultSettings);
    } catch (e) {
      console.log(`  ! ${model}: ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log("");

  const lines = libLines();
  let flagged = 0;

  for (const fixture of fixtures) {
    const defaults = fixture.modelType ? live.get(fixture.modelType) : undefined;
    if (!defaults) continue;

    const missing = Object.keys(defaults)
      .filter((key) => !fixture.keys.has(key))
      .map((key) => ({ key, ...usage(key, lines) }))
      .filter((u) => u.read)
      .sort((a, b) => Number(b.guarded) - Number(a.guarded));

    const drifted = [...fixture.keys.entries()].flatMap(([key, value]) => {
      if (value === null || VALUE_NOISE.has(key) || !(key in defaults)) return [];
      const liveValue = JSON.stringify(defaults[key]);
      return liveValue === value ? [] : [{ key, fixture: value, live: liveValue }];
    });

    if (!missing.length && !drifted.length) continue;
    flagged += 1;

    console.log(`${fixture.file}:${fixture.line}  (${fixture.modelType})`);

    const guarded = missing.filter((m) => m.guarded);
    const plain = missing.filter((m) => !m.guarded);

    if (guarded.length) {
      console.log(`  absent from fixture, and read inside a conditional in lib/:`);
      for (const m of guarded) console.log(`    ${m.key.padEnd(34)} ${m.where.join(", ")}`);
    }
    if (plain.length) {
      console.log(`  absent from fixture, read in lib/: ${plain.map((m) => m.key).join(", ")}`);
    }
    if (drifted.length) {
      console.log(`  value differs from live:`);
      for (const d of drifted) {
        console.log(`    ${d.key.padEnd(34)} fixture ${short(d.fixture)}  live ${short(d.live)}`);
      }
    }
    console.log("");
  }

  console.log(flagged ? `${flagged} fixture(s) to review.` : "No drift found.");
}

void main()
  .catch((e) => console.error("FAILED:", e instanceof Error ? e.message : e))
  .finally(() => process.exit(0));
