import { z, type ZodType, type ZodTypeAny } from "zod";

/**
 * Render a compact, human-readable shape hint for a Zod schema.
 *
 * Agent system prompts say things like "return JSON matching the CreativeBrief
 * schema" — but the model has never seen that schema, so small local models
 * reliably return plausible JSON with the wrong keys. Appending the actual key
 * list fixes that: the same model that failed with `schema_mismatch` produced
 * conforming output once the keys were spelled out.
 *
 * Deliberately shallow and lossy. This is a prompt hint, not a specification —
 * validation still happens against the real schema.
 */
/**
 * How many levels of *object* nesting to describe. Arrays do not count — an
 * array is a container, not a nesting level, and charging it a level meant the
 * storyboard's `scenes[].dialogue[]` objects rendered as a bare "object". The
 * model then never learned the `character` / `line` keys and omitted them.
 */
const MAX_DEPTH = 4;

function unwrap(schema: ZodTypeAny): { inner: ZodTypeAny; optional: boolean } {
  let inner = schema;
  let optional = false;
  // Peel optional/nullable/default/effects wrappers to reach the core type.
  for (let i = 0; i < 10; i += 1) {
    const def = (inner as { _def?: { typeName?: string; innerType?: ZodTypeAny; schema?: ZodTypeAny } })._def;
    const typeName = def?.typeName;
    if (typeName === "ZodOptional" || typeName === "ZodNullable" || typeName === "ZodDefault") {
      optional = true;
      inner = def?.innerType ?? inner;
      continue;
    }
    if (typeName === "ZodEffects") {
      inner = def?.schema ?? inner;
      continue;
    }
    break;
  }
  return { inner, optional };
}

/**
 * Render a number's constraints. Observed failure: a model emitted
 * `trimAtEndSeconds: 0` for "no trim" against a `.positive().optional()` field,
 * because the hint only said "number". Stating the bound prevents that.
 */
function describeNumber(def: Record<string, unknown>): string {
  const checks = (def.checks as { kind?: string; value?: number; inclusive?: boolean }[]) ?? [];
  const parts: string[] = [];
  let integer = false;

  for (const check of checks) {
    if (check.kind === "int") integer = true;
    if (check.kind === "min" && typeof check.value === "number") {
      parts.push(check.inclusive === false ? `> ${check.value}` : `>= ${check.value}`);
    }
    if (check.kind === "max" && typeof check.value === "number") {
      parts.push(check.inclusive === false ? `< ${check.value}` : `<= ${check.value}`);
    }
  }

  const base = integer ? "integer" : "number";
  return parts.length ? `${base} ${parts.join(" and ")}` : base;
}

function describeType(schema: ZodTypeAny, depth: number): string {
  const { inner } = unwrap(schema);
  const def = (inner as { _def?: Record<string, unknown> })._def ?? {};
  const typeName = def.typeName as string | undefined;

  switch (typeName) {
    case "ZodString":
      return "string";
    case "ZodNumber":
      return describeNumber(def);
    case "ZodBoolean":
      return "boolean";
    case "ZodEnum": {
      const values = (def.values as string[] | undefined) ?? [];
      return values.length ? `one of ${values.map((v) => `"${v}"`).join("|")}` : "string";
    }
    case "ZodLiteral":
      return JSON.stringify(def.value);
    case "ZodArray": {
      const element = def.type as ZodTypeAny | undefined;
      // Same depth: the array itself is not a level of key nesting.
      return `array of ${element ? describeType(element, depth) : "value"}`;
    }
    case "ZodObject": {
      if (depth >= MAX_DEPTH) return "object";
      return `{ ${describeObject(inner as ZodTypeAny, depth + 1)} }`;
    }
    case "ZodRecord":
      return "object map";
    case "ZodUnion":
      return "value";
    default:
      return "value";
  }
}

function describeObject(schema: ZodTypeAny, depth: number): string {
  const shape = (schema as unknown as { shape?: Record<string, ZodTypeAny> }).shape;
  if (!shape) return "";
  return Object.entries(shape)
    .map(([key, value]) => {
      const { optional } = unwrap(value);
      return `${key}${optional ? "?" : ""}: ${describeType(value, depth)}`;
    })
    .join(", ");
}

/**
 * Returns a one-line shape hint, or null when the schema is not a plain object
 * (in which case there is nothing useful to tell the model).
 */
export function describeSchema<T>(schema: ZodType<T>): string | null {
  const { inner } = unwrap(schema as unknown as ZodTypeAny);
  if (!(inner instanceof z.ZodObject)) return null;
  const described = describeObject(inner as unknown as ZodTypeAny, 0);
  return described ? `{ ${described} }` : null;
}

/** Append the expected JSON shape to a system prompt. */
export function withSchemaHint<T>(system: string, schema: ZodType<T>): string {
  const shape = describeSchema(schema);
  if (!shape) return system;
  return (
    `${system}\n\n` +
    `Return a single JSON object with exactly this shape (keys marked ? are optional — ` +
    `omit them entirely rather than sending null or a placeholder value):\n${shape}\n` +
    `Respect every stated numeric bound. Do not wrap it in another object and do not add commentary.`
  );
}
