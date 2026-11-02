/*
 * The built manifest describes the verbs in schemas the host can read.
 *
 * The manifest builder writes `{"type":"undefined"}` for a type it can't describe (an optional
 * boolean is one), and nothing else notices. This reads dist/manifest.json, so run
 * `npm run build` after changing a verb's signature.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url).pathname;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const manifest: Json = JSON.parse(readFileSync(join(root, "dist/manifest.json"), "utf8"));
const schemaTypes = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

/** Every `type` value in a schema, with the path it sits at. */
function typesIn(node: Json, at: string): { at: string; type: unknown }[] {
  if (Array.isArray(node)) return node.flatMap((item, i) => typesIn(item, `${at}[${i}]`));
  if (typeof node !== "object" || node === null) return [];
  const here = "type" in node && typeof node.type !== "object" ? [{ at, type: node.type }] : [];
  return [...here, ...Object.entries(node).flatMap(([k, v]) => typesIn(v, `${at}.${k}`))];
}

describe("dist/manifest.json", () => {
  it("uses only JSON Schema types", () => {
    const bad = manifest.entries.flatMap((e: Json) => [
      ...typesIn(e.inputSchema, `${e.namespace}.${e.name}.input`),
      ...typesIn(e.outputSchema, `${e.namespace}.${e.name}.output`),
    ]).filter((t: { type: unknown }) => !schemaTypes.has(t.type as string));
    expect(bad).toEqual([]);
  });

  it("advertises one array of names for the verbs that take a list", () => {
    const listVerbs = ["issue.addLabels", "issue.assign", "pull_request.addLabels", "pull_request.assign", "pull_request.requestReviewers"];
    for (const verb of listVerbs) {
      const entry = manifest.entries.find((e: Json) => `${e.namespace}.${e.name}` === verb);
      expect(entry?.inputSchema, verb).toEqual({ type: "array", items: { type: "string" } });
    }
  });
});
